import { Outlet, useLocation, useRoutes, type RouteObject } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import { RouteError } from './RouteError'
import type { UpdateController } from './swUpdate'

// The routes are declarative (BrowserRouter + useRoutes): a data router, which gives a route
// its `errorElement`, is more than half of the router's weight, and the app has no loaders or
// actions to use it for. These two boundaries do what the error elements did, and clear the
// way they did: on the next navigation, whatever caused it (a tab, Go to Pulse, Back).

interface Props {
  controller?: UpdateController
}

function Routed({ routes }: { routes: RouteObject[] }) {
  return useRoutes(routes)
}

/**
 * The route tree, under the app-wide boundary. When the shell itself fails, a full-page
 * recovery card takes its place.
 */
export function AppRoutes({ routes, controller }: Props & { routes: RouteObject[] }) {
  const { key } = useLocation()
  return (
    <ErrorBoundary
      resetKey={key}
      fallback={(error) => <RouteError scope="app" error={error} controller={controller} />}
    >
      <Routed routes={routes} />
    </ErrorBoundary>
  )
}

/**
 * The shell's outlet. A screen that fails shows its card here, so the TopBar, the TabBar and
 * the overlays stay usable.
 */
export function ScreenOutlet({ controller }: Props) {
  const { key } = useLocation()
  return (
    <ErrorBoundary
      resetKey={key}
      fallback={(error) => <RouteError scope="screen" error={error} controller={controller} />}
    >
      <Outlet />
    </ErrorBoundary>
  )
}
