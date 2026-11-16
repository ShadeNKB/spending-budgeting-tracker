import { Navigate, type RouteObject } from 'react-router-dom'
import { Suspense } from 'react'
import { AppShell } from './AppShell'
import { ScreenOutlet } from './RouteBoundary'
import { PulseScreen } from '../features/pulse/PulseScreen'
import { importWithReload } from '../lib/chunkReload'
import { routeScreen, screenForPath, type RouteScreen } from './routeScreen'

// A stale chunk after a deploy reloads the page once instead of failing (see chunkReload).
const ledger = routeScreen(() =>
  importWithReload(() => import('../features/ledger/LedgerScreen')).then((m) => m.LedgerScreen),
)
const insights = routeScreen(() =>
  importWithReload(() => import('../features/insights/InsightsScreen')).then(
    (m) => m.InsightsScreen,
  ),
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

function lazyScreenRoute(path: string, { Screen }: RouteScreen): RouteObject {
  return {
    path,
    element: (
      <Suspense fallback={screenSkeleton}>
        <Screen />
      </Suspense>
    ),
  }
}

const ledgerRoute = lazyScreenRoute('ledger', ledger)
const insightsRoute = lazyScreenRoute('insights', insights)

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
          ledgerRoute,
          insightsRoute,
          { path: '*', element: <Navigate to="/pulse" replace /> },
        ],
      },
    ],
  },
]

const lazyScreens = new Map<RouteObject, RouteScreen>([
  [ledgerRoute, ledger],
  [insightsRoute, insights],
])

/** The lazy screen the app renders first when it opens on `pathname`, if that is one. */
export function bootScreenFor(pathname: string): RouteScreen | undefined {
  return screenForPath(appRoutes, lazyScreens, pathname)
}
