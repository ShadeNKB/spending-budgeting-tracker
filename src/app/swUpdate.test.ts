import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_CACHES,
  RELOAD_FALLBACK_MS,
  REMIND_AFTER_MS,
  SW_URL,
  UPDATE_CHECK_INTERVAL_MS,
  createUpdateController,
  type CacheStorageLike,
  type SwContainerLike,
  type SwDocumentLike,
  type SwRegistrationLike,
  type SwWorkerLike,
  type UpdateControllerDeps,
} from './swUpdate'

class FakeWorker extends EventTarget implements SwWorkerLike {
  state = 'installing'
  readonly messages: unknown[] = []
  postMessage(message: unknown): void {
    this.messages.push(message)
  }
  moveTo(state: string): void {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget implements SwRegistrationLike {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  active: FakeWorker | null = null
  updateCalls = 0
  updateResult: () => Promise<unknown> = () => Promise.resolve()
  update(): Promise<unknown> {
    this.updateCalls += 1
    return this.updateResult()
  }
  /** The browser found a new sw.js and starts installing it. */
  findUpdate(): FakeWorker {
    const worker = new FakeWorker()
    this.installing = worker
    this.dispatchEvent(new Event('updatefound'))
    return worker
  }
  /** The installing worker finished installing and now waits for the old one to let go. */
  finishInstall(worker: FakeWorker): void {
    this.installing = null
    this.waiting = worker
    worker.moveTo('installed')
  }
}

class FakeContainer extends EventTarget implements SwContainerLike {
  controller: object | null = null
  readonly registration = new FakeRegistration()
  readonly registerCalls: { url: string; scope: string | undefined }[] = []
  registerResult: () => Promise<SwRegistrationLike> = () => Promise.resolve(this.registration)
  register(url: string, options?: { scope?: string }): Promise<SwRegistrationLike> {
    this.registerCalls.push({ url, scope: options?.scope })
    return this.registerResult()
  }
  takeOver(controller: object): void {
    this.controller = controller
    this.dispatchEvent(new Event('controllerchange'))
  }
}

class FakeDocument extends EventTarget implements SwDocumentLike {
  readyState: DocumentReadyState = 'complete'
  visibilityState: DocumentVisibilityState = 'visible'
  show(): void {
    this.visibilityState = 'visible'
    this.dispatchEvent(new Event('visibilitychange'))
  }
  hide(): void {
    this.visibilityState = 'hidden'
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

class FakeCaches implements CacheStorageLike {
  readonly deleted: string[] = []
  deleteResult: () => Promise<boolean> = () => Promise.resolve(true)
  delete(name: string): Promise<boolean> {
    this.deleted.push(name)
    return this.deleteResult()
  }
}

const OLD_SW = { id: 'old' }
const NEW_SW = { id: 'new' }

function setup(overrides: Partial<UpdateControllerDeps> = {}) {
  const container = new FakeContainer()
  const win = new EventTarget()
  const doc = new FakeDocument()
  const caches = new FakeCaches()
  const reload = vi.fn()
  let online = true
  let unsaved = false
  const deps: UpdateControllerDeps = {
    container,
    win,
    doc,
    caches,
    now: () => Date.now(),
    reload,
    isOnline: () => online,
    hasUnsavedWork: () => unsaved,
    ...overrides,
  }
  const controller = createUpdateController(deps)
  return {
    controller,
    container,
    registration: container.registration,
    win,
    doc,
    caches,
    reload,
    setOnline: (v: boolean) => {
      online = v
    },
    setUnsaved: (v: boolean) => {
      unsaved = v
    },
  }
}

/** A page that is controlled by the old worker and has a new one waiting. */
async function readyPage(overrides: Partial<UpdateControllerDeps> = {}) {
  const page = setup(overrides)
  page.container.controller = OLD_SW
  page.registration.active = new FakeWorker()
  page.registration.waiting = new FakeWorker()
  page.controller.start()
  await flush()
  expect(page.controller.getSnapshot()).toBe('ready')
  return page
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 19, 9, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('registration', () => {
  it('registers /sw.js with scope / after window load', async () => {
    const { controller, container, win, doc } = setup()
    doc.readyState = 'interactive'
    controller.start()
    await flush()
    expect(container.registerCalls).toEqual([])

    win.dispatchEvent(new Event('load'))
    await flush()
    expect(SW_URL).toBe('/sw.js')
    expect(container.registerCalls).toEqual([{ url: '/sw.js', scope: '/' }])
  })

  it('registers right away when the page has already loaded, and only once', async () => {
    const { controller, container } = setup()
    controller.start()
    controller.start()
    await flush()
    expect(container.registerCalls).toHaveLength(1)
  })

  it('swallows a rejected registration silently', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { controller, container } = setup()
    container.registerResult = () => Promise.reject(new Error('Service workers are blocked'))
    controller.start()
    await flush()
    expect(controller.getSnapshot()).toBe('idle')
    expect(error).not.toHaveBeenCalled()
  })

  // WebKit with service workers blocked (Playwright) resolves register() with nothing usable,
  // so reading the registration throws. That must stay as quiet as a rejection: the shared
  // registration promise settles normally (a rejection would also leave the error screen's
  // Reload waiting 4 s, and surface as an unhandled rejection, which fails the run).
  it('swallows a registration it cannot read', async () => {
    class BrokenRegistration extends EventTarget implements SwRegistrationLike {
      readonly installing = null
      readonly active = null
      get waiting(): SwWorkerLike | null {
        throw new TypeError("undefined is not an object (evaluating 'w.waiting')")
      }
      update(): Promise<unknown> {
        return Promise.resolve()
      }
    }
    const { controller, container, doc, win, reload } = setup()
    container.registerResult = () => Promise.resolve(new BrokenRegistration())
    doc.readyState = 'interactive'
    controller.start()
    controller.reloadToLatest()
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
    win.dispatchEvent(new Event('load'))
    await flush()
    expect(controller.getSnapshot()).toBe('idle')
    vi.advanceTimersByTime(RELOAD_FALLBACK_MS)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('is a no-op where service workers are unavailable', async () => {
    const { controller, reload } = setup({ container: null })
    expect(() => {
      controller.start()
    }).not.toThrow()
    await flush()
    controller.apply()
    controller.confirmApply()
    expect(controller.getSnapshot()).toBe('idle')
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('detecting a new version', () => {
  it('is ready when a worker is already waiting next to the active one at start', async () => {
    await readyPage()
  })

  it('becomes ready when an update finishes installing on a controlled page', async () => {
    const { controller, container, registration } = setup()
    container.controller = OLD_SW
    registration.active = new FakeWorker()
    controller.start()
    await flush()
    expect(controller.getSnapshot()).toBe('idle')

    const worker = registration.findUpdate()
    expect(controller.getSnapshot()).toBe('idle')
    registration.finishInstall(worker)
    expect(controller.getSnapshot()).toBe('ready')
  })

  it('also tracks a worker that was already installing at registration time', async () => {
    const { controller, container, registration } = setup()
    container.controller = OLD_SW
    registration.active = new FakeWorker()
    const worker = new FakeWorker()
    registration.installing = worker
    controller.start()
    await flush()
    registration.finishInstall(worker)
    expect(controller.getSnapshot()).toBe('ready')
  })

  it('stays idle on a first install (no controller yet)', async () => {
    const { controller, container, registration } = setup()
    controller.start()
    await flush()
    const worker = registration.findUpdate()
    registration.finishInstall(worker)
    worker.moveTo('activated')
    // clientsClaim: the first worker claims the page; that is not an update.
    container.takeOver(NEW_SW)
    expect(controller.getSnapshot()).toBe('idle')
  })

  it('notifies subscribers on every change, and stops after unsubscribe', async () => {
    const { controller, container, registration } = setup()
    container.controller = OLD_SW
    registration.active = new FakeWorker()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    controller.start()
    await flush()
    registration.finishInstall(registration.findUpdate())
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    controller.dismiss()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('applying the update', () => {
  it('sends one SKIP_WAITING and reloads exactly once on controllerchange, even on a double tap', async () => {
    const { controller, container, registration, reload } = await readyPage()
    const waiting = registration.waiting
    controller.apply()
    controller.apply()
    expect(controller.getSnapshot()).toBe('reloading')
    expect(waiting?.messages).toEqual([{ type: 'SKIP_WAITING' }])
    expect(reload).not.toHaveBeenCalled()

    container.takeOver(NEW_SW)
    container.takeOver({ id: 'newer' })
    expect(reload).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(RELOAD_FALLBACK_MS * 2)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('falls back to a reload after 4 s when controllerchange never fires', async () => {
    const { controller, container, reload } = await readyPage()
    controller.apply()
    expect(RELOAD_FALLBACK_MS).toBe(4000)
    vi.advanceTimersByTime(RELOAD_FALLBACK_MS - 1)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
    container.takeOver(NEW_SW)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads directly when the waiting worker has gone', async () => {
    const { controller, registration, reload } = await readyPage()
    registration.waiting = null
    controller.apply()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('asks before reloading over unsaved work, and can go back to editing', async () => {
    const { controller, container, registration, reload, setUnsaved } = await readyPage()
    setUnsaved(true)
    controller.apply()
    expect(controller.getSnapshot()).toBe('confirm')
    expect(registration.waiting?.messages).toEqual([])

    controller.cancelConfirm()
    expect(controller.getSnapshot()).toBe('ready')

    controller.apply()
    expect(controller.getSnapshot()).toBe('confirm')
    controller.confirmApply()
    controller.confirmApply()
    expect(controller.getSnapshot()).toBe('reloading')
    expect(registration.waiting?.messages).toEqual([{ type: 'SKIP_WAITING' }])
    container.takeOver(NEW_SW)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('treats apply() while confirming as "reload anyway"', async () => {
    const { controller, registration, setUnsaved } = await readyPage()
    setUnsaved(true)
    controller.apply()
    controller.apply()
    expect(controller.getSnapshot()).toBe('reloading')
    expect(registration.waiting?.messages).toEqual([{ type: 'SKIP_WAITING' }])
  })

  it('ignores confirmApply and cancelConfirm outside the confirm step', async () => {
    const { controller, registration, reload } = await readyPage()
    controller.confirmApply()
    controller.cancelConfirm()
    expect(controller.getSnapshot()).toBe('ready')
    expect(registration.waiting?.messages).toEqual([])
    expect(reload).not.toHaveBeenCalled()
  })

  it('hides the banner on dismiss ("Later")', async () => {
    const { controller, reload, doc } = await readyPage()
    controller.dismiss()
    expect(controller.getSnapshot()).toBe('idle')
    controller.apply()
    expect(reload).not.toHaveBeenCalled()

    // Back in the foreground within 6 hours: still quiet.
    doc.hide()
    vi.setSystemTime(Date.now() + REMIND_AFTER_MS - 60_000)
    doc.show()
    expect(controller.getSnapshot()).toBe('idle')
  })

  it('asks again when the app comes back to the foreground 6 hours after "Later"', async () => {
    const { controller, doc } = await readyPage()
    expect(REMIND_AFTER_MS).toBe(6 * 60 * 60 * 1000)
    controller.dismiss()
    doc.hide()
    vi.setSystemTime(Date.now() + REMIND_AFTER_MS)
    doc.show()
    expect(controller.getSnapshot()).toBe('ready')
  })

  it('asks again straight away when a newer build installs after "Later"', async () => {
    const { controller, registration } = await readyPage()
    controller.dismiss()
    registration.finishInstall(registration.findUpdate())
    expect(controller.getSnapshot()).toBe('ready')
  })

  it('stays quiet after "Later" once the waiting build is gone (another tab took it)', async () => {
    const { controller, registration, doc } = await readyPage()
    controller.dismiss()
    registration.waiting = null
    doc.hide()
    vi.setSystemTime(Date.now() + REMIND_AFTER_MS)
    doc.show()
    expect(controller.getSnapshot()).toBe('idle')
  })
})

describe('updated in another tab', () => {
  it('shows updated-elsewhere when another tab activates the new worker', async () => {
    const { controller, container, reload } = await readyPage()
    container.takeOver(NEW_SW)
    expect(controller.getSnapshot()).toBe('updated-elsewhere')
    expect(reload).not.toHaveBeenCalled()

    controller.apply()
    expect(controller.getSnapshot()).toBe('reloading')
    expect(reload).toHaveBeenCalledTimes(1)
    controller.apply()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('shows updated-elsewhere even after the ready banner was dismissed', async () => {
    const { controller, container } = await readyPage()
    controller.dismiss()
    container.takeOver(NEW_SW)
    expect(controller.getSnapshot()).toBe('updated-elsewhere')
  })

  it('confirms before reloading over unsaved work', async () => {
    const { controller, container, reload, setUnsaved } = await readyPage()
    container.takeOver(NEW_SW)
    setUnsaved(true)
    controller.apply()
    expect(controller.getSnapshot()).toBe('confirm')
    controller.cancelConfirm()
    expect(controller.getSnapshot()).toBe('updated-elsewhere')
    controller.apply()
    controller.confirmApply()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

// The error screens' Reload and "Go to Pulse". A plain location.reload() keeps the old worker in
// charge while a new build waits, so a crash that the new build fixes would come straight back
// on every reload.
describe('reloadToLatest (error screens)', () => {
  it('installs a waiting build first: one SKIP_WAITING, one reload on controllerchange', async () => {
    const { controller, container, registration, reload } = await readyPage()
    const waiting = registration.waiting
    controller.reloadToLatest()
    controller.reloadToLatest()
    expect(waiting?.messages).toEqual([{ type: 'SKIP_WAITING' }])
    expect(controller.getSnapshot()).toBe('reloading')
    expect(reload).not.toHaveBeenCalled()

    container.takeOver(NEW_SW)
    expect(reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(RELOAD_FALLBACK_MS * 2)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never asks to confirm: the user chose to reload from an error screen', async () => {
    const { controller, registration, setUnsaved } = await readyPage()
    setUnsaved(true)
    controller.reloadToLatest()
    expect(controller.getSnapshot()).toBe('reloading')
    expect(registration.waiting?.messages).toEqual([{ type: 'SKIP_WAITING' }])
  })

  it('falls back to a reload after 4 s when the new worker never takes over', async () => {
    const { controller, reload } = await readyPage()
    controller.reloadToLatest()
    vi.advanceTimersByTime(RELOAD_FALLBACK_MS - 1)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ends somewhere else when asked ("Go to Pulse" after a shell crash)', async () => {
    const { controller, container, reload } = await readyPage()
    const goToPulse = vi.fn()
    controller.reloadToLatest(goToPulse)
    expect(goToPulse).not.toHaveBeenCalled()
    container.takeOver(NEW_SW)
    expect(goToPulse).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('also installs a build the user put off with "Later"', async () => {
    const { controller, registration } = await readyPage()
    controller.dismiss()
    controller.reloadToLatest()
    expect(registration.waiting?.messages).toEqual([{ type: 'SKIP_WAITING' }])
  })

  it('takes over from a banner that is asking to confirm', async () => {
    const { controller, registration, setUnsaved } = await readyPage()
    setUnsaved(true)
    controller.apply()
    expect(controller.getSnapshot()).toBe('confirm')
    controller.reloadToLatest()
    expect(controller.getSnapshot()).toBe('reloading')
    expect(registration.waiting?.messages).toEqual([{ type: 'SKIP_WAITING' }])
  })

  it('does nothing more while the banner is already installing the update', async () => {
    const { controller, container, registration, reload } = await readyPage()
    controller.apply()
    const goToPulse = vi.fn()
    controller.reloadToLatest(goToPulse)
    expect(registration.waiting?.messages).toEqual([{ type: 'SKIP_WAITING' }])
    container.takeOver(NEW_SW)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(goToPulse).not.toHaveBeenCalled()
  })

  it('just reloads, every time, when nothing is waiting', async () => {
    const { controller, container, registration, reload } = setup()
    container.controller = OLD_SW
    registration.active = new FakeWorker()
    controller.start()
    await flush()
    controller.reloadToLatest()
    controller.reloadToLatest()
    expect(reload).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toBe('idle')
  })

  it('just reloads after another tab installed the update', async () => {
    const { controller, container, registration, reload } = await readyPage()
    registration.waiting = null
    container.takeOver(NEW_SW)
    expect(controller.getSnapshot()).toBe('updated-elsewhere')
    controller.reloadToLatest()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('just reloads where the controller never started (dev server, no service worker)', () => {
    const { controller, reload } = setup()
    controller.reloadToLatest()
    expect(reload).toHaveBeenCalledTimes(1)

    const unsupported = setup({ container: null })
    const go = vi.fn()
    unsupported.controller.start()
    unsupported.controller.reloadToLatest(go)
    expect(go).toHaveBeenCalledTimes(1)
  })

  it('registers at once when tapped before the page finished loading, then installs', async () => {
    const { controller, container, registration, doc, win, reload } = setup()
    doc.readyState = 'interactive'
    container.controller = OLD_SW
    registration.active = new FakeWorker()
    const waiting = new FakeWorker()
    registration.waiting = waiting
    controller.start()
    expect(container.registerCalls).toEqual([])

    controller.reloadToLatest()
    expect(container.registerCalls).toEqual([{ url: '/sw.js', scope: '/' }])
    await flush()
    expect(waiting.messages).toEqual([{ type: 'SKIP_WAITING' }])

    // The load event later reuses that registration.
    win.dispatchEvent(new Event('load'))
    await flush()
    expect(container.registerCalls).toHaveLength(1)
    container.takeOver(NEW_SW)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads when registering fails', async () => {
    const { controller, container, doc, reload } = setup()
    doc.readyState = 'interactive'
    container.registerResult = () => Promise.reject(new Error('Service workers are blocked'))
    controller.start()
    controller.reloadToLatest()
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(RELOAD_FALLBACK_MS)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads after 4 s when registering never settles', async () => {
    const { controller, container, doc, reload } = setup()
    doc.readyState = 'interactive'
    container.registerResult = () => new Promise<SwRegistrationLike>(() => undefined)
    controller.start()
    controller.reloadToLatest()
    await flush()
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(RELOAD_FALLBACK_MS)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

// The old autoUpdate worker cached Google Fonts at runtime. The fonts are self-hosted now and
// that route is gone, but cleanupOutdatedCaches only removes old precaches, so installed apps
// would carry the orphaned (opaque, heavily padded) cache forever.
describe('legacy runtime caches', () => {
  it('deletes the old Google Fonts cache once the page has loaded', async () => {
    const { controller, caches, doc, win } = setup()
    expect(LEGACY_CACHES).toEqual(['google-fonts-cache'])
    doc.readyState = 'interactive'
    controller.start()
    await flush()
    expect(caches.deleted).toEqual([])
    win.dispatchEvent(new Event('load'))
    await flush()
    expect(caches.deleted).toEqual(['google-fonts-cache'])
  })

  it('runs once, swallows a failure, and survives a browser without CacheStorage', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const page = setup()
    page.caches.deleteResult = () => Promise.reject(new DOMException('denied', 'SecurityError'))
    page.controller.start()
    page.controller.start()
    await flush()
    expect(page.caches.deleted).toEqual(['google-fonts-cache'])
    expect(error).not.toHaveBeenCalled()

    const bare = setup({ caches: null })
    expect(() => {
      bare.controller.start()
    }).not.toThrow()
    await flush()
    expect(bare.container.registerCalls).toHaveLength(1)
  })

  it('survives CacheStorage throwing synchronously (some private modes)', async () => {
    const page = setup()
    vi.spyOn(page.caches, 'delete').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(() => {
      page.controller.start()
    }).not.toThrow()
    await flush()
    expect(page.container.registerCalls).toHaveLength(1)
  })

  it('builds the app-wide controller even where navigator.serviceWorker throws', async () => {
    vi.resetModules()
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    try {
      const { getUpdateController } = await import('./swUpdate')
      expect(() => getUpdateController().start()).not.toThrow()
      expect(getUpdateController().getSnapshot()).toBe('idle')
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'serviceWorker', descriptor)
      else Reflect.deleteProperty(navigator, 'serviceWorker')
    }
  })

  it('builds the app-wide controller even where reading window.caches throws', async () => {
    vi.resetModules()
    const descriptor = Object.getOwnPropertyDescriptor(window, 'caches')
    Object.defineProperty(window, 'caches', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    try {
      const { getUpdateController } = await import('./swUpdate')
      expect(() => getUpdateController().start()).not.toThrow()
      expect(getUpdateController().getSnapshot()).toBe('idle')
    } finally {
      if (descriptor) Object.defineProperty(window, 'caches', descriptor)
      else Reflect.deleteProperty(window, 'caches')
    }
  })
})

describe('update checks', () => {
  async function registeredPage() {
    const page = setup()
    page.container.controller = OLD_SW
    page.registration.active = new FakeWorker()
    page.controller.start()
    await flush()
    return page
  }

  it('checks on return to the foreground at most once per 60 minutes', async () => {
    const { registration, doc } = await registeredPage()
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000)

    doc.hide()
    vi.setSystemTime(Date.now() + 30 * 60 * 1000)
    doc.show()
    expect(registration.updateCalls).toBe(0)

    doc.hide()
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    doc.show()
    expect(registration.updateCalls).toBe(1)

    doc.hide()
    doc.show()
    expect(registration.updateCalls).toBe(1)
  })

  it('checks hourly while visible and skips ticks while hidden', async () => {
    const { registration, doc } = await registeredPage()
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(registration.updateCalls).toBe(1)

    doc.visibilityState = 'hidden'
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(registration.updateCalls).toBe(1)

    doc.show()
    expect(registration.updateCalls).toBe(2)
  })

  it('skips checks while offline', async () => {
    const { registration, doc, setOnline } = await registeredPage()
    setOnline(false)
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    expect(registration.updateCalls).toBe(0)

    setOnline(true)
    doc.hide()
    doc.show()
    expect(registration.updateCalls).toBe(1)
  })

  it('swallows a failed update check', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { registration } = await registeredPage()
    registration.updateResult = () =>
      Promise.reject(new TypeError('Failed to update a ServiceWorker'))
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS)
    await flush()
    expect(registration.updateCalls).toBe(1)
    expect(error).not.toHaveBeenCalled()
  })

  it('checks again if the clock moved backwards', async () => {
    const { registration, doc } = await registeredPage()
    vi.setSystemTime(Date.now() - 24 * 60 * 60 * 1000)
    doc.hide()
    doc.show()
    expect(registration.updateCalls).toBe(1)
  })

  // Sync found the relay moved to a newer version: a new build is out, so look for it now
  // rather than within the hour, and let it wait for the Reload that runs it.
  it('checkNow checks at once, past the hourly schedule, and the build it finds waits', async () => {
    const { controller, registration, doc } = await registeredPage()
    controller.checkNow()
    expect(registration.updateCalls).toBe(1)
    const worker = registration.findUpdate()
    registration.finishInstall(worker)
    expect(controller.getSnapshot()).toBe('ready')
    // The hourly schedule restarts from that check.
    doc.hide()
    vi.setSystemTime(Date.now() + 30 * 60 * 1000)
    doc.show()
    expect(registration.updateCalls).toBe(1)
  })

  it('checkNow does nothing offline, before registration, or without service workers', async () => {
    const page = setup()
    page.controller.checkNow() // not started: the page load itself has just checked
    expect(page.registration.updateCalls).toBe(0)
    const { controller, registration, setOnline } = await registeredPage()
    setOnline(false)
    controller.checkNow()
    expect(registration.updateCalls).toBe(0)
    expect(() => setup({ container: null }).controller.checkNow()).not.toThrow()
  })

  it('checkNow swallows a failed check', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { controller, registration } = await registeredPage()
    registration.updateResult = () => Promise.reject(new TypeError('offline'))
    controller.checkNow()
    await flush()
    expect(error).not.toHaveBeenCalled()
  })
})
