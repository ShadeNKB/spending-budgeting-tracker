// The conflict toast (PR-4 track spec §3.2, acceptance 9): a merge that took over edits made here
// says so once, and its Review opens Settings › Backup › Recovery on the changes; a mass removal
// says only its own "Your other device removed N entries · Undo".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  advance,
  bootDevice,
  connect,
  expense,
  relay,
  resetRelay,
  retireDevices,
  setClientOffline,
  stubRelayEnv,
  type Device,
} from '../../__tests__/fakeRelay'
import { must } from '../../data/__tests__/support/must'
import { CONFLICT_TOAST_MS } from '../syncEngine'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const S = (d: Device) => d.expense.useExpenseStore.getState()
const UI = (d: Device) => d.ui.useUIStore.getState()

const ROWS = Array.from({ length: 30 }, (_, i) =>
  expense(`e${String(i + 1)}`, { itemName: `Lunch ${String(i + 1)}`, amount: 4 + i }),
)

async function pair() {
  const laptop = await bootDevice({ expenses: ROWS })
  relay().latency = { pull: 100, push: 100, realtime: 50 }
  const laptopClient = relay().nextClient
  await connect(laptop)
  const phone = await bootDevice({ expenses: ROWS })
  await connect(phone)
  await advance(MINUTE)
  return { laptop, phone, laptopClient }
}

const conflictToasts = (d: Device) =>
  UI(d).toasts.filter((t) => t.message.includes('also changed on your other device'))

describe('the conflict toast', () => {
  it('one warning per merge that took over edits made here; Review lands on the changes', async () => {
    const { laptop, phone, laptopClient } = await pair()
    setClientOffline(laptopClient, true)
    S(laptop).updateExpense('e1', { amount: 10 })
    S(laptop).updateExpense('e2', { notes: 'mine' })
    await advance(30_000)
    S(phone).updateExpense('e1', { amount: 99 })
    S(phone).updateExpense('e2', { notes: 'theirs' })
    await advance(MINUTE)
    setClientOffline(laptopClient, false)
    void laptop.sync.useSyncStore.getState().triggerSync()
    await advance(5000)

    const toasts = conflictToasts(laptop)
    expect(toasts).toHaveLength(1)
    const toast = toasts[0]
    if (toast === undefined) throw new Error('no toast')
    expect(toast).toMatchObject({
      kind: 'warning',
      message: '2 entries you changed here were also changed on your other device',
      duration: CONFLICT_TOAST_MS,
    })
    expect(CONFLICT_TOAST_MS).toBe(8000)
    expect(conflictToasts(phone)).toHaveLength(0)

    expect(toast.action?.label).toBe('Review')
    toast.action?.onClick()
    expect(UI(laptop)).toMatchObject({
      settingsOpen: true,
      settingsTab: 'backup',
      settingsFocus: 'recovery-changes',
    })
  })

  it('says "1 entry … was" for one', async () => {
    const { laptop, phone, laptopClient } = await pair()
    setClientOffline(laptopClient, true)
    S(laptop).updateExpense('e3', { amount: 10 })
    await advance(30_000)
    S(phone).deleteExpense('e3')
    await advance(MINUTE)
    setClientOffline(laptopClient, false)
    void laptop.sync.useSyncStore.getState().triggerSync()
    await advance(5000)
    expect(conflictToasts(laptop).map((t) => t.message)).toEqual([
      '1 entry you changed here was also changed on your other device',
    ])
  })

  it('a mass removal shows only its own Undo toast', async () => {
    const { laptop, phone, laptopClient } = await pair()
    setClientOffline(laptopClient, true)
    S(laptop).updateExpense('e1', { amount: 10 })
    await advance(30_000)
    for (const e of ROWS.slice(0, 20)) S(phone).deleteExpense(e.id)
    await advance(MINUTE)
    setClientOffline(laptopClient, false)
    void laptop.sync.useSyncStore.getState().triggerSync()
    await advance(5000)
    expect(conflictToasts(laptop)).toHaveLength(0)
    expect(UI(laptop).toasts.map((t) => t.message)).toContain(
      'Your other device removed 20 entries',
    )
  })

  it("the mass removal's Undo, pressed again, says why nothing more came back (review 4a)", async () => {
    const { laptop, phone } = await pair()
    for (const e of ROWS.slice(0, 20)) S(phone).deleteExpense(e.id)
    await advance(MINUTE)
    const undo = UI(laptop).toasts.find((t) => t.message === 'Your other device removed 20 entries')
    expect(undo?.action?.label).toBe('Undo')
    // the Undo runs in the Recovery centre's lazy chunk (a real module load)
    await S(laptop).recovery()
    /** Presses that Undo again; the toast it ends with (a restore that reads a snapshot body waits on real I/O). */
    const says = async () => {
      laptop.ui.useUIStore.setState({ toasts: [] })
      undo?.action?.onClick()
      await vi.waitFor(() => {
        expect(UI(laptop).toasts.length).toBeGreaterThan(0)
      })
      return UI(laptop).toasts.at(-1)
    }
    expect(await says()).toMatchObject({ kind: 'success', message: 'Restored 20 entries' })
    expect(await says()).toMatchObject({ kind: 'info', message: 'Those entries are already back.' })
    // one of them deleted again since: it stays deleted, and the toast says so
    const back = must(
      S(laptop).expenses.find((e) => e.id.includes('~r')),
      'revived',
    )
    S(laptop).deleteExpense(back.id)
    expect(await says()).toMatchObject({
      kind: 'info',
      message:
        'Those entries are back already or were deleted again since, so nothing was restored.',
    })
    expect(S(laptop).expenses).toHaveLength(29)
  })

  it('a merge with nothing taken over says nothing', async () => {
    const { laptop, phone } = await pair()
    S(phone).updateExpense('e4', { amount: 7 })
    await advance(MINUTE)
    expect(S(laptop).expenses.find((e) => e.id === 'e4')?.amount).toBe(7)
    expect(conflictToasts(laptop)).toHaveLength(0)
  })
})
