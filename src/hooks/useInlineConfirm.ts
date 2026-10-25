import { useId, useLayoutEffect, useRef, useState } from 'react'
import { shieldGesture } from '../ui/pressShield'

/**
 * Open state and focus for an inline confirmation that replaces its trigger (`InlineConfirm`).
 *
 * The trigger unmounts while the question is shown, so focus cannot simply "stay" on it: the
 * confirmation focuses its own Cancel, and `close()` puts focus back once the DOM has settled,
 * by id, on the trigger's re-mounted button (or wherever the caller says). Without this, focus
 * fell to `<body>` next to an irreversible action.
 *
 * `T` is what is being confirmed (a category name, a fixed key). Give each trigger
 * `id={triggerId(key)}` and open with `ask(value, key)`; the key defaults to none.
 */
export function useInlineConfirm<T>() {
  const baseId = useId()
  const [pending, setPending] = useState<T | null>(null)
  const openedFrom = useRef<string | null>(null)
  const focusNext = useRef<string | null>(null)

  const triggerId = (key?: string) =>
    `${baseId}confirm${key === undefined ? '' : `-${encodeURIComponent(key)}`}`

  const ask = (value: T, key?: string) => {
    openedFrom.current = triggerId(key)
    // The question takes the trigger's place: a double tap's second tap must not answer it.
    shieldGesture()
    setPending(value)
  }

  /**
   * Hide the confirmation. Focus then goes to the trigger that opened it (no argument), to the
   * element with the given id, or nowhere (`null`: a closing sheet hands focus back itself).
   */
  const close = (focusId?: string | null) => {
    focusNext.current = focusId === undefined ? openedFrom.current : focusId
    setPending(null)
  }

  // In every commit of the owner, as it lands: the trigger has re-mounted (or the next row has
  // moved up), and focus is on it before any later key, also when `close()` ran after an await.
  useLayoutEffect(() => {
    const id = focusNext.current
    if (id === null) return
    focusNext.current = null
    document.getElementById(id)?.focus()
  })

  return { pending, ask, close, triggerId }
}
