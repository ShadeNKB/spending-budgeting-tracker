import { lazy, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { create } from 'zustand'
import { OverlaySlot } from './OverlaySlot'

// A stand-in for an overlay that reads its open flag from a store and settles its layout in
// a mount effect, the way SettingsDrawer picks a side or a bottom sheet.
const usePanel = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => {
    set({ open })
  },
}))

interface Seen {
  open: boolean
  layoutSettled: boolean
}
let renders: Seen[] = []

function Panel() {
  const open = usePanel((s) => s.open)
  const [layoutSettled, setLayoutSettled] = useState(false)
  useEffect(() => {
    setLayoutSettled(true)
  }, [])
  renders.push({ open, layoutSettled })
  return open ? <div role="dialog" aria-label="Panel" data-settled={String(layoutSettled)} /> : null
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup({ mountClosed }: { mountClosed: boolean }) {
  const chunk = deferred<{ default: typeof Panel }>()
  const LazyPanel = lazy(() => chunk.promise)
  function Harness({ idle }: { idle: boolean }) {
    const open = usePanel((s) => s.open)
    const setOpen = usePanel((s) => s.setOpen)
    return (
      <OverlaySlot open={open} idle={idle} setOpen={setOpen} mountClosed={mountClosed}>
        <LazyPanel />
      </OverlaySlot>
    )
  }
  const view = render(<Harness idle={false} />)
  return {
    chunk,
    goIdle: () => {
      view.rerender(<Harness idle />)
    },
    loadChunk: async () => {
      await act(async () => {
        chunk.resolve({ default: Panel })
        await chunk.promise
      })
    },
    failChunk: async (error: Error) => {
      await act(async () => {
        chunk.reject(error)
        await chunk.promise.catch(() => undefined)
      })
    },
  }
}

beforeEach(() => {
  renders = []
  usePanel.setState({ open: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('OverlaySlot', () => {
  it('renders nothing (and loads nothing) before the first open or idle', () => {
    setup({ mountClosed: false })
    expect(renders).toEqual([])
  })

  it('mounts closed once the app is idle', async () => {
    const app = setup({ mountClosed: false })
    app.goIdle()
    await app.loadChunk()
    expect(renders[0]).toEqual({ open: false, layoutSettled: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('mounts straight away when opened first (the default)', async () => {
    const app = setup({ mountClosed: false })
    act(() => {
      usePanel.getState().setOpen(true)
    })
    await app.loadChunk()
    expect(renders[0]).toEqual({ open: true, layoutSettled: false })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  describe('mountClosed (an overlay that settles its layout in a mount effect)', () => {
    it('opened before it ever mounted: mounts closed, then opens with its layout settled', async () => {
      const app = setup({ mountClosed: true })
      act(() => {
        usePanel.getState().setOpen(true)
      })
      await app.loadChunk()
      expect(renders[0]).toEqual({ open: false, layoutSettled: false })
      expect(renders.find((r) => r.open)).toEqual({ open: true, layoutSettled: true })
      expect(screen.getByRole('dialog')).toHaveAttribute('data-settled', 'true')
      expect(usePanel.getState().open).toBe(true)
    })

    it('holds the open even when its chunk resolved just before the tap', async () => {
      const app = setup({ mountClosed: true })
      app.goIdle()
      // The chunk lands, but React has not rendered the waiting overlay yet when the tap comes.
      app.chunk.resolve({ default: Panel })
      await app.chunk.promise
      act(() => {
        usePanel.getState().setOpen(true)
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(renders[0]).toEqual({ open: false, layoutSettled: false })
      expect(renders.find((r) => r.open)).toEqual({ open: true, layoutSettled: true })
      expect(screen.getByRole('dialog')).toHaveAttribute('data-settled', 'true')
    })

    it('once mounted, opens directly like any other overlay', async () => {
      const app = setup({ mountClosed: true })
      app.goIdle()
      await app.loadChunk()
      renders = []
      act(() => {
        usePanel.getState().setOpen(true)
      })
      expect(renders[0]).toEqual({ open: true, layoutSettled: true })
      act(() => {
        usePanel.getState().setOpen(false)
      })
      act(() => {
        usePanel.getState().setOpen(true)
      })
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('still shows the recovery card when the held overlay fails to load', async () => {
      const user = userEvent.setup()
      const app = setup({ mountClosed: true })
      act(() => {
        usePanel.getState().setOpen(true)
      })
      await app.failChunk(new Error('boom'))
      expect(screen.getByRole('alert')).toHaveTextContent("This panel couldn't open.")
      await user.click(screen.getByRole('button', { name: 'Close' }))
      expect(screen.queryByRole('alert')).toBeNull()
      expect(usePanel.getState().open).toBe(false)
    })
  })

  it('keeps a failure silent while closed, then shows the card on open', async () => {
    const app = setup({ mountClosed: false })
    app.goIdle()
    await app.failChunk(new Error('boom'))
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => {
      usePanel.getState().setOpen(true)
    })
    expect(screen.getByRole('alert')).toHaveTextContent("This panel couldn't open.")
  })

  it('without idle, mounts on the first open only (the quick-add full-entry sheet)', async () => {
    const chunk = deferred<{ default: typeof Panel }>()
    const LazyPanel = lazy(() => chunk.promise)
    function Harness() {
      const open = usePanel((s) => s.open)
      const setOpen = usePanel((s) => s.setOpen)
      return (
        <OverlaySlot open={open} setOpen={setOpen}>
          <LazyPanel />
        </OverlaySlot>
      )
    }
    render(<Harness />)
    await act(async () => {
      chunk.resolve({ default: Panel })
      await chunk.promise
    })
    expect(renders).toEqual([])
    act(() => {
      usePanel.getState().setOpen(true)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('runs onFail once when it fails with no card to show, and shows nothing', async () => {
    const onFail = vi.fn()
    const chunk = deferred<{ default: typeof Panel }>()
    const LazyPanel = lazy(() => chunk.promise)
    render(
      <OverlaySlot open idle onFail={onFail}>
        <LazyPanel />
      </OverlaySlot>,
    )
    await act(async () => {
      chunk.reject(new Error('boom'))
      await chunk.promise.catch(() => undefined)
    })
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
