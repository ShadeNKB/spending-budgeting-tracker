// Lifecycle flush and cross-tab events (DATA-ENGINE-SPEC §9.5, §9.9, F-017). A page that is
// hidden, frozen or unloaded may never run another task, so the envelope and the mirror are written
// synchronously in the event itself.

export interface LifecycleHandlers {
  /** The envelope, then the mirror, synchronously. */
  readonly flushAll: () => void
  /** A `storage` event from another tab on this device. */
  readonly onStorage: (key: string | null) => void
  /** The Storage this engine booted on: events about another area are not ours. */
  readonly area: () => unknown
}

/** Installs the listeners; returns their removal. */
export function installLifecycle(h: LifecycleHandlers): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  const flush = (): void => {
    h.flushAll()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') h.flushAll()
  }
  const onStorage = (e: Event): void => {
    const area: unknown = 'storageArea' in e ? e.storageArea : null
    // the browser fires it only in OTHER tabs; an event about another Storage is not ours
    if (area !== null && area !== h.area()) return
    const key: unknown = 'key' in e ? e.key : null
    h.onStorage(typeof key === 'string' ? key : null)
  }
  document.addEventListener('visibilitychange', onVisibility)
  document.addEventListener('freeze', flush)
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  window.addEventListener('storage', onStorage)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    document.removeEventListener('freeze', flush)
    window.removeEventListener('pagehide', flush)
    window.removeEventListener('beforeunload', flush)
    window.removeEventListener('storage', onStorage)
  }
}
