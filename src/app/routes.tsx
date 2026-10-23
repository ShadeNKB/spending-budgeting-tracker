import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AppShell } from './AppShell'
import { RouteError } from './RouteError'
import { PulseScreen } from '../features/pulse/PulseScreen'
import { importWithReload } from '../lib/chunkReload'

// A stale chunk after a deploy reloads the page once instead of failing (see chunkReload).
const LedgerScreen = lazy(() =>
  importWithReload(() => import('../features/ledger/LedgerScreen')).then((m) => ({
    default: m.LedgerScreen,
  })),
)
const InsightsScreen = lazy(() =>
  importWithReload(() => import('../features/insights/InsightsScreen')).then((m) => ({
    default: m.InsightsScreen,
  })),
)

// A plain element rather than a component: this module exports the router config,
// so it must not declare components of its own (React Fast Refresh boundary).
const screenSkeleton = (
  <div role="status" aria-live="polite" className="flex flex-col gap-4">
    <span className="sr-only">Loading screen</span>
    <div className="h-9 w-40 animate-pulse rounded-lg bg-surface-2" />
    <div className="grid gap-4 md:grid-cols-2">
      <div className="h-36 animate-pulse rounded-2xl border border-white/[0.06] bg-surface-1" />
      <div className="h-36 animate-pulse rounded-2xl border border-white/[0.06] bg-surface-1" />
    </div>
    <div className="h-56 animate-pulse rounded-2xl border border-white/[0.06] bg-surface-1" />
  </div>
)

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    // The shell itself failed: a full-page recovery card.
    errorElement: <RouteError scope="app" />,
    children: [
      {
        // Pathless layout route: a screen error renders inside the shell's <Outlet/>, so
        // the TopBar, TabBar and overlays stay usable. The router clears it on navigation.
        errorElement: <RouteError scope="screen" />,
        children: [
          // Render PulseScreen directly at "/" — avoids Navigate redirect that causes
          // AnimatePresence mode="wait" to show a blank frame on first cold visit.
          { index: true, element: <PulseScreen /> },
          { path: 'pulse', element: <PulseScreen /> },
          {
            path: 'ledger',
            element: (
              <Suspense fallback={screenSkeleton}>
                <LedgerScreen />
              </Suspense>
            ),
          },
          {
            path: 'insights',
            element: (
              <Suspense fallback={screenSkeleton}>
                <InsightsScreen />
              </Suspense>
            ),
          },
          { path: '*', element: <Navigate to="/pulse" replace /> },
        ],
      },
    ],
  },
]

export const router = createBrowserRouter(appRoutes)
