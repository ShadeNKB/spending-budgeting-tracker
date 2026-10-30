import { useEffect, useLayoutEffect, useRef } from 'react'

type Bind = Record<string, (e: KeyboardEvent) => void>

const shouldIgnore = (target: EventTarget | null, modPressed: boolean, key: string): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  const editable = tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
  if (!editable) return false
  if (modPressed) return key === 'z'
  // Still allow ESC even when typing
  return key !== 'escape'
}

/**
 * Global hotkey hook.
 *
 * Keys are lowercased. Use "mod+" prefix for Meta (macOS) or Ctrl (Win/Linux), and "alt+"
 * after it for Alt. Ctrl+Alt (AltGr on Windows, which types characters) is "mod+alt+".
 * Examples: { "mod+k": fn, "alt+n": fn, "n": fn, "escape": fn }
 *
 * The listener is bound once per `enabled` and always calls the handlers from the latest
 * render, so callers can pass a fresh object literal every render.
 */
export function useHotkeys(binds: Bind, enabled: boolean = true): void {
  const bindsRef = useRef(binds)
  useLayoutEffect(() => {
    bindsRef.current = binds
  })

  useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const id = `${mod ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${key}`
      const current = bindsRef.current
      const fn = Object.hasOwn(current, id) ? current[id] : undefined
      if (!fn) return
      // Alt types nothing on Windows or Linux: like Ctrl, it may act from a text field.
      if (shouldIgnore(e.target, mod || e.altKey, key)) return
      e.preventDefault()
      fn(e)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled])
}
