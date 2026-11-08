import { useState } from 'react'
import { BackupNudge } from './BackupNudge'
import { FirstRunCard, WELCOME_KEY } from './FirstRunCard'
import { IS_DEMO, useExpenseStore } from '../stores/useExpenseStore'
import { useSyncStore } from '../stores/useSyncStore'

/**
 * The local engine's envelope (src/data/local/keys.ts DB_KEY). Spelled out here: importing the
 * keys module would pull the data core's constants into a chunk this one shares with the engine.
 */
const DB_KEY = 'st5:db'

/** Whether `key` is stored; a refused read counts as stored, so it is never a first run. */
function stored(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null
  } catch {
    return true
  }
}

/**
 * A pristine origin: no envelope and no Start fresh answer. A pristine boot writes nothing until
 * its first commit, while a migration, a recovery and the demo seed all write the envelope as
 * they boot, so this is also how a browser that cleared the site's data looks.
 */
const pristine = (): boolean => !stored(DB_KEY) && !stored(WELCOME_KEY)

/**
 * The one slot above every screen (PR-4, F-050): the first-run card on a pristine origin, else
 * the backup nudge when one is due, never both. Lazy: AppShell mounts this chunk only when its
 * cheap check says a card may be wanted, and the full checks run here.
 */
export function DataCards() {
  const hydrated = useExpenseStore((s) => s.hydrated)
  const bootError = useExpenseStore((s) => s.bootError)
  const local = useExpenseStore((s) => s.local)
  const empty = useExpenseStore((s) => s.expenses.length === 0)
  const savedAt = useExpenseStore((s) => s.lastSavedAt)
  const unlinked = useSyncStore((s) => s.syncId === null)
  const [fresh, setFresh] = useState(pristine)
  const [checkedAt, setCheckedAt] = useState(savedAt)
  /** Start fresh pressed on this page (it also hides the card when storage refused the answer). */
  const [startedFresh, setStartedFresh] = useState(false)

  // Every save may have written the envelope (an entry, a category, a backup's date): look again.
  if (savedAt !== checkedAt) {
    setCheckedAt(savedAt)
    setFresh(pristine())
  }

  if (!hydrated || bootError !== null || local !== 'saved') return null
  if (empty && unlinked && !IS_DEMO && fresh && !startedFresh) {
    return (
      <FirstRunCard
        onStartFresh={() => {
          setStartedFresh(true)
        }}
      />
    )
  }
  return <BackupNudge />
}

// The shell's lazy() takes it as the module's default: no wrapper to rename it in startup code.
export default DataCards
