// Run a callback once the page has loaded and the browser has a quiet moment.
// Used to mount hidden overlays after first paint instead of before it.

export const IDLE_TIMEOUT_MS = 2000
/** Safari has no requestIdleCallback; a short timer after load stands in for it. */
export const IDLE_FALLBACK_MS = 1200

export interface IdleHost extends EventTarget {
  readonly document: { readonly readyState: DocumentReadyState }
  setTimeout(handler: () => void, timeout: number): number
  clearTimeout(id: number): void
  requestIdleCallback?(callback: () => void, options?: { timeout?: number }): number
  cancelIdleCallback?(id: number): void
}

/** Returns a cancel function. The callback runs at most once. */
export function whenIdle(callback: () => void, host: IdleHost = window): () => void {
  let cancelScheduled: (() => void) | null = null
  let done = false

  const run = () => {
    if (done) return
    done = true
    callback()
  }

  const schedule = () => {
    if (done || cancelScheduled) return
    if (host.requestIdleCallback && host.cancelIdleCallback) {
      const cancelIdle = host.cancelIdleCallback.bind(host)
      const id = host.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS })
      cancelScheduled = () => {
        cancelIdle(id)
      }
    } else {
      const id = host.setTimeout(run, IDLE_FALLBACK_MS)
      cancelScheduled = () => {
        host.clearTimeout(id)
      }
    }
  }

  if (host.document.readyState === 'complete') schedule()
  else host.addEventListener('load', schedule, { once: true })

  return () => {
    done = true
    host.removeEventListener('load', schedule)
    cancelScheduled?.()
  }
}
