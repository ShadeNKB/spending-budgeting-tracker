import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ClearData } from './ClearData'
import { useExpenseStore, type ExpenseView } from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'

// A demo build (VITE_DEMO_MODE): its sample rows never sync (P2-22). The flag is read once, as
// the facade loads, so this file stands in a demo build's row test for it.
vi.mock('../../stores/useExpenseStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../stores/useExpenseStore')>()
  return {
    ...real,
    isOwnRow: (e: { readonly id: string }) => !e.id.startsWith(real.SAMPLE_ID_PREFIX),
  }
})

// Invented data.
const view = (id: string): ExpenseView => ({
  id,
  itemName: `Item ${id}`,
  amount: 4.5,
  category: 'Food',
  date: '2026-10-19T12:00:00',
  day: '2026-10-19',
  createdAt: '2026-10-19T04:00:00.000Z',
  ext: {},
})
const CODE = '11111111-1111-4111-8111-111111111111'

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()

function seed(own: number, sample: number, sync: boolean) {
  useExpenseStore.setState({
    expenses: [
      ...Array.from({ length: own }, (_, i) => view(`e${String(i)}`)),
      ...Array.from({ length: sample }, (_, i) => view(`demo-${String(i + 1)}`)),
    ],
    demo: sample > 0 ? 'sample' : 'none',
  })
  useSyncStore.setState({ syncId: sync ? CODE : null })
  render(<ClearData onDownloadBackup={vi.fn()} />)
}

afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpense, true)
  useSyncStore.setState(initialSync, true)
})

describe('ClearData on a demo build', () => {
  it('counts only the owner’s own rows for a delete everywhere', () => {
    seed(3, 59, true)
    expect(screen.getByRole('button', { name: 'Delete all 3 entries everywhere' })).toBeVisible()
  })

  it('offers no delete everywhere while only the sample rows are there', () => {
    seed(0, 59, true)
    expect(screen.getByRole('button', { name: 'Delete all entries everywhere' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('without sync, deletes what is on this device, the sample rows with it', () => {
    seed(3, 59, false)
    expect(screen.getByRole('button', { name: 'Delete all entries' })).not.toHaveAttribute(
      'aria-disabled',
    )
  })
})
