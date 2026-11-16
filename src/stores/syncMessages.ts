// The sync engine's words: every surface shows them as they are. Loaded with the engine only
// (src/stores/syncEngine.ts, a lazy chunk); the eager sync layer's few sentences stay in
// useSyncStore.ts.

import type { St5Failure } from '../data/core/codes'
import {
  SYNC_OFF_MESSAGE,
  SYNC_RELOAD_MESSAGE,
  type SyncErrorKind,
  type SyncPauseReason,
} from './useSyncStore'

export function syncMessage(
  kind: SyncErrorKind | SyncPauseReason | 'off' | 'offline',
  kb?: number,
): string {
  switch (kind) {
    case 'offline':
      return "You're offline. Changes are saved on this device and will sync when you're back online."
    case 'network':
      return "Couldn't reach the sync server. Your changes are saved on this device."
    case 'server':
      return 'The sync server had a problem. Your changes are saved on this device.'
    case 'permission':
      return 'The sync server refused access. Your data is safe on this device.'
    case 'invalid':
      return "The synced copy couldn't be read, so nothing was merged. Your data is safe on this device."
    case 'busy':
      return 'Your devices kept syncing at the same moment. Your changes are saved on this device.'
    case 'too-large':
      return `Sync paused: your data${kb === undefined ? '' : ` (${String(kb)} KB)`} is too large for the sync server. It's still saved here — export a backup.`
    case 'moved':
    case 'update-required':
      return 'Sync moved to a newer version. Reload SpendTrack to update.'
    case 'reload':
      return SYNC_RELOAD_MESSAGE
    case 'not-found':
      return 'No synced data found for this code. Check it on your other device.'
    case 'denied':
      return 'Sync paused: the sync server refused access. Your data is safe on this device.'
    case 'moved-private':
      return 'Sync was made private on your other device. Enter the new sync code shown there.'
    case 'no-cas':
      return 'Sync paused: this sync server cannot keep a private sync safe yet. Your data is safe on this device.'
    case 'off':
      return SYNC_OFF_MESSAGE
  }
}

/** A 53400 from the relay: it will not take another row. */
export const FULL_RELAY_MESSAGE = 'The sync relay is full. Your changes are saved on this device.'
export const REPAIRED_MESSAGE = 'The synced copy was damaged. Restored it from this device.'
export const INVALID_CODE_MESSAGE = "That code isn't valid."
/** What is wrong with a typed private code, by the reason its check gives (PRIVATE-SYNC 3.5). */
export const PRIVATE_CODE_MESSAGE: Record<St5Failure, string> = {
  length: 'That private code is too short or too long. Paste the full code from your other device.',
  symbol: 'That private code has a character no code uses. Check it against your other device.',
  range: 'One character of that code looks wrong. Check it against your other device.',
  checksum: 'One character of that code looks wrong. Check it against your other device.',
}

// ---------------------------------------------------------------------------
// Making a plain sync private (PRIVATE-SYNC 4): what the move answers, and the lines it
// publishes under the code
// ---------------------------------------------------------------------------

export const MOVE_BUSY_MESSAGE = 'Sync is busy in another tab. Try again in a moment.'
export const MOVE_LOCKDOWN_MESSAGE =
  "This sync's server still allows direct reads. Make sync private after the database lockdown."
export const MOVE_UNAVAILABLE_MESSAGE =
  "Sync can't be made private on this device right now. Nothing was changed."
export const MOVE_FAILED_MESSAGE =
  "The private sync couldn't be made just now. Nothing was changed. Try again in a moment."
export const MOVE_CHANGED_MESSAGE =
  'Sync was changed in another tab. Nothing was made private here.'
export const CLOSING_LINE = 'Closing the old sync…'
export const NOT_CLOSED_LINE = 'The old sync is not closed yet. This device keeps trying.'
export const UNSAVED_LINE =
  "This device couldn't save its note of the move, so it stops closing the old sync when SpendTrack closes. Free up space on this device."
export const NEXT_LINE =
  'Next: enter this code on your other devices. They stop syncing until you do.'
export const CONTESTED_LINE =
  "Another device may also have made this sync private. If your other device asks for a sync code, enter this one there. If it shows a different sync code instead: Disconnect on one device, then enter the other device's code on it. Your entries stay on each device and are merged."
export const STRAGGLER_LINE =
  'Something was written to the old sync after it was closed. If a device of yours is still on it, update it and enter this sync code there.'
export const DISCONNECT_RETIRING_LINE =
  'The old sync is not closed yet. A device still on it keeps syncing there, unencrypted.'
export const DISCONNECT_ALONE_LINE =
  "No other device has this sync code yet. A device waiting for it can't join without it."
