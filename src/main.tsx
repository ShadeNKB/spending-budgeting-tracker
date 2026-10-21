import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { installPreloadErrorRecovery } from './lib/chunkReload'
import { getUpdateController } from './app/swUpdate'

// A lazy chunk, or the CSS it needs, that fails to load (stale after a deploy) reloads the
// page once. Loads cancelled by leaving the page never trigger it.
installPreloadErrorRecovery()

// Prompt-style service worker: registered here (no injected register script), production
// only. The dev server has no sw.js.
if (import.meta.env.PROD) getUpdateController().start()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element in index.html')

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
