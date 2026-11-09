import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

const APP_TITLE = 'SpendTrack'

const SCREENS: ReadonlyMap<string, string> = new Map([
  ['/', 'Pulse'],
  ['/pulse', 'Pulse'],
  ['/ledger', 'Ledger'],
  ['/insights', 'Insights'],
])

/** "Ledger · SpendTrack": the screen's name first, the app's after; the app's alone elsewhere. */
export function screenTitle(pathname: string): string {
  const screen = SCREENS.get(pathname.replace(/\/+$/, '') || '/')
  return screen === undefined ? APP_TITLE : `${screen} · ${APP_TITLE}`
}

/**
 * Names the page after its screen, so a browser tab, the history list and a screen reader's
 * page title tell the screens apart (F-107).
 */
export function useScreenTitle(): void {
  const { pathname } = useLocation()
  useEffect(() => {
    document.title = screenTitle(pathname)
  }, [pathname])
}
