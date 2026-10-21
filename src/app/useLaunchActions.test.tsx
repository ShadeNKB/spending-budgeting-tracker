import { StrictMode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom'

interface FakeLaunchParams {
  targetURL?: string
}

class FakeLaunchQueue {
  consumer: ((params: FakeLaunchParams) => void) | null = null
  setConsumer(consumer: (params: FakeLaunchParams) => void): void {
    this.consumer = consumer
  }
  launch(targetURL: string): void {
    act(() => {
      this.consumer?.({ targetURL })
    })
  }
}

// useLaunchActions remembers the page's initial URL at module load, and the stores are
// module singletons, so every test loads a fresh copy of all three together.
async function load() {
  vi.resetModules()
  const [{ useLaunchActions }, { useUIStore }, { useExpenseStore }] = await Promise.all([
    import('./useLaunchActions'),
    import('../stores/useUIStore'),
    import('../stores/useExpenseStore'),
  ])
  return { useLaunchActions, useUIStore, useExpenseStore }
}

type Loaded = Awaited<ReturnType<typeof load>>

// The stores pull in most of the app. Transform it once up front, with room for a busy
// machine, so each test's fresh load only re-evaluates cached modules.
beforeAll(async () => {
  await load()
}, 60_000)

function mount(mod: Loaded, url: string, { strict = false } = {}) {
  let location = { pathname: '', search: '' }
  function Probe() {
    mod.useLaunchActions()
    const current = useLocation()
    location = { pathname: current.pathname, search: current.search }
    return null
  }
  const router = createMemoryRouter([{ path: '*', element: <Probe /> }], {
    initialEntries: [url],
  })
  // Count every false -> true transition of the add sheet: "opens once" means exactly one.
  let opens = 0
  mod.useUIStore.subscribe((state, prev) => {
    if (state.addSheetOpen && !prev.addSheetOpen) opens += 1
  })
  const tree = <RouterProvider router={router} />
  render(strict ? <StrictMode>{tree}</StrictMode> : tree)
  return {
    router,
    location: () => location,
    opens: () => opens,
    hydrate: () => {
      act(() => {
        mod.useExpenseStore.setState({ hydrated: true })
      })
    },
    close: () => {
      act(() => {
        mod.useUIStore.getState().setAddSheetOpen(false)
      })
    },
    isOpen: () => mod.useUIStore.getState().addSheetOpen,
  }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('?add=1', () => {
  it('waits for hydration, opens the add sheet once and strips the param', async () => {
    const mod = await load()
    const app = mount(mod, '/pulse?add=1')
    expect(app.isOpen()).toBe(false)
    expect(app.location().search).toBe('?add=1')

    app.hydrate()
    expect(app.isOpen()).toBe(true)
    expect(app.opens()).toBe(1)
    expect(app.location()).toEqual({ pathname: '/pulse', search: '' })

    app.close()
    expect(app.isOpen()).toBe(false)
    expect(app.opens()).toBe(1)
  })

  it('opens once under StrictMode double effects', async () => {
    const mod = await load()
    const app = mount(mod, '/pulse?add=1', { strict: true })
    app.hydrate()
    expect(app.opens()).toBe(1)
    expect(app.location().search).toBe('')
  })

  it('keeps the current screen and other params', async () => {
    const mod = await load()
    mod.useExpenseStore.setState({ hydrated: true })
    const app = mount(mod, '/ledger?q=kopi&add=1')
    expect(app.isOpen()).toBe(true)
    expect(app.location()).toEqual({ pathname: '/ledger', search: '?q=kopi' })
  })

  it('handles in-app navigation to ?add=1 again after the sheet was closed', async () => {
    const mod = await load()
    mod.useExpenseStore.setState({ hydrated: true })
    const app = mount(mod, '/pulse')
    expect(app.isOpen()).toBe(false)

    await act(() => app.router.navigate('/pulse?add=1'))
    expect(app.opens()).toBe(1)
    app.close()
    await act(() => app.router.navigate('/insights?add=1'))
    expect(app.opens()).toBe(2)
    expect(app.location()).toEqual({ pathname: '/insights', search: '' })
  })

  it.each(['/pulse', '/pulse?add=0', '/pulse?add=true', '/pulse?adding=1'])(
    'ignores %s',
    async (url) => {
      const mod = await load()
      const app = mount(mod, url)
      app.hydrate()
      expect(app.opens()).toBe(0)
    },
  )
})

describe('launchQueue (installed app, focus-existing)', () => {
  it('opens the add sheet for a shortcut launch into this window, without moving screens', async () => {
    const queue = new FakeLaunchQueue()
    vi.stubGlobal('launchQueue', queue)
    const mod = await load()
    mod.useExpenseStore.setState({ hydrated: true })
    const app = mount(mod, '/ledger')
    expect(queue.consumer).not.toBeNull()

    queue.launch(`${window.location.origin}/pulse?add=1`)
    expect(app.opens()).toBe(1)
    expect(app.location()).toEqual({ pathname: '/ledger', search: '' })

    app.close()
    queue.launch(`${window.location.origin}/pulse?add=1`)
    expect(app.opens()).toBe(2)
  })

  it('holds a launch until hydration', async () => {
    const queue = new FakeLaunchQueue()
    vi.stubGlobal('launchQueue', queue)
    const mod = await load()
    const app = mount(mod, '/pulse')
    queue.launch(`${window.location.origin}/pulse?add=1`)
    expect(app.isOpen()).toBe(false)
    app.hydrate()
    expect(app.opens()).toBe(1)
  })

  it('ignores plain app launches and other origins', async () => {
    const queue = new FakeLaunchQueue()
    vi.stubGlobal('launchQueue', queue)
    const mod = await load()
    mod.useExpenseStore.setState({ hydrated: true })
    const app = mount(mod, '/pulse')
    queue.launch(`${window.location.origin}/pulse`)
    queue.launch('https://attacker.example/pulse?add=1')
    queue.launch('not a url')
    expect(app.opens()).toBe(0)
  })

  it('does not reopen for the launch that opened this window (already handled by the URL)', async () => {
    window.history.replaceState(null, '', '/pulse?add=1')
    const queue = new FakeLaunchQueue()
    vi.stubGlobal('launchQueue', queue)
    const mod = await load()
    mod.useExpenseStore.setState({ hydrated: true })
    const app = mount(mod, '/pulse?add=1')
    expect(app.opens()).toBe(1)
    app.close()

    queue.launch(`${window.location.origin}/pulse?add=1`)
    expect(app.isOpen()).toBe(false)

    // A later shortcut launch into the same window is a new request.
    queue.launch(`${window.location.origin}/pulse?add=1`)
    expect(app.opens()).toBe(2)
  })
})
