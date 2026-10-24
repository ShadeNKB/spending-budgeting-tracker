import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UpdateBanner } from './UpdateBanner'
import {
  createUpdateController,
  type SwRegistrationLike,
  type UpdateController,
  type UpdateState,
} from './swUpdate'
import { hasUnsavedWork } from '../lib/unsavedWork'

function fakeController(initial: UpdateState) {
  let state = initial
  const listeners = new Set<() => void>()
  const spies = {
    apply: vi.fn(),
    confirmApply: vi.fn(),
    cancelConfirm: vi.fn(),
    dismiss: vi.fn(),
    reloadToLatest: vi.fn(),
    checkNow: vi.fn(),
  }
  const controller: UpdateController = {
    start: vi.fn(),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    ...spies,
  }
  const set = (next: UpdateState) => {
    act(() => {
      state = next
      for (const listener of listeners) listener()
    })
  }
  return { controller, set, ...spies }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('UpdateBanner', () => {
  it('renders an empty live region while there is nothing to say', () => {
    const { controller } = fakeController('idle')
    render(<UpdateBanner controller={controller} />)
    const region = screen.getByRole('status')
    expect(region).toBeEmptyDOMElement()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers Reload and Later when a new version is ready', async () => {
    const user = userEvent.setup()
    const { controller, apply, dismiss } = fakeController('ready')
    render(<UpdateBanner controller={controller} />)
    expect(screen.getByRole('status')).toHaveTextContent('A new version of SpendTrack is ready.')
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(apply).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Later' }))
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('offers only Reload after another tab updated', () => {
    const { controller } = fakeController('updated-elsewhere')
    render(<UpdateBanner controller={controller} />)
    expect(screen.getByRole('status')).toHaveTextContent('SpendTrack was updated in another tab.')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull()
  })

  it('asks before clearing typed text', async () => {
    const user = userEvent.setup()
    const { controller, confirmApply, cancelConfirm } = fakeController('confirm')
    render(<UpdateBanner controller={controller} />)
    expect(screen.getByRole('status')).toHaveTextContent("Reloading will clear what you've typed.")
    await user.click(screen.getByRole('button', { name: 'Reload anyway' }))
    expect(confirmApply).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(cancelConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows progress with the button disabled while reloading', () => {
    const { controller } = fakeController('reloading')
    render(<UpdateBanner controller={controller} />)
    expect(screen.getByRole('status')).toHaveTextContent('Updating…')
    expect(screen.getByRole('button', { name: /reload/i })).toBeDisabled()
  })

  it('follows controller changes and never dismisses itself', () => {
    vi.useFakeTimers()
    try {
      const { controller, set } = fakeController('idle')
      render(<UpdateBanner controller={controller} />)
      set('ready')
      expect(screen.getByRole('status')).toHaveTextContent('A new version of SpendTrack is ready.')
      act(() => {
        vi.advanceTimersByTime(10 * 60 * 1000)
      })
      expect(screen.getByRole('status')).toHaveTextContent('A new version of SpendTrack is ready.')
      set('idle')
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps every action at least 44 px tall on phones', () => {
    const { controller } = fakeController('confirm')
    render(<UpdateBanner controller={controller} />)
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toMatch(/(^|\s)h-11(\s|$)/)
    }
  })

  it('confirms with the real controller when a field has text (H3 in miniature)', async () => {
    const user = userEvent.setup()
    const waiting = { state: 'installed', postMessage: vi.fn() }
    const registration: SwRegistrationLike = Object.assign(new EventTarget(), {
      installing: null,
      waiting: Object.assign(new EventTarget(), waiting),
      active: Object.assign(new EventTarget(), { state: 'activated', postMessage: vi.fn() }),
      update: () => Promise.resolve(),
    })
    const container = Object.assign(new EventTarget(), {
      controller: {},
      register: () => Promise.resolve(registration),
    })
    const doc = Object.assign(new EventTarget(), {
      readyState: 'complete' as const,
      visibilityState: 'visible' as const,
    })
    const reload = vi.fn()
    const controller = createUpdateController({
      container,
      win: new EventTarget(),
      doc,
      caches: null,
      now: () => Date.now(),
      reload,
      isOnline: () => true,
      hasUnsavedWork: () => hasUnsavedWork(),
    })
    render(
      <>
        <input aria-label="Quick add" defaultValue="kopi 1.8" />
        <UpdateBanner controller={controller} />
      </>,
    )
    await act(async () => {
      controller.start()
      await Promise.resolve()
    })
    await user.click(await screen.findByRole('button', { name: 'Reload' }))
    expect(screen.getByRole('status')).toHaveTextContent("Reloading will clear what you've typed.")
    expect(waiting.postMessage).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Reload anyway' }))
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    act(() => {
      container.dispatchEvent(new Event('controllerchange'))
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  describe('focus (each action removes the button that was pressed)', () => {
    function realController(hasText: () => boolean) {
      const registration: SwRegistrationLike = Object.assign(new EventTarget(), {
        installing: null,
        waiting: Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() }),
        active: Object.assign(new EventTarget(), { state: 'activated', postMessage: vi.fn() }),
        update: () => Promise.resolve(),
      })
      return createUpdateController({
        container: Object.assign(new EventTarget(), {
          controller: {},
          register: () => Promise.resolve(registration),
        }),
        win: new EventTarget(),
        doc: Object.assign(new EventTarget(), {
          readyState: 'complete' as const,
          visibilityState: 'visible' as const,
        }),
        caches: null,
        now: () => Date.now(),
        reload: vi.fn(),
        isOnline: () => true,
        hasUnsavedWork: hasText,
      })
    }

    async function setup() {
      const controller = realController(() => hasUnsavedWork())
      render(
        <>
          <input aria-label="Quick add" defaultValue="kopi 1.8" />
          <UpdateBanner controller={controller} />
        </>,
      )
      await act(async () => {
        controller.start()
        await Promise.resolve()
      })
      return screen.getByRole('textbox', { name: 'Quick add' })
    }

    it('moves to "Reload anyway" on the confirm step, and "Keep editing" returns to the field', async () => {
      const user = userEvent.setup()
      const field = await setup()
      await user.click(field)
      await user.click(await screen.findByRole('button', { name: 'Reload' }))
      expect(screen.getByRole('button', { name: 'Reload anyway' })).toHaveFocus()

      await user.click(screen.getByRole('button', { name: 'Keep editing' }))
      expect(field).toHaveFocus()
    })

    it('works from the keyboard too', async () => {
      const user = userEvent.setup()
      const field = await setup()
      await user.click(field)
      await user.tab()
      expect(await screen.findByRole('button', { name: 'Reload' })).toHaveFocus()
      await user.keyboard('{Enter}')
      expect(screen.getByRole('button', { name: 'Reload anyway' })).toHaveFocus()
      await user.tab()
      await user.keyboard('{Enter}')
      expect(field).toHaveFocus()
    })

    it('"Later" returns focus to the field', async () => {
      const user = userEvent.setup()
      const field = await setup()
      await user.click(field)
      await user.click(await screen.findByRole('button', { name: 'Later' }))
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
      expect(field).toHaveFocus()
    })
  })
})
