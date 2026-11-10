import { useEffect, type RefObject } from 'react'

// On an iPhone the on-screen keyboard covers the bottom of the page without resizing it, so a
// sheet fixed to the bottom of the screen sits under the keys with its Add button. The visual
// viewport is the part left in sight: while a sheet is in the page, its panel gets how much the
// keyboard covers (`--kb-inset`, which index.css lifts it by) and the height left in sight
// (`--vv-h`, which caps a bottom sheet's height). Android's keyboard resizes the page or the
// visual viewport the same way, so the one rule serves both.

/** Below this a gap is a scrollbar or rounding, not a keyboard (a keyboard covers 200 px or more). */
const MIN_KEYBOARD_PX = 80

/** Px of the layout viewport's bottom that the keyboard covers; 0 without one, or when zoomed. */
export function keyboardCover(
  innerHeight: number,
  viewport: { readonly height: number; readonly offsetTop: number; readonly scale: number },
): number {
  // Pinch zoom shrinks the visual viewport too: only an unzoomed one means a keyboard.
  if (Math.abs(viewport.scale - 1) > 0.01) return 0
  const covered = Math.round(innerHeight - viewport.height - viewport.offsetTop)
  return covered >= MIN_KEYBOARD_PX ? covered : 0
}

/** While `active`, keeps `--kb-inset` and `--vv-h` on `ref`'s element up to date. */
export function useKeyboardInset(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const viewport = window.visualViewport
    const el = ref.current
    if (!active || !viewport || !el) return
    let shown = -1
    const update = () => {
      const cover = keyboardCover(window.innerHeight, viewport)
      el.style.setProperty('--kb-inset', `${String(cover)}px`)
      // A zoomed-in viewport is small too, but the sheet keeps its size then.
      if (cover === 0) el.style.removeProperty('--vv-h')
      else el.style.setProperty('--vv-h', `${String(Math.round(viewport.height))}px`)
      if (cover === shown) return
      shown = cover
      // The sheet has just got shorter around the field being typed in (Notes, at its end): the
      // field took focus, and was scrolled to, before the keyboard came up.
      const focused = document.activeElement
      if (cover > 0 && focused instanceof HTMLElement && el.contains(focused) && focused !== el) {
        focused.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      el.style.removeProperty('--kb-inset')
      el.style.removeProperty('--vv-h')
    }
  }, [active, ref])
}
