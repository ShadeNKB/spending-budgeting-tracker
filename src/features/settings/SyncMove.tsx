import type { Ref } from 'react'
import { AlertCircle, Download, Loader2, Lock } from 'lucide-react'
import clsx from 'clsx'
import { Button } from '../../ui/Button'
import { InlineConfirm } from '../../ui/InlineConfirm'
import type { MoveTone } from '../../stores/useSyncStore'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { ARIA_DISABLED } from './JoinSync'
import { lastBackupLine, useBackupDownload } from './backupDownload'

// "Make sync private" (PRIVATE-SYNC 4.5): the offer on a plain sync, and the lines the engine
// publishes under the code once this device made it private. The engine decides when it is
// offered and what each line says; this file only shows them.

/** What the question says happens, in the owner's terms (4.5). */
const MOVE_DETAIL =
  "This device makes a new, encrypted synced copy and closes the old one. Your other device stops syncing until you enter the new sync code there; one that hasn't synced lately needs updating first. What the old sync held could be read on the server until now, and that isn't undone."

// 44 px tall under a finger (not just its hit area); a mouse keeps the 40 px button.
const ACTION = 'w-full [@media(pointer:coarse)]:h-11'

/**
 * The offer, on a plain sync where the engine offers it: a hint, the button, and the question in
 * its place once pressed, with the age of the last backup and a way to take one first.
 */
export function MoveOffer({
  asking,
  moving,
  buttonRef,
  hintId,
  onAsk,
  onConfirm,
  onCancel,
}: {
  asking: boolean
  moving: boolean
  buttonRef: Ref<HTMLButtonElement>
  hintId: string
  onAsk: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const lastBackupAt = useExpenseStore((s) => s.facts.lastBackupAt)
  const downloadBackup = useBackupDownload()
  return (
    <div className="flex flex-col gap-2">
      <p id={hintId} className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
        This sync isn&apos;t encrypted. Making it private encrypts what your devices send from now
        on.
      </p>
      {asking ? (
        <>
          <InlineConfirm
            tone="warning"
            question="Make sync private?"
            detail={`${MOVE_DETAIL} ${lastBackupLine(lastBackupAt)}.`}
            confirmLabel="Make private"
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
          <Button onClick={downloadBackup} variant="ghost" className={ACTION}>
            <Download size={14} aria-hidden /> Export backup
          </Button>
        </>
      ) : (
        <Button
          ref={buttonRef}
          onClick={onAsk}
          variant="ghost"
          aria-disabled={moving}
          aria-describedby={hintId}
          className={clsx(ACTION, ARIA_DISABLED)}
        >
          {moving ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Lock size={14} aria-hidden />
          )}
          {moving ? 'Making sync private…' : 'Make sync private'}
        </Button>
      )}
    </div>
  )
}

// The panel's two looks for a line: a note in secondary text, a warning in its amber banner.
const LINE_LOOK: Record<MoveTone, string> = {
  note: 'text-[12px] leading-relaxed text-[var(--text-secondary)]',
  warning:
    'flex items-start gap-2 rounded-md border border-warning/25 bg-warning/10 px-2.5 py-2 text-[13px] leading-relaxed text-warning md:text-[11px]',
}

/**
 * The engine's lines under the code (closing the old sync, the next step, contested, a write to
 * the old sync). One live region, always mounted and empty when there is nothing to say, so a
 * line that appears while the panel is open is announced; the eye reads the same words beside
 * it, as the banners do.
 */
export function MoveLines({
  lines,
  tones,
}: {
  lines: readonly string[]
  tones: readonly MoveTone[]
}) {
  return (
    <>
      <div role="status" className="sr-only">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {lines.length > 0 && (
        <div className="flex flex-col gap-2">
          {lines.map((line, i) => {
            const tone = tones[i] ?? 'note'
            return (
              <p key={line} aria-hidden="true" className={LINE_LOOK[tone]}>
                {tone === 'warning' && (
                  <AlertCircle size={12} className="mt-1 shrink-0 md:mt-0.5" aria-hidden="true" />
                )}
                <span className="min-w-0">{line}</span>
              </p>
            )
          })}
        </div>
      )}
    </>
  )
}
