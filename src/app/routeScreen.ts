// A lazy route screen whose chunk can start loading before the router renders it.
//
// The app opens on a URL; when that URL's screen is a lazy chunk, the shell would first render
// its Suspense fallback and React 19 then holds the reveal for up to 300 ms after the fallback
// (its Suspense throttle). main.tsx loads that one chunk at start-up, alongside the data
// engine, and starts React once it is in (preloadWithin), so the screen renders at once: no
// fallback, no throttle. Every other screen loads the first time it is rendered, through
// React.lazy as before.
//
// No JSX and no component declared at the top level: the module exports helpers, not
// components (React Fast Refresh boundary).

import { createElement, lazy, type ComponentType } from 'react'
import { matchRoutes, type RouteObject } from 'react-router-dom'

export interface RouteScreen {
  /** The screen: rendered at once when its chunk is in, otherwise suspends until it is. */
  Screen: ComponentType
  /**
   * Starts loading the chunk (once for the page's life). Settles when the load does, and never
   * rejects: a failed load is the screen's to show, through its route's error boundary.
   */
  preload: () => Promise<void>
}

/**
 * `load` must come from importWithReload, as every lazy chunk's does: a stale chunk then waits
 * for the one reload (the promise never settles, so the fallback stays), and any other failure
 * is remembered and thrown to the route's error boundary each time the screen renders, as a
 * React.lazy that failed is.
 */
export function routeScreen(load: () => Promise<ComponentType>): RouteScreen {
  let loaded: ComponentType | undefined
  let loading: Promise<ComponentType> | undefined
  const start = (): Promise<ComponentType> => {
    loading ??= load().then((component) => {
      loaded = component
      return component
    })
    return loading
  }

  // The same load: a screen rendered before its chunk is in suspends exactly as a React.lazy
  // route does.
  const Lazy = lazy(() => start().then((component) => ({ default: component })))

  // Picked when the screen mounts. A mounted screen is never re-rendered with the other one:
  // its element is fixed in the route table and it reads no context.
  function Screen() {
    return createElement(loaded ?? Lazy)
  }

  return {
    Screen,
    preload: () =>
      start().then(
        () => undefined,
        () => undefined,
      ),
  }
}

/**
 * How long React's first render waits for the boot screen's chunk. Long enough for a chunk that
 * is local (service-worker precache or HTTP cache) to load and run on a slow phone; short enough
 * that a chunk still coming over a slow network delays the shell by at most this before it shows
 * as it did before, with the loading skeleton, the screen then arriving through the lazy path.
 */
export const BOOT_SCREEN_WAIT_MS = 200

/**
 * Preloads `screen` and settles when its chunk is in, when the load fails, or after `maxWaitMs`,
 * whichever comes first: a load that stalls, or waits for the stale-chunk reload, never holds
 * the app back for longer than that. The screen then loads as a lazy route does.
 */
export function preloadWithin(screen: RouteScreen, maxWaitMs: number): Promise<void> {
  return Promise.race([
    screen.preload(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, maxWaitMs)
    }),
  ])
}

/**
 * The lazy screen the router renders for `pathname`, if it renders one: matched with the
 * router's own matcher, so a URL that redirects (the catch-all) or a screen in the entry chunk
 * picks nothing.
 */
export function screenForPath(
  routes: RouteObject[],
  screens: ReadonlyMap<RouteObject, RouteScreen>,
  pathname: string,
): RouteScreen | undefined {
  const leaf = matchRoutes(routes, pathname)?.at(-1)?.route
  return leaf ? screens.get(leaf) : undefined
}
