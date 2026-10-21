import { isValidElement, useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryRouter,
  type RouteObject,
} from 'react-router-dom'
import { OverlayError, RouteError } from './RouteError'
import { createUpdateController, type SwRegistrationLike, type UpdateController } from './swUpdate'
import { downloadRescueFile } from '../lib/rescue'
import { CHUNK_RELOAD_KEY, openPage, reloadPage } from '../lib/chunkReload'

vi.mock('../lib/rescue', () => ({
  downloadRescueFile: vi.fn(() => ({ kind: 'empty' })),
}))
vi.mock('../lib/chunkReload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/chunkReload')>()),
  reloadPage: vi.fn(),
  openPage: vi.fn(),
}))

const BUG = new TypeError("Cannot read properties of undefined (reading 'amount')")
const STALE_CHUNK = new TypeError(
  'Failed to fetch dynamically imported module: https://spendtrack.test/assets/LedgerScreen-C69rfST8.js',
)

let screenError: Error = BUG
let shellError: Error | null = null
let pulseThrows = false

function Shell() {
  if (shellError) throw shellError
  return (
    <div>
      <p>SHELL</p>
      <nav>
        <Link to="/pulse">Pulse tab</Link>
        <Link to="/ledger">Ledger tab</Link>
      </nav>
      <Outlet />
    </div>
  )
}
function Pulse() {
  if (pulseThrows) throw screenError
  return <p>Pulse screen</p>
}
function Ledger(): never {
  throw screenError
}

const testRoutes = (controller?: UpdateController): RouteObject[] => [
  {
    path: '/',
    element: <Shell />,
    errorElement: <RouteError scope="app" controller={controller} />,
    children: [
      {
        errorElement: <RouteError scope="screen" controller={controller} />,
        children: [
          { index: true, element: <Pulse /> },
          { path: 'pulse', element: <Pulse /> },
          { path: 'ledger', element: <Ledger /> },
        ],
      },
    ],
  },
]

function renderAt(url: string, controller?: UpdateController) {
  const router = createMemoryRouter(testRoutes(controller), { initialEntries: [url] })
  render(<RouterProvider router={router} />)
  return router
}

/**
 * A real update controller on a page run by the old service worker, with the new build
 * downloaded and waiting (what the banner calls "ready").
 */
async function waitingUpdate() {
  const waiting = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() })
  const registration: SwRegistrationLike = Object.assign(new EventTarget(), {
    installing: null,
    waiting,
    active: Object.assign(new EventTarget(), { state: 'activated', postMessage: vi.fn() }),
    update: () => Promise.resolve(),
  })
  const container = Object.assign(new EventTarget(), {
    controller: {},
    register: () => Promise.resolve(registration),
  })
  const reload = vi.fn()
  const controller = createUpdateController({
    container,
    win: new EventTarget(),
    doc: Object.assign(new EventTarget(), {
      readyState: 'complete' as const,
      visibilityState: 'visible' as const,
    }),
    caches: null,
    now: () => Date.now(),
    reload,
    isOnline: () => true,
    hasUnsavedWork: () => false,
  })
  await act(async () => {
    controller.start()
    await Promise.resolve()
  })
  expect(controller.getSnapshot()).toBe('ready')
  /** The new worker has taken over (clientsClaim after SKIP_WAITING). */
  const takeOver = () => {
    act(() => {
      container.dispatchEvent(new Event('controllerchange'))
    })
  }
  return { controller, waiting, reload, takeOver }
}

const STUCK_HINT = 'If this keeps happening, close SpendTrack completely and open it again.'

function goOffline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
}

beforeEach(() => {
  screenError = BUG
  shellError = null
  pulseThrows = false
  sessionStorage.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(downloadRescueFile).mockClear()
  vi.mocked(reloadPage).mockClear()
  vi.mocked(openPage).mockClear()
})

describe('RouteError inside the shell (scope="screen")', () => {
  it('keeps the shell and explains a crash in plain words', () => {
    renderAt('/ledger')
    expect(screen.getByText('SHELL')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(
      screen.getByText(
        `This screen ran into a problem and couldn't be shown. Your expenses are still saved on this device. ${STUCK_HINT}`,
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to Pulse' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download my data' })).toBeInTheDocument()
    expect(
      screen.getByText('Saves a copy of everything stored in this browser, exactly as it is.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Hey developer/)).toBeNull()
  })

  it('explains a stale chunk as an update', () => {
    screenError = STALE_CHUNK
    renderAt('/ledger')
    expect(screen.getByRole('heading', { name: 'SpendTrack was just updated' })).toBeInTheDocument()
    expect(
      screen.getByText(
        "Part of the app couldn't load. This usually happens right after an update or when you're offline. Reloading fixes it.",
      ),
    ).toBeInTheDocument()
  })

  it('after an automatic reload that did not help, says how to clear it for good', () => {
    screenError = STALE_CHUNK
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now() - 3_000))
    renderAt('/ledger')
    expect(
      screen.getByText(
        "Part of the app couldn't load. This usually happens right after an update or when you're offline. Reloading fixes it. If this keeps happening, close SpendTrack completely and open it again.",
      ),
    ).toBeInTheDocument()
  })

  it('leaves that hint out when the last automatic reload was over a minute ago', () => {
    screenError = STALE_CHUNK
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now() - 61_000))
    renderAt('/ledger')
    expect(screen.queryByText(/close SpendTrack completely/)).toBeNull()
  })

  it('says so when a part that never loaded fails offline, instead of blaming an update', () => {
    screenError = STALE_CHUNK
    goOffline()
    renderAt('/ledger')
    expect(screen.getByRole('heading', { name: "You're offline" })).toBeInTheDocument()
    expect(
      screen.getByText(
        "This part of SpendTrack isn't saved on this device yet. Reconnect, then reload. Your expenses are safe on this device.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/just updated/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to Pulse' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download my data' })).toBeInTheDocument()
  })

  it('switches back to the update copy once the connection returns', () => {
    screenError = STALE_CHUNK
    goOffline()
    renderAt('/ledger')
    expect(screen.getByRole('heading', { name: "You're offline" })).toBeInTheDocument()
    act(() => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      window.dispatchEvent(new Event('online'))
    })
    expect(screen.getByRole('heading', { name: 'SpendTrack was just updated' })).toBeInTheDocument()
  })

  it('keeps the crash copy for an offline crash that is not a failed chunk', () => {
    goOffline()
    renderAt('/ledger')
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
  })

  it('moves focus to the heading', () => {
    renderAt('/ledger')
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toHaveFocus()
  })

  it('keeps technical details behind a disclosure, without a stack trace', () => {
    renderAt('/ledger')
    const details = screen.getByText('Technical details').closest('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    expect(details).toHaveTextContent(
      "TypeError: Cannot read properties of undefined (reading 'amount')",
    )
    expect(details?.textContent).not.toMatch(/\bat Ledger\b|\.tsx:\d+/)
  })

  it('goes to Pulse inside the app', async () => {
    const user = userEvent.setup()
    const router = renderAt('/ledger')
    await user.click(screen.getByRole('button', { name: 'Go to Pulse' }))
    expect(router.state.location.pathname).toBe('/pulse')
    expect(screen.getByText('Pulse screen')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Something went wrong' })).toBeNull()
  })

  it('clears when the user taps another tab', async () => {
    const user = userEvent.setup()
    renderAt('/ledger')
    await user.click(screen.getByRole('link', { name: 'Pulse tab' }))
    expect(screen.getByText('Pulse screen')).toBeInTheDocument()
  })

  it.each(['/pulse', '/'])('hides Go to Pulse when the error is on %s', (url) => {
    pulseThrows = true
    renderAt(url)
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go to Pulse' })).toBeNull()
  })

  it('reloads the page', async () => {
    const user = userEvent.setup()
    renderAt('/ledger')
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reloadPage).toHaveBeenCalledTimes(1)
  })

  it('installs a build that is already waiting before reloading (one SKIP_WAITING)', async () => {
    const user = userEvent.setup()
    const update = await waitingUpdate()
    renderAt('/ledger', update.controller)
    await user.dblClick(screen.getByRole('button', { name: 'Reload' }))
    expect(update.waiting.postMessage).toHaveBeenCalledTimes(1)
    expect(update.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(update.reload).not.toHaveBeenCalled()
    update.takeOver()
    expect(update.reload).toHaveBeenCalledTimes(1)
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it.each([
    [
      // The page cannot tell whether the browser saved it (iOS asks first), so it never claims so.
      { kind: 'downloaded', filename: 'spendtrack-backup-raw-2026-10-19-0930.json' } as const,
      'Saving spendtrack-backup-raw-2026-10-19-0930.json… Check your Downloads.',
    ],
    [{ kind: 'empty' } as const, 'Nothing is saved in this browser yet.'],
    [{ kind: 'unavailable' } as const, 'This browser blocked access to saved data.'],
    [{ kind: 'failed' } as const, "The download couldn't start. Try again, or reload first."],
  ])('reports the rescue download outcome %o', async (outcome, message) => {
    const user = userEvent.setup()
    vi.mocked(downloadRescueFile).mockReturnValueOnce(outcome)
    renderAt('/ledger')
    await user.click(screen.getByRole('button', { name: 'Download my data' }))
    expect(downloadRescueFile).toHaveBeenCalledTimes(1)
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.getByText(message).closest('[aria-live="polite"]')).not.toBeNull()
  })
})

describe('RouteError for a shell crash (scope="app")', () => {
  it('replaces the page with a full-height card offering the same actions', () => {
    shellError = BUG
    renderAt('/ledger')
    expect(screen.queryByText('SHELL')).toBeNull()
    const heading = screen.getByRole('heading', { name: 'Something went wrong' })
    expect(heading).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to Pulse' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download my data' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toContainElement(heading)
  })

  it('uses the update copy for a stale chunk', () => {
    shellError = STALE_CHUNK
    renderAt('/pulse')
    expect(screen.getByRole('heading', { name: 'SpendTrack was just updated' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Go to Pulse' })).toBeNull()
  })

  it('tells a crash how to clear it for good', () => {
    shellError = BUG
    renderAt('/ledger')
    expect(
      screen.getByText(
        `SpendTrack ran into a problem and couldn't be shown. Your expenses are still saved on this device. ${STUCK_HINT}`,
      ),
    ).toBeInTheDocument()
  })

  // Nothing else on this page can apply an update: there is no shell, so no banner.
  it('says when a new version is waiting, and Reload installs it', async () => {
    const user = userEvent.setup()
    shellError = BUG
    const update = await waitingUpdate()
    renderAt('/ledger', update.controller)
    expect(
      screen.getByText('A new version of SpendTrack is ready. Reload installs it.'),
    ).toBeVisible()
    await user.dblClick(screen.getByRole('button', { name: 'Reload' }))
    expect(update.waiting.postMessage).toHaveBeenCalledTimes(1)
    expect(update.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    update.takeOver()
    expect(update.reload).toHaveBeenCalledTimes(1)
  })

  it('says nothing about a new version when none is waiting', () => {
    shellError = BUG
    renderAt('/ledger')
    expect(screen.queryByText(/new version/)).toBeNull()
  })

  it('goes to Pulse with a fresh page load', async () => {
    const user = userEvent.setup()
    shellError = BUG
    renderAt('/ledger')
    await user.click(screen.getByRole('button', { name: 'Go to Pulse' }))
    expect(openPage).toHaveBeenCalledWith('/pulse')
  })

  it('installs a waiting build first when going to Pulse', async () => {
    const user = userEvent.setup()
    shellError = BUG
    const update = await waitingUpdate()
    renderAt('/ledger', update.controller)
    await user.click(screen.getByRole('button', { name: 'Go to Pulse' }))
    expect(update.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(openPage).not.toHaveBeenCalled()
    update.takeOver()
    expect(openPage).toHaveBeenCalledTimes(1)
    expect(openPage).toHaveBeenCalledWith('/pulse')
    expect(update.reload).not.toHaveBeenCalled()
  })
})

describe('OverlayError', () => {
  it('says the panel could not open and offers Reload, Close and the rescue download', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<OverlayError error={BUG} onClose={onClose} />)
    expect(screen.getByRole('alert')).toHaveTextContent("This panel couldn't open.")
    const card = screen.getByRole('region', { name: "This panel couldn't open." })
    await user.click(within(card).getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(within(card).getByRole('button', { name: 'Reload' }))
    expect(reloadPage).toHaveBeenCalledTimes(1)
    await user.click(within(card).getByRole('button', { name: 'Download my data' }))
    expect(downloadRescueFile).toHaveBeenCalledTimes(1)
    expect(within(card).getByText('Nothing is saved in this browser yet.')).toBeInTheDocument()
  })

  it('takes focus on Reload, closes on Escape and gives focus back to what opened it', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Settings
          </button>
          {open && <OverlayError error={BUG} onClose={() => setOpen(false)} />}
        </>
      )
    }
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus()
  })

  it('gives focus back on Close too', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Command palette
          </button>
          {open && <OverlayError error={BUG} onClose={() => setOpen(false)} />}
        </>
      )
    }
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Command palette' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Command palette' })).toHaveFocus()
  })

  it('blames the new release for a stale chunk', () => {
    render(<OverlayError error={STALE_CHUNK} onClose={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      "This panel couldn't open because a new version was just released.",
    )
  })

  it('says to reconnect when the panel was never saved for offline use', () => {
    goOffline()
    render(<OverlayError error={STALE_CHUNK} onClose={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      "This panel isn't saved on this device yet. Reconnect, then reload.",
    )
  })

  it('installs a waiting build on Reload', async () => {
    const user = userEvent.setup()
    const update = await waitingUpdate()
    render(<OverlayError error={STALE_CHUNK} onClose={() => {}} controller={update.controller} />)
    await user.dblClick(screen.getByRole('button', { name: 'Reload' }))
    expect(update.waiting.postMessage).toHaveBeenCalledTimes(1)
    expect(update.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    update.takeOver()
    expect(update.reload).toHaveBeenCalledTimes(1)
    expect(reloadPage).not.toHaveBeenCalled()
  })

  // Toasts share its anchor above the tab bar; a toast must never cover its buttons.
  it('sits above the toast layer', () => {
    render(<OverlayError error={BUG} onClose={() => {}} />)
    const card = screen.getByRole('region', { name: "This panel couldn't open." })
    expect(card).toHaveClass('z-[101]')
  })
})

describe('appRoutes', () => {
  // routes.tsx imports the whole app; load it once with room for a busy machine.
  let appRoutes: RouteObject[] = []
  beforeAll(async () => {
    ;({ appRoutes } = await import('./routes'))
  }, 60_000)

  it('wraps every screen in a pathless boundary inside the shell, under a root boundary', () => {
    expect(appRoutes).toHaveLength(1)
    const [root] = appRoutes
    expect(root?.path).toBe('/')
    expect(isValidElement<{ scope: string }>(root?.errorElement)).toBe(true)
    if (isValidElement<{ scope: string }>(root?.errorElement)) {
      expect(root.errorElement.props.scope).toBe('app')
    }
    expect(root?.children).toHaveLength(1)

    const layout = root?.children?.[0]
    expect(layout?.path).toBeUndefined()
    expect(layout?.element).toBeUndefined()
    if (isValidElement<{ scope: string }>(layout?.errorElement)) {
      expect(layout.errorElement.props.scope).toBe('screen')
    } else {
      expect.fail('the screen layout route has no errorElement')
    }
    expect(layout.children?.map((r) => (r.index ? 'index' : r.path))).toEqual([
      'index',
      'pulse',
      'ledger',
      'insights',
      '*',
    ])
  })
})
