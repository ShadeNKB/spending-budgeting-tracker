// What the local engine refuses to do because storage cannot keep a safety copy first. Shared by
// the engine and the sync bridge (which says the engine's own words instead of a sync error's).

/**
 * A remote mass removal that could not be made restorable first: no room for the guard snapshot
 * nor for the journal entry holding the removed records (§11.9, P2-20). Nothing was removed.
 */
export class SafetyCopyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafetyCopyError'
  }
}

export const REMOTE_SAFETY_COPY_ERROR =
  'Your other device removed entries, but this device has no room to keep a copy of them first, so nothing was removed here. Download a backup, then free up space on this device.'
