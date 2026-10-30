import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * How long to wait at most for a lazily loaded screen's heading. A screen's chunk can take
 * seconds on a slow network (a first visit, before the app is cached), or on a busy phone.
 */
const HEADING_WAIT_MS = 10_000

const focusLost = () => document.activeElement === null || document.activeElement === document.body

/**
 * After an in-app navigation that unmounted the focused control (a heatmap day, a top-category
 * row), focus would sit on <body> and the next Tab would start from the top of the page. Move it
 * to the new screen's heading (`main h1`, `tabIndex={-1}`) instead, as soon as a screen that
 * loads lazily renders it. Focus that is still on a live control (a tab bar link) is left alone,
 * and the wait ends as soon as anything else takes focus (a Tab, a tapped field, a shortcut's
 * sheet): that is the user's own move.
 */
export function useRouteFocus(): void {
  const { pathname } = useLocation()
  const previous = useRef(pathname)

  useEffect(() => {
    if (previous.current === pathname) return
    previous.current = pathname
    if (!focusLost()) return

    // True once there is nothing left to do: focus has a home, or the heading took it.
    const settle = (): boolean => {
      if (!focusLost()) return true
      const heading = document.querySelector<HTMLElement>('main h1')
      if (!heading) return false
      heading.focus()
      return true
    }
    if (settle()) return

    const observer = new MutationObserver(() => {
      if (settle()) stop()
    })
    const timer = setTimeout(stop, HEADING_WAIT_MS)
    document.addEventListener('focusin', stop)
    function stop() {
      observer.disconnect()
      clearTimeout(timer)
      document.removeEventListener('focusin', stop)
    }
    observer.observe(document.getElementById('main') ?? document.body, {
      childList: true,
      subtree: true,
    })
    return stop
  }, [pathname])
}
