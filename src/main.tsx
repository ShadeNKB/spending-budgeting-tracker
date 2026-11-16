import { startEngineLoad } from './stores/useExpenseStore'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { installPreloadErrorRecovery } from './lib/chunkReload'
import { getUpdateController } from './app/swUpdate'
import { bootScreenFor } from './app/routes'
import { BOOT_SCREEN_WAIT_MS, preloadWithin } from './app/routeScreen'

// The data engine is its own chunk (with the data core): start fetching it before anything else,
// so it downloads and evaluates while React does (P2-1). The shell shows "Loading local spending
// data" until it has booted.
startEngineLoad()

// A lazy chunk, or the CSS it needs, that fails to load (stale after a deploy) reloads the
// page once. Loads cancelled by leaving the page never trigger it.
installPreloadErrorRecovery()

// Prompt-style service worker: registered here (no injected register script), production
// only. The dev server has no sw.js.
if (import.meta.env.PROD) getUpdateController().start()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element in index.html')

function renderApp(root: HTMLElement) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

// When the URL the app opens on is a lazy screen (/ledger, /insights), its chunk loads now,
// alongside the engine, and React starts once it is in: the screen then renders at once when
// the data is in, with no loading skeleton and no Suspense reveal delay (React holds a reveal
// up to 300 ms after a fallback). Started any later, the data could win the race (a state update
// from the store renders synchronously, before the chunk's code has run). React waits
// BOOT_SCREEN_WAIT_MS at most; after that the screen loads as a lazy route does (routeScreen).
const bootScreen = bootScreenFor(window.location.pathname)
if (bootScreen) {
  void preloadWithin(bootScreen, BOOT_SCREEN_WAIT_MS).then(() => {
    renderApp(rootElement)
  })
} else {
  renderApp(rootElement)
}
