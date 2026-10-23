import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useExpenseStore } from '../stores/useExpenseStore'
import { useUIStore } from '../stores/useUIStore'

// Launch Handler API (Chromium). With `launch_handler: { client_mode: 'focus-existing' }` a
// home-screen shortcut focuses the window that is already open and hands its URL to this
// queue instead of navigating. Not in lib.dom yet, so it is typed here.
interface LaunchParams {
  readonly targetURL?: string
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}
declare global {
  interface Window {
    readonly launchQueue?: LaunchQueue
  }
}

/** The manifest's "Add expense" shortcut is /pulse?add=1. */
export const ADD_PARAM = 'add'

// Evaluated with the app bundle, before the router can strip the param.
const INITIAL_URL = document.URL
let initialLaunchSeen = false

function isAddLaunch(targetURL: string): boolean {
  try {
    const url = new URL(targetURL)
    return url.origin === window.location.origin && url.searchParams.get(ADD_PARAM) === '1'
  } catch {
    return false
  }
}

/**
 * Opens the add sheet for `?add=1` (on any screen) and for shortcut launches into an open
 * window. It waits for hydration so an entry can never be written before the saved data is
 * loaded, opens once per request, and removes the param so a reload does not reopen it.
 */
export function useLaunchActions(): void {
  const [searchParams, setSearchParams] = useSearchParams()
  const hydrated = useExpenseStore((s) => s.hydrated)
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen)
  const [launchRequested, setLaunchRequested] = useState(false)
  const urlRequested = searchParams.get(ADD_PARAM) === '1'

  useEffect(() => {
    window.launchQueue?.setConsumer((params) => {
      const target = params.targetURL
      if (!target) return
      const first = !initialLaunchSeen
      initialLaunchSeen = true
      // The launch that opened this window already arrived as the page URL.
      if (first && target === INITIAL_URL) return
      if (isAddLaunch(target)) setLaunchRequested(true)
    })
  }, [])

  useEffect(() => {
    if (!hydrated || !(urlRequested || launchRequested)) return
    setAddSheetOpen(true)
    setLaunchRequested(false)
    if (urlRequested) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete(ADD_PARAM)
          return next
        },
        { replace: true },
      )
    }
  }, [hydrated, urlRequested, launchRequested, setAddSheetOpen, setSearchParams])
}
