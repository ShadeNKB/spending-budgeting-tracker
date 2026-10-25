import { useId, useLayoutEffect, useRef } from 'react'
import clsx from 'clsx'
import { Button } from './Button'
import { shieldGesture, toastJustLeft } from './pressShield'

/**
 * A question that replaces the button that asked it ("Delete all 12 expenses?"), until the
 * user confirms or cancels. Pair it with `useInlineConfirm`, which brings focus back after.
 *
 * - Focus lands on Cancel as it appears (same commit): the safe default sits under a reflex
 *   Enter.
 * - It is a group named by the question and described by the detail, so a screen reader
 *   announces what is being asked as focus enters.
 * - Escape cancels it, as Cancel does: it never closes the sheet the question sits in, and
 *   loses none of the edits made there.
 * - Confirm runs once per appearance: a double tap or a held Enter cannot run it twice.
 * - A double click answers once and asks once: the second press of the click that asked is
 *   ignored here, and the second press of the click that answered goes nowhere.
 */
export function InlineConfirm({
  question,
  detail,
  icon,
  confirmLabel,
  confirmName,
  cancelLabel = 'Cancel',
  cancelName,
  tone = 'danger',
  layout = 'card',
  onConfirm,
  onCancel,
}: {
  question: string
  detail?: React.ReactNode
  /** Drawn before the question in the card layout. */
  icon?: React.ReactNode
  confirmLabel: React.ReactNode
  /** Accessible name when `confirmLabel` is an icon or needs context. */
  confirmName?: string
  cancelLabel?: React.ReactNode
  cancelName?: string
  /** `danger` confirms with the solid red button; `warning` with the primary one. */
  tone?: 'danger' | 'warning'
  /** `card`: a boxed block with full-width buttons. `row`: inline in a list row, icon buttons. */
  layout?: 'card' | 'row'
  onConfirm: () => void
  onCancel: () => void
}) {
  const questionId = useId()
  const detailId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmed = useRef(false)

  // In the commit that shows the question, not a task later: a question that comes from no
  // press (the import one waits for the file read) would otherwise be on screen while a key
  // still lands on the trigger.
  useLayoutEffect(() => {
    cancelRef.current?.focus()
  }, [])

  // `detail` counts the presses of a click: 0 from the keyboard, 2 and up for the second press of
  // a double click, which lands here as the question replaces its trigger. The question is gone
  // once answered, and the rest of the press that answered would land on whatever took its place
  // (the trigger again, asking once more; the next row's trash): it is swallowed.
  const answer = (e: React.MouseEvent, act: () => void) => {
    if (e.detail > 1) return
    shieldGesture(e.nativeEvent)
    act()
  }
  const confirm = (e: React.MouseEvent) => {
    // A press where a toast has just gone was aimed at the toast: it confirms nothing.
    if (e.detail > 0 && toastJustLeft(e.nativeEvent)) return
    answer(e, () => {
      if (confirmed.current) return
      confirmed.current = true
      onConfirm()
    })
  }
  const cancel = (e: React.MouseEvent) => {
    answer(e, onCancel)
  }
  // Escape takes back the question, not the sheet it sits in with the edits made there: the
  // layer stack leaves an Escape that was handled. Its auto-repeat closes nothing either.
  const backOut = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.repeat || e.nativeEvent.isComposing) return
    e.preventDefault()
    onCancel()
  }

  const row = layout === 'row'
  // Icon buttons in a row sit 12 px apart: their 44 px touch areas meet without overlapping.
  const button = { size: row ? 'iconSm' : 'md', className: row ? undefined : 'flex-1' } as const

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      aria-describedby={detail === undefined ? undefined : detailId}
      className={clsx(
        'flex gap-3',
        row
          ? 'min-w-0 flex-1 items-center'
          : [
              'flex-col rounded-lg border p-4',
              tone === 'danger'
                ? 'border-negative/30 bg-negative/[0.07]'
                : 'border-warning/30 bg-warning/[0.07]',
            ],
      )}
    >
      <div className={row ? 'min-w-0 flex-1' : 'flex items-start gap-2'}>
        {icon}
        <div className="min-w-0">
          <p
            id={questionId}
            className={clsx(
              'text-[13px] text-white',
              row ? 'truncate font-medium' : 'font-semibold',
            )}
          >
            {question}
          </p>
          {detail !== undefined && (
            <div
              id={detailId}
              className={clsx(
                'text-[var(--text-tertiary)]',
                row ? 'truncate text-[11px]' : 'mt-0.5 text-[12px] leading-relaxed',
              )}
            >
              {detail}
            </div>
          )}
        </div>
      </div>
      <div className={clsx('flex', row ? 'gap-3' : 'gap-2')}>
        <Button
          {...button}
          variant={tone === 'danger' ? 'dangerSolid' : 'primary'}
          aria-label={confirmName}
          onClick={confirm}
          onKeyDown={backOut}
        >
          {confirmLabel}
        </Button>
        <Button
          {...button}
          ref={cancelRef}
          variant="ghost"
          aria-label={cancelName}
          onClick={cancel}
          onKeyDown={backOut}
        >
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}
