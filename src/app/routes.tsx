import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AppShell } from './AppShell'
import { PulseScreen } from '../features/pulse/PulseScreen'

const LedgerScreen = lazy(() =>
  import('../features/ledger/LedgerScreen').then((m) => ({ default: m.LedgerScreen })),
)
const InsightsScreen = lazy(() =>
  import('../features/insights/InsightsScreen').then((m) => ({ default: m.InsightsScreen })),
)

function LazyScreen({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<ScreenSkeleton />}>{children}</Suspense>
}

function ScreenSkeleton() {
  return (
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
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      // Render PulseScreen directly at "/" — avoids Navigate redirect that causes
      // AnimatePresence mode="wait" to show a blank frame on first cold visit.
      { index: true, element: <PulseScreen /> },
      { path: 'pulse', element: <PulseScreen /> },
      {
        path: 'ledger',
        element: (
          <LazyScreen>
            <LedgerScreen />
          </LazyScreen>
        ),
      },
      {
        path: 'insights',
        element: (
          <LazyScreen>
            <InsightsScreen />
          </LazyScreen>
        ),
      },
      { path: '*', element: <Navigate to="/pulse" replace /> },
    ],
  },
])
