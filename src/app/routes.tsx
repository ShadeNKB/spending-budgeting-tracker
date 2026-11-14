import { Navigate, type RouteObject } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AppShell } from './AppShell'
import { ScreenOutlet } from './RouteBoundary'
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

// A plain element rather than a component: this module exports the route config,
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

// Rendered by AppRoutes (RouteBoundary.tsx), whose boundary takes a failing shell: a full-page
// card.
export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      {
        // Pathless layout route: a screen error renders inside the shell's <Outlet/>, so
        // the TopBar, TabBar and overlays stay usable. The next navigation clears it.
        element: <ScreenOutlet />,
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
