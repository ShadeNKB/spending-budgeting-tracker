// One-shot recovery from stale lazy chunks.
//
// After a deploy, a page that is still running the previous build can ask for a chunk the
// server no longer has. A single reload fetches the new build and fixes it. A sessionStorage
// timestamp limits that to one automatic reload per minute, so a chunk that keeps failing
// (offline, a broken deploy) shows the error screen instead of looping.

import { hasUnsavedWork } from './unsavedWork'

export const CHUNK_RELOAD_KEY = 'spendtrack:chunk-reload-at'
export const CHUNK_RELOAD_WINDOW_MS = 60_000

// Chromium, Firefox, WebKit (incl. the HTML-instead-of-JS MIME error), Vite's CSS preload,
// and webpack-style chunk errors from any future bundler change.
const CHUNK_ERROR_MESSAGE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|is not a valid JavaScript MIME type|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed/i

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'ChunkLoadError' || CHUNK_ERROR_MESSAGE.test(error.message)
}

export function reloadPage(): void {
  window.location.reload()
}

/** A fresh document load of `path`, for when the app itself may be what broke. */
export function openPage(path: string): void {
  window.location.assign(path)
}

export interface ChunkReloadDeps {
  getStorage?: () => Pick<Storage, 'getItem' | 'setItem'>
  isOnline?: () => boolean
  hasUnsavedWork?: () => boolean
  now?: () => number
  reload?: () => void
}

/** A guard written less than a minute before `at`. Garbage or a future time (clock moved back) is not. */
function isRecent(stored: string | null, at: number): boolean {
  const last = Number(stored)
  const elapsed = at - last
  return last > 0 && elapsed >= 0 && elapsed < CHUNK_RELOAD_WINDOW_MS
}

// Set once this page has asked for a reload, so later failures join it instead of
// starting another one.
let reloadStarted = false
// Set while the page is being left. Leaving cancels the chunk loads still in flight (WebKit
// does it as soon as the navigation starts), and a reload then would hijack that navigation.
let leaving = false

/** True when a reload has started, now or earlier in this page. */
export function tryChunkReload(deps: ChunkReloadDeps = {}): boolean {
  if (reloadStarted) return true
  const {
    getStorage = () => window.sessionStorage,
    isOnline = () => navigator.onLine,
    hasUnsavedWork: unsaved = () => hasUnsavedWork(),
    now = Date.now,
    reload = reloadPage,
  } = deps

  // Offline, a reload would land on the browser's offline page; with typed text it would
  // throw the text away. The error screen offers a manual reload instead.
  if (leaving || !isOnline() || unsaved()) return false

  const at = now()
  try {
    const storage = getStorage()
    if (isRecent(storage.getItem(CHUNK_RELOAD_KEY), at)) return false
    storage.setItem(CHUNK_RELOAD_KEY, String(at))
    // Without a working guard there is no loop protection, so no automatic reload.
    if (storage.getItem(CHUNK_RELOAD_KEY) !== String(at)) return false
  } catch {
    return false
  }

  reloadStarted = true
  reload()
  return true
}

/**
 * True when this tab reloaded automatically for a failed chunk less than a minute ago, so the
 * failure now on screen survived that reload. WebKit keeps a module URL that failed failed
 * for the life of the tab, so only closing the app fully clears it there.
 */
export function reloadedRecently(deps: Pick<ChunkReloadDeps, 'getStorage' | 'now'> = {}): boolean {
  const { getStorage = () => window.sessionStorage, now = Date.now } = deps
  try {
    return isRecent(getStorage().getItem(CHUNK_RELOAD_KEY), now())
  } catch {
    return false
  }
}

/** Settles never: Suspense keeps its fallback until the reload unloads the page. */
function untilReload<T>(): Promise<T> {
  return new Promise<T>(() => undefined)
}

/**
 * Wraps a dynamic import for React.lazy. On a stale-chunk failure that triggers a reload the
 * promise never settles, so Suspense keeps showing its fallback until the page unloads.
 * Anything else is rethrown for the nearest error boundary.
 */
export function importWithReload<T>(load: () => Promise<T>, deps?: ChunkReloadDeps): Promise<T> {
  return load().catch((error: unknown) => {
    if (isChunkLoadError(error) && tryChunkReload(deps)) return untilReload<T>()
    throw error
  })
}

/**
 * Vite fires `vite:preloadError` when a lazy chunk, or a CSS file it needs, fails to load.
 * The listener only starts the one reload, so an import that is not wrapped in
 * importWithReload recovers too; a module that throws while it runs is a bug, not a stale
 * deploy, and is left alone. It never calls preventDefault: Vite would then resolve the
 * failed import with `undefined`, and code reading the module (`m.Screen`) would crash with a
 * TypeError instead of the chunk error, which importWithReload already turns into "wait for
 * the reload". It also notes when the page is being left, so the loads that leaving cancels
 * never reload.
 */
export function installPreloadErrorRecovery(
  target: EventTarget = window,
  deps?: ChunkReloadDeps,
): () => void {
  const onPreloadError = (event: Event) => {
    const failure = 'payload' in event ? event.payload : undefined
    if (isChunkLoadError(failure)) tryChunkReload(deps)
  }
  const onLeave = () => {
    leaving = true
  }
  // Back from the back-forward cache: the page is live again.
  const onReturn = () => {
    leaving = false
  }
  target.addEventListener('vite:preloadError', onPreloadError)
  target.addEventListener('beforeunload', onLeave)
  target.addEventListener('pagehide', onLeave)
  target.addEventListener('pageshow', onReturn)
  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError)
    target.removeEventListener('beforeunload', onLeave)
    target.removeEventListener('pagehide', onLeave)
    target.removeEventListener('pageshow', onReturn)
  }
}
