import { Suspense, type ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { RouteObject } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import {
  BOOT_SCREEN_WAIT_MS,
  preloadWithin,
  routeScreen,
  screenForPath,
  type RouteScreen,
} from './routeScreen'

function Ready() {
  return <h1>Screen ready</h1>
}

let fallbacks = 0
function Fallback() {
  fallbacks += 1
  return <p>Loading screen</p>
}

function mount({ Screen }: RouteScreen) {
  return render(
    <ErrorBoundary resetKey="test" fallback={(error) => <p role="alert">{String(error)}</p>}>
      <Suspense fallback={<Fallback />}>
        <Screen />
      </Suspense>
    </ErrorBoundary>,
  )
}

/** A load the test settles by hand. */
function deferredLoad() {
  let settle: { resolve: (c: ComponentType) => void; reject: (e: unknown) => void } | undefined
  const load = vi.fn(
    () =>
      new Promise<ComponentType>((resolve, reject) => {
        settle = { resolve, reject }
      }),
  )
  return {
    load,
    resolve: (c: ComponentType) => settle?.resolve(c),
    reject: (e: unknown) => settle?.reject(e),
  }
}

afterEach(() => {
  cleanup()
  fallbacks = 0
})

describe('routeScreen', () => {
  it('renders a preloaded screen at once: no fallback, so no reveal delay', async () => {
    const page = routeScreen(() => Promise.resolve(Ready))
    await page.preload()
    mount(page)
    expect(screen.getByRole('heading', { name: 'Screen ready' })).toBeInTheDocument()
    expect(fallbacks).toBe(0)
  })

  it('suspends a screen that was not preloaded, as a lazy route does', async () => {
    const load = vi.fn(() => Promise.resolve(Ready))
    const page = routeScreen(load)
    expect(load).not.toHaveBeenCalled()
    mount(page)
    expect(fallbacks).toBeGreaterThan(0)
    expect(await screen.findByRole('heading', { name: 'Screen ready' })).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('loads the chunk once, however often it is preloaded and rendered', async () => {
    const pending = deferredLoad()
    const page = routeScreen(pending.load)
    void page.preload()
    void page.preload()
    mount(page)
    expect(screen.getByText('Loading screen')).toBeInTheDocument()
    await act(async () => {
      pending.resolve(Ready)
      await page.preload()
    })
    expect(screen.getByRole('heading', { name: 'Screen ready' })).toBeInTheDocument()
    expect(pending.load).toHaveBeenCalledTimes(1)
  })

  it('a failed load never rejects the preload, and the screen hands the error to its boundary', async () => {
    const failure = new TypeError('Failed to fetch dynamically imported module: /assets/X.js')
    const load = vi.fn(() => Promise.reject(failure))
    const page = routeScreen(load)
    await expect(page.preload()).resolves.toBeUndefined()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mount(page)
    expect(await screen.findByRole('alert')).toHaveTextContent(String(failure))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps the fallback while the load waits for a reload (it never settles)', async () => {
    const page = routeScreen(() => new Promise<ComponentType>(() => undefined))
    void page.preload()
    mount(page)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByText('Loading screen')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).toBeNull()
  })
})

describe('screenForPath', () => {
  const a = routeScreen(() => Promise.resolve(Ready))
  const b = routeScreen(() => Promise.resolve(Ready))
  const aRoute: RouteObject = { path: 'a', element: null }
  const bRoute: RouteObject = { path: 'b', element: null }
  const routes: RouteObject[] = [
    {
      path: '/',
      children: [
        { index: true, element: null },
        { children: [aRoute, bRoute, { path: '*', element: null }] },
      ],
    },
  ]
  const screens = new Map([
    [aRoute, a],
    [bRoute, b],
  ])

  it('picks the screen of the route the router will render', () => {
    expect(screenForPath(routes, screens, '/a')).toBe(a)
    expect(screenForPath(routes, screens, '/b')).toBe(b)
    expect(screenForPath(routes, screens, '/a/')).toBe(a)
  })

  it('picks nothing for a route without a lazy screen, or a URL that redirects', () => {
    expect(screenForPath(routes, screens, '/')).toBeUndefined()
    expect(screenForPath(routes, screens, '/nope')).toBeUndefined()
    expect(screenForPath(routes, screens, '/a/b')).toBeUndefined()
    expect(screenForPath([], screens, '/a')).toBeUndefined()
  })
})

describe('preloadWithin', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles as soon as the chunk is in', async () => {
    vi.useFakeTimers()
    const page = routeScreen(() => Promise.resolve(Ready))
    let settled = false
    void preloadWithin(page, BOOT_SCREEN_WAIT_MS).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
  })

  it('settles when the load fails: the screen shows the failure when it renders', async () => {
    vi.useFakeTimers()
    const page = routeScreen(() => Promise.reject(new Error('boom')))
    let settled = false
    void preloadWithin(page, BOOT_SCREEN_WAIT_MS).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
  })

  it('stops waiting after the limit for a load that stalls or waits for a reload', async () => {
    vi.useFakeTimers()
    const page = routeScreen(() => new Promise<ComponentType>(() => undefined))
    let settled = false
    void preloadWithin(page, BOOT_SCREEN_WAIT_MS).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(BOOT_SCREEN_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  it('holds the first render 200 ms at most', () => {
    expect(BOOT_SCREEN_WAIT_MS).toBe(200)
  })
})
