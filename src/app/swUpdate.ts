// Service-worker update controller (hand-rolled, about 1 KB).
//
// The service worker is prompt-style: a new build installs and then waits, so the old worker
// keeps serving the old build's chunks to pages that are already open. This controller
// notices the waiting worker, lets the banner ask the user, and only on their tap tells the
// worker to take over and reloads once. It never reloads on its own.
//
// States
//   idle               nothing to show (also after "Later", until a newer build installs or
//                      the app comes back to the foreground 6 hours later)
//   ready              a new build is waiting
//   confirm            the user tapped Reload with typed text or an open sheet
//   reloading          SKIP_WAITING sent; reload on controllerchange or after 4 s
//   updated-elsewhere  another tab accepted the update; this page runs on the old build

import { hasUnsavedWork } from '../lib/unsavedWork'
import { reloadPage } from '../lib/chunkReload'

export const SW_URL = '/sw.js'
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
export const RELOAD_FALLBACK_MS = 4000
/**
 * After "Later", the banner comes back when the app returns to the foreground this long
 * afterwards. An installed iPhone app is resumed, not reloaded, for days at a time, so a
 * page-lifetime "Later" could leave it on the old build indefinitely.
 */
export const REMIND_AFTER_MS = 6 * 60 * 60 * 1000
/**
 * Runtime caches earlier builds created and no build uses any more. cleanupOutdatedCaches
 * only removes old precaches, so these are deleted here (Google Fonts, before self-hosting).
 */
export const LEGACY_CACHES = ['google-fonts-cache']

export type UpdateState = 'idle' | 'ready' | 'confirm' | 'reloading' | 'updated-elsewhere'

export interface SwWorkerLike extends EventTarget {
  readonly state: string
  postMessage(message: unknown): void
}

export interface SwRegistrationLike extends EventTarget {
  readonly installing: SwWorkerLike | null
  readonly waiting: SwWorkerLike | null
  readonly active: SwWorkerLike | null
  update(): Promise<unknown>
}

export interface SwContainerLike extends EventTarget {
  readonly controller: object | null
  register(url: string, options?: { scope?: string }): Promise<SwRegistrationLike>
}

export interface SwDocumentLike extends EventTarget {
  readonly readyState: DocumentReadyState
  readonly visibilityState: DocumentVisibilityState
}

export type CacheStorageLike = Pick<CacheStorage, 'delete'>

export interface UpdateControllerDeps {
  /** `navigator.serviceWorker`, or null where service workers are unavailable. */
  container: SwContainerLike | null
  win: EventTarget
  doc: SwDocumentLike
  /** `window.caches`, or null where CacheStorage is unavailable. */
  caches: CacheStorageLike | null
  now: () => number
  reload: () => void
  isOnline: () => boolean
  hasUnsavedWork: () => boolean
}

export interface UpdateController {
  start(): void
  // Properties, not methods: React calls these detached (useSyncExternalStore).
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => UpdateState
  /** The banner's Reload. Asks first when there is unsaved work. */
  apply(): void
  /** "Reload anyway". */
  confirmApply(): void
  /** "Keep editing". */
  cancelConfirm(): void
  /** "Later": hide the ready banner until a newer build installs or REMIND_AFTER_MS passes. */
  dismiss(): void
  /**
   * The error screens' Reload (and, with `go`, "Go to Pulse" after a shell crash). A build that
   * is already waiting is installed first, without a confirm step, so a crash that the new
   * build fixes does not come back on the reload. `go` runs once the new build is in charge,
   * or straight away when nothing is waiting. Defaults to a reload.
   */
  reloadToLatest(go?: () => void): void
  /**
   * Looks for a new build now, whatever the hourly schedule says: sync found the relay moved
   * to a newer version, so one is out. A build it finds installs and waits as usual, so the
   * next Reload (the banner's, or `reloadToLatest`) runs it.
   */
  checkNow(): void
}

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const { container, win, doc, now, reload, isOnline } = deps
  const listeners = new Set<() => void>()

  let state: UpdateState = 'idle'
  // The state to return to when the user backs out of the confirm step.
  let pending: 'ready' | 'updated-elsewhere' = 'ready'
  let started = false
  let dismissed = false
  let dismissedAt = 0
  let registering: Promise<SwRegistrationLike | null> | null = null
  let registration: SwRegistrationLike | null = null
  let hadController = false
  let skipWaitingSent = false
  // What to do once the new build is in charge, and whether it has been done.
  let afterTakeOver = reload
  let finished = false
  let lastCheckAt = 0

  const setState = (next: UpdateState) => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }

  const finish = () => {
    if (finished) return
    finished = true
    afterTakeOver()
  }

  /** Tells the waiting build to take over, then finishes on controllerchange or after 4 s. */
  const takeOver = (waiting: SwWorkerLike, then: () => void) => {
    setState('reloading')
    afterTakeOver = then
    skipWaitingSent = true
    waiting.postMessage({ type: 'SKIP_WAITING' })
    setTimeout(finish, RELOAD_FALLBACK_MS)
  }

  const markReady = () => {
    if (state === 'idle' && !dismissed) {
      pending = 'ready'
      setState('ready')
    }
  }

  const watchInstalling = (worker: SwWorkerLike) => {
    const onStateChange = () => {
      if (worker.state !== 'installed') return
      worker.removeEventListener('statechange', onStateChange)
      // With no controller this is the first install, not an update. A build that installs
      // after "Later" is newer than the one the user put off, so it asks again.
      if (!container?.controller) return
      dismissed = false
      markReady()
    }
    worker.addEventListener('statechange', onStateChange)
  }

  const update = (reg: SwRegistrationLike) => {
    lastCheckAt = now()
    reg.update().catch(() => undefined)
  }

  const checkForUpdate = () => {
    if (!registration || doc.visibilityState !== 'visible' || !isOnline()) return
    const elapsed = now() - lastCheckAt
    if (elapsed >= 0 && elapsed < UPDATE_CHECK_INTERVAL_MS) return
    update(registration)
  }

  const onControllerChange = () => {
    const previous = hadController
    hadController = Boolean(container?.controller)
    if (skipWaitingSent) {
      finish()
      return
    }
    if (previous && state !== 'reloading') {
      pending = 'updated-elsewhere'
      setState('updated-elsewhere')
    }
  }

  const remindAfterLater = () => {
    if (!dismissed || !registration?.waiting) return
    const elapsed = now() - dismissedAt
    if (elapsed >= 0 && elapsed < REMIND_AFTER_MS) return
    dismissed = false
    markReady()
  }

  const onRegistered = (reg: SwRegistrationLike) => {
    // Read it before keeping it: WebKit with service workers blocked resolves register() with
    // nothing usable, and this throws into register()'s catch instead of failing later.
    const { waiting, active, installing } = reg
    registration = reg
    lastCheckAt = now()
    if (waiting && active) markReady()
    if (installing) watchInstalling(installing)
    reg.addEventListener('updatefound', () => {
      if (reg.installing) watchInstalling(reg.installing)
    })
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState !== 'visible') return
      remindAfterLater()
      checkForUpdate()
    })
    setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS)
  }

  /** Registers once, on load or earlier when an error screen needs the waiting build. */
  const register = (): Promise<SwRegistrationLike | null> => {
    if (!container) return Promise.resolve(null)
    registering ??= container
      .register(SW_URL, { scope: '/' })
      .then((reg) => {
        onRegistered(reg)
        return reg
      })
      // Blocked, unsupported or unreadable (private modes, Playwright, the dev server): stay
      // quiet. It never rejects, so nothing waiting on it can raise an unhandled rejection.
      .catch(() => null)
    return registering
  }

  const deleteLegacyCaches = () => {
    for (const name of LEGACY_CACHES) {
      try {
        deps.caches?.delete(name).catch(() => undefined)
      } catch {
        // CacheStorage unavailable (some private modes throw outright): nothing to clean.
      }
    }
  }

  const afterLoad = () => {
    void register()
    deleteLegacyCaches()
  }

  const proceed = () => {
    const waiting = registration?.waiting
    if (pending === 'updated-elsewhere' || !waiting) {
      setState('reloading')
      finish()
      return
    }
    takeOver(waiting, reload)
  }

  return {
    start() {
      if (started || !container) return
      started = true
      hadController = Boolean(container.controller)
      container.addEventListener('controllerchange', onControllerChange)
      if (doc.readyState === 'complete') afterLoad()
      else win.addEventListener('load', afterLoad, { once: true })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    apply() {
      if (state === 'confirm') {
        proceed()
        return
      }
      if (state !== 'ready' && state !== 'updated-elsewhere') return
      pending = state
      if (deps.hasUnsavedWork()) setState('confirm')
      else proceed()
    },
    confirmApply() {
      if (state === 'confirm') proceed()
    },
    cancelConfirm() {
      if (state === 'confirm') setState(pending)
    },
    dismiss() {
      dismissed = true
      dismissedAt = now()
      if (state === 'ready') setState('idle')
    },
    reloadToLatest(go = reload) {
      if (!started) {
        go()
        return
      }
      let settled = false
      const settle = () => {
        if (settled || state === 'reloading') return
        settled = true
        const waiting = registration?.waiting
        if (waiting) takeOver(waiting, go)
        else go()
      }
      if (registration) {
        settle()
        return
      }
      // Tapped before the page finished loading: register now rather than wait for load.
      void register().then(settle)
      setTimeout(settle, RELOAD_FALLBACK_MS)
    },
    checkNow() {
      // Before registration the page load itself has just checked.
      if (registration && isOnline()) update(registration)
    },
  }
}

let singleton: UpdateController | null = null

/**
 * A browser API that may be missing, or throw when read (some private modes). The app must
 * still boot: main.tsx builds this controller before React renders.
 */
function optional<T>(read: () => T | undefined): T | null {
  try {
    return read() ?? null
  } catch {
    return null
  }
}

/** The app-wide controller. `start()` is called from main.tsx in production builds only. */
export function getUpdateController(): UpdateController {
  singleton ??= createUpdateController({
    container: optional(() => navigator.serviceWorker),
    win: window,
    doc: document,
    caches: optional(() => window.caches),
    now: Date.now,
    reload: reloadPage,
    isOnline: () => navigator.onLine,
    hasUnsavedWork: () => hasUnsavedWork(),
  })
  return singleton
}
