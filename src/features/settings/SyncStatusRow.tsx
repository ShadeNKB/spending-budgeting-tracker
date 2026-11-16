import type { Ref } from 'react'
import { RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import type { StatusView, Tone } from './syncPanelView'

const ROW_TEXT: Record<Tone, string> = {
  muted: 'text-[var(--text-tertiary)]',
  accent: 'text-accent',
  positive: 'text-positive',
  info: 'text-[var(--text-secondary)]',
  warning: 'text-warning',
  negative: 'text-negative',
}

// 'info' is neutral grey, as on the pill: cyan means a sync in progress, and nothing is.
const ROW_DOT: Record<Tone, string> = {
  muted: 'bg-white/20',
  accent: 'bg-accent',
  positive: 'bg-positive',
  info: 'bg-[var(--text-tertiary)]',
  warning: 'bg-warning',
  negative: 'bg-negative',
}

/** The linked sync's status row: its dot and label, and Sync now, described by the label. */
export function SyncStatusRow({
  status,
  statusId,
  syncing,
  buttonRef,
  onSync,
}: {
  status: StatusView
  statusId: string
  /** The owner's own Sync now is on the wire. */
  syncing: boolean
  buttonRef: Ref<HTMLButtonElement>
  onSync: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <div
          className={clsx(
            'h-2 w-2 shrink-0 rounded-full',
            ROW_DOT[status.tone],
            status.busy && 'animate-pulse',
          )}
        />
        <span id={statusId} className={clsx('text-[12px] font-medium', ROW_TEXT[status.tone])}>
          {status.label}
        </span>
      </div>
      <button
        ref={buttonRef}
        type="button"
        onClick={onSync}
        aria-disabled={syncing}
        aria-describedby={statusId}
        aria-label="Sync now"
        title="Sync now"
        className="tap-target inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-[var(--text-tertiary)] md:h-8 md:w-8"
      >
        <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
      </button>
    </div>
  )
}
