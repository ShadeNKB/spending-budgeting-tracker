// Durable storage (DATA-ENGINE-SPEC §9.11, F-050): navigator.storage.persist() once per install,
// after the first data, and persisted() re-queried whenever Settings shows the storage facts.

interface StorageManagerLike {
  readonly persist?: () => Promise<boolean>
  readonly persisted?: () => Promise<boolean>
}

// older WebKit has no navigator.storage at all, whatever lib.dom says
const storageOf = (nav: Navigator): StorageManagerLike | undefined => nav.storage

function manager(): StorageManagerLike | null {
  if (typeof navigator === 'undefined') return null
  return storageOf(navigator) ?? null
}

/** Asks the browser to keep this origin's storage. Null when the browser cannot say. */
export async function requestPersist(): Promise<boolean | null> {
  const m = manager()
  if (m?.persist === undefined) return null
  try {
    return await m.persist()
  } catch {
    return null
  }
}

/** Whether the browser has granted persistence. Null when it cannot say. */
export async function queryPersisted(): Promise<boolean | null> {
  const m = manager()
  if (m?.persisted === undefined) return null
  try {
    return await m.persisted()
  } catch {
    return null
  }
}
