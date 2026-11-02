import { useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { announce } from '../../ui/announce'
import { shieldGesture, toastJustLeft } from '../../ui/pressShield'
import { revealInSheet } from '../../ui/toastClearance'

/**
 * A question that only a typed word answers ("Type DELETE to confirm"), for the actions that
 * reach every linked device. It sits where its trigger was, like `InlineConfirm`, and keeps its
 * guards:
 *
 * - It is a group named by the question and described by the detail; focus lands in the field,
 *   where a reflex Enter does nothing until the word is there.
 * - The confirm button stays disabled until the field holds exactly the word (spaces around it
 *   aside: a phone keyboard may add one). Capitals are what the phone offers first; on a laptop
 *   the word typed in small letters says, under the field, that it wants capitals (the label is
 *   drawn in capitals, so nothing else shows that case matters), and Enter says it again.
 * - It opens in sight: the field and the button it enables are scrolled into the sheet's view
 *   together (above the toasts, if any cover the sheet).
 * - Confirm runs once per appearance: a held Enter, a second Enter or a double tap cannot run it
 *   twice, and a press aimed at a toast that has just gone confirms nothing.
 * - Escape cancels the question, never the sheet it sits in.
 */
export function TypedConfirm({
  question,
  detail,
  icon,
  word,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  question: string
  detail?: React.ReactNode
  /** Drawn before the question. */
  icon?: React.ReactNode
  /** The word to type, in capitals: DELETE, REPLACE. */
  word: string
  confirmLabel: string
  cancelLabel?: string
  /** `danger` confirms with the solid red button; `warning` with the primary one. */
  tone?: 'danger' | 'warning'
  onConfirm: () => void
  onCancel: () => void
}) {
  const questionId = useId()
  const detailId = useId()
  const fieldRef = useRef<HTMLInputElement>(null)
  const confirmed = useRef(false)
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === word
  const wantsCapitals = !matches && typed.trim().toUpperCase() === word
  const capitalsHint = `Type it in capitals: ${word}`

  // In the commit that shows the question: a key pressed next lands in the field, and the
  // button it enables is in sight with it.
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (field === null) return
    field.focus()
    revealInSheet(field)
  }, [])

  const confirmOnce = () => {
    if (!matches || confirmed.current) return
    confirmed.current = true
    onConfirm()
  }

  const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      if (e.repeat) return
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.repeat) return
      // The hint under the field is already there; Enter that does nothing says why.
      if (wantsCapitals) announce(capitalsHint)
      confirmOnce()
    }
  }
  // Escape on a button takes the question back too (the layer stack leaves a handled Escape).
  const onButtonKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.repeat || e.nativeEvent.isComposing) return
    e.preventDefault()
    onCancel()
  }
  // The second press of a double click (detail 2 and up) answers nothing; the press that answered
  // is swallowed, so its rest cannot land on whatever takes the question's place.
  const press = (e: React.MouseEvent, act: () => void) => {
    if (e.detail > 1) return
    shieldGesture(e.nativeEvent)
    act()
  }

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      aria-describedby={detail === undefined ? undefined : detailId}
      className={clsx(
        'flex flex-col gap-3 rounded-lg border p-4',
        tone === 'danger'
          ? 'border-negative/30 bg-negative/[0.07]'
          : 'border-warning/30 bg-warning/[0.07]',
      )}
    >
      <div className="flex items-start gap-2">
        {icon}
        <div className="min-w-0">
          <p id={questionId} className="text-[13px] font-semibold text-white">
            {question}
          </p>
          {detail !== undefined && (
            <div
              id={detailId}
              className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-tertiary)]"
            >
              {detail}
            </div>
          )}
        </div>
      </div>
      <Input
        ref={fieldRef}
        label={`Type ${word} to confirm`}
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value)
        }}
        onKeyDown={onFieldKey}
        hint={wantsCapitals ? capitalsHint : undefined}
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        mono
      />
      <div className="flex gap-2">
        <Button
          className="flex-1"
          variant={tone === 'danger' ? 'dangerSolid' : 'primary'}
          disabled={!matches}
          onClick={(e) => {
            // A press where a toast has just gone was aimed at the toast: it confirms nothing.
            if (e.detail > 0 && toastJustLeft(e.nativeEvent)) return
            press(e, confirmOnce)
          }}
          onKeyDown={onButtonKey}
        >
          {confirmLabel}
        </Button>
        <Button
          className="flex-1"
          variant="ghost"
          onClick={(e) => {
            press(e, onCancel)
          }}
          onKeyDown={onButtonKey}
        >
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}
