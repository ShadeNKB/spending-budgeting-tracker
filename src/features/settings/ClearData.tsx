import { useId, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, LogOut, Trash2 } from 'lucide-react'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { useInlineConfirm } from '../../hooks/useInlineConfirm'
import { useToast } from '../../hooks/useToast'
import { announce } from '../../ui/announce'
import { isOwnRow, undoAction, useExpenseStore } from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { TypedConfirm } from './TypedConfirm'

/** Delete all and its Undo live this long (P2-12). */
const UNDO_MS = 30_000

const DANGER_TRIGGER =
  'w-full text-negative hover:!border-negative/30 hover:!bg-negative/10 aria-disabled:pointer-events-none aria-disabled:opacity-40'

type Asking = 'delete' | 'remove'

/** "1 entry", "12 entries". */
const entries = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`

/** "1 change", "12 changes". */
const changes = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'change' : 'changes'}`

/**
 * The danger zone of Backup. Without sync there is one action, "Delete all entries". With sync
 * on there are two that do very different things, named for what they reach: delete everywhere
 * (tombstones every linked device gets; typed DELETE) and remove from this device only (no
 * tombstones: the relay and the other devices keep everything). Both deletes keep a snapshot and
 * a 30 s Undo; a snapshot that cannot be stored refuses the delete and offers a backup instead.
 * Removing asks for the backup as its own step first (required while changes are still unsynced):
 * WebKit drops a download the same task reloads over, so the wipe waits for a second tap.
 */
export function ClearData({ onDownloadBackup }: { onDownloadBackup: () => void }) {
  const synced = useSyncStore((s) => s.syncId !== null)
  // Everywhere means the owner's own rows: a demo build's sample rows never sync (P2-22), so a
  // count with them in would promise to delete on the other devices what they never had.
  const count = useExpenseStore((s) =>
    synced ? s.expenses.reduce((n, e) => (isOwnRow(e) ? n + 1 : n), 0) : s.expenses.length,
  )
  const toast = useToast()
  const confirm = useInlineConfirm<Asking>()
  const [refused, setRefused] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [download, setDownload] = useState(true)
  const [backedUp, setBackedUp] = useState(false)
  // What only this device holds, read as the question opens (the relay lacks these changes).
  const [unsynced, setUnsynced] = useState(0)

  const deleteAll = () => {
    try {
      useExpenseStore.getState().deleteAllEverywhere()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nothing was deleted.'
      setRefused(message)
      confirm.close(null)
      announce(`Download a backup, then try again. ${message}`, 'assertive')
      return
    }
    const entry = useExpenseStore.getState().undoStack.at(-1)
    const undoId = entry?.id.startsWith('all-') === true ? entry.id : null
    toast.info('All entries deleted', {
      duration: UNDO_MS,
      undoId: undoId ?? undefined,
      action:
        undoId === null
          ? undefined
          : undoAction(toast, undoId, (outcome) => {
              // The ledger filling again may be off screen (Settings is open over it): said.
              if (outcome.skipped === 0) toast.success(`Restored ${entries(outcome.applied)}`)
            }),
    })
    confirm.close()
  }

  const removeHere = () => {
    setRemoving(true)
    confirm.close(null)
    // The page reloads to a first run when it is done; it only comes back here on a failure.
    useExpenseStore
      .getState()
      .removeDataFromThisDevice()
      .catch((err: unknown) => {
        setRemoving(false)
        toast.error(err instanceof Error ? err.message : 'Nothing was removed.')
        confirm.close(confirm.triggerId('remove'))
      })
  }

  const ask = (what: Asking) => {
    if (what === 'delete' && count === 0) return
    setRefused(null)
    setDownload(true)
    setBackedUp(false)
    if (what === 'remove') setUnsynced(useExpenseStore.getState().unsyncedChanges())
    confirm.ask(what, what)
  }

  const mustDownload = unsynced > 0
  // The backup is a tap of its own: the wipe and its reload come with the next one.
  const backupStep = (download || mustDownload) && !backedUp
  const takeBackup = () => {
    try {
      onDownloadBackup()
    } catch {
      // nothing was removed: the question goes back to its trigger, to try again
      toast.error("The backup couldn't download, so nothing was removed. Try again.")
      confirm.close(confirm.triggerId('remove'))
      return
    }
    setBackedUp(true)
    announce('Backup downloaded. You can remove SpendTrack from this device now.')
  }

  if (removing) {
    return (
      <p role="status" className="text-[13px] text-[var(--text-secondary)]">
        Removing SpendTrack from this device…
      </p>
    )
  }

  const deleteTrigger = (
    <Button
      id={confirm.triggerId('delete')}
      variant="ghost"
      className={DANGER_TRIGGER}
      aria-disabled={count === 0 ? true : undefined}
      onClick={() => {
        ask('delete')
      }}
    >
      <Trash2 size={14} aria-hidden />
      {synced ? deleteEverywhereLabel(count) : 'Delete all entries'}
    </Button>
  )

  return (
    <div className="flex flex-col gap-2">
      {refused !== null && (
        <RefusedNotice
          message={refused}
          onDownload={() => {
            onDownloadBackup()
            setRefused(null)
            confirm.close(confirm.triggerId('delete'))
          }}
          onClose={() => {
            setRefused(null)
            confirm.close(confirm.triggerId('delete'))
          }}
        />
      )}

      {confirm.pending === 'delete' ? (
        synced ? (
          <TypedConfirm
            icon={<DangerIcon />}
            question={`${count === 1 ? 'Delete 1 entry' : `Delete all ${count.toLocaleString()} entries`} on this device and on your other devices?`}
            detail="They go everywhere when your devices next sync. A copy is kept on this device, and you can undo for 30 seconds."
            word="DELETE"
            confirmLabel="Delete everywhere"
            onConfirm={deleteAll}
            onCancel={() => {
              confirm.close()
            }}
          />
        ) : (
          <InlineConfirm
            icon={<DangerIcon />}
            question={
              count === 1 ? 'Delete 1 entry?' : `Delete all ${count.toLocaleString()} entries?`
            }
            detail="A copy is kept on this device, and you can undo for 30 seconds."
            confirmLabel="Delete all"
            onConfirm={deleteAll}
            onCancel={() => {
              confirm.close()
            }}
          />
        )
      ) : (
        deleteTrigger
      )}

      {synced &&
        (confirm.pending === 'remove' ? (
          <InlineConfirm
            // A new question once the backup is taken (its confirm runs once per appearance);
            // clearing the box only relabels the confirm, so focus stays on the box.
            key={backedUp ? 'remove' : 'ask'}
            tone="warning"
            question="Remove SpendTrack data from this device?"
            detail={
              <>
                {mustDownload
                  ? `${changes(unsynced)} on this device ${unsynced === 1 ? "hasn't" : "haven't"} synced yet, so only a backup keeps ${unsynced === 1 ? 'it' : 'them'}.`
                  : 'Your other devices and the sync copy keep everything.'}{' '}
                This device forgets its data and its sync code.
                {backedUp ? (
                  <span className="mt-2 block font-medium text-[var(--text-secondary)]">
                    Backup downloaded.
                  </span>
                ) : mustDownload ? null : (
                  <DownloadFirst
                    checked={download}
                    onChange={setDownload}
                    onEscape={() => {
                      confirm.close()
                    }}
                  />
                )}
              </>
            }
            confirmLabel={backupStep ? 'Download backup' : 'Remove from this device'}
            onConfirm={backupStep ? takeBackup : removeHere}
            onCancel={() => {
              confirm.close()
            }}
          />
        ) : (
          <Button
            id={confirm.triggerId('remove')}
            variant="ghost"
            className="w-full"
            onClick={() => {
              ask('remove')
            }}
          >
            <LogOut size={14} aria-hidden /> Remove SpendTrack from this device only
          </Button>
        ))}
    </div>
  )
}

function deleteEverywhereLabel(count: number): string {
  if (count === 0) return 'Delete all entries everywhere'
  if (count === 1) return 'Delete 1 entry everywhere'
  return `Delete all ${count.toLocaleString()} entries everywhere`
}

function DangerIcon() {
  return <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-negative" />
}

/** The preselected "Download a backup first" box inside the remove question. */
function DownloadFirst({
  checked,
  onChange,
  onEscape,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  onEscape: () => void
}) {
  const id = useId()
  return (
    // The whole row is the label: a tap on it toggles the box. It reaches 16 px out to the left
    // (into the card's padding) and is 44 px tall, so the box has a 44 px touch area all round.
    <label
      htmlFor={id}
      className="-ml-4 mt-2 flex min-h-11 cursor-pointer items-center gap-2.5 pl-4 text-[13px] text-[var(--text-secondary)]"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
        onKeyDown={(e) => {
          // Escape takes back the question, not the sheet it sits in.
          if (e.key !== 'Escape' || e.repeat || e.nativeEvent.isComposing) return
          e.preventDefault()
          onEscape()
        }}
        className="h-4 w-4 shrink-0 accent-accent"
      />
      Download a backup first
    </label>
  )
}

/**
 * A delete or an import whose safety copy could not be stored: nothing happened, and a backup
 * download is the way on. It takes focus as it appears.
 */
export function RefusedNotice({
  message,
  onDownload,
  onClose,
}: {
  message: string
  onDownload: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const messageId = useId()
  const downloadRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    downloadRef.current?.focus()
  }, [])
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/[0.07] p-4"
    >
      <div>
        <p id={titleId} className="text-[13px] font-semibold text-white">
          Download a backup, then try again
        </p>
        <p
          id={messageId}
          className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-tertiary)]"
        >
          {message}
        </p>
      </div>
      <div className="flex gap-2">
        <Button ref={downloadRef} className="flex-1" onClick={onDownload}>
          Download backup
        </Button>
        <Button className="flex-1" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}
