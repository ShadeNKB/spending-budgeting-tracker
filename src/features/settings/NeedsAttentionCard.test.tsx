import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NeedsAttentionCard } from './NeedsAttentionCard'
import { useExpenseStore, type Attention } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'

const initialExpense = useExpenseStore.getState()
const initialUI = useUIStore.getState()

let markAttentionSeen: ReturnType<typeof vi.fn<() => void>>
let quarantineFile: ReturnType<typeof vi.fn<() => unknown>>
/** What the download hands the browser, read back. */
let downloaded: { name: string; body: unknown }[]

function show(attention: Attention) {
  markAttentionSeen = vi.fn(() => {
    useExpenseStore.setState((s) => ({ attention: { ...s.attention, unseen: 0 } }))
  })
  quarantineFile = vi.fn(() => ({ kind: 'needs-attention', entries: [{ raw: '{"id":1' }] }))
  useExpenseStore.setState({ attention, markAttentionSeen, quarantineFile })
  return render(<NeedsAttentionCard />)
}

beforeEach(() => {
  downloaded = []
  useUIStore.setState({ toasts: [] })
  // jsdom has no object URLs: read the blob the download was made from instead.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      void blob.text().then((text) => {
        const last = downloaded.at(-1)
        if (last) last.body = JSON.parse(text)
      })
      return 'blob:x'
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded.push({ name: this.download, body: null })
  })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
  useExpenseStore.setState(initialExpense, true)
  useUIStore.setState(initialUI, true)
})

describe('NeedsAttentionCard', () => {
  it('is not there when nothing needs attention', () => {
    const { container } = show({ quarantined: 0, copies: 0, unseen: 0, full: false })
    expect(container).toBeEmptyDOMElement()
    expect(markAttentionSeen).not.toHaveBeenCalled()
  })

  it('says how many entries could not be read and that they are kept', () => {
    show({ quarantined: 2, copies: 0, unseen: 0, full: false })
    const card = screen.getByRole('region', { name: 'Needs attention' })
    expect(card).toHaveTextContent(
      "2 entries couldn't be read. They're kept on this device, untouched.",
    )
    expect(screen.getByRole('button', { name: 'Download them' })).toBeInTheDocument()
  })

  it('speaks of one entry in the singular', () => {
    show({ quarantined: 1, copies: 0, unseen: 0, full: false })
    expect(screen.getByRole('region', { name: 'Needs attention' })).toHaveTextContent(
      "1 entry couldn't be read. It's kept on this device, untouched.",
    )
    expect(screen.getByRole('button', { name: 'Download it' })).toBeInTheDocument()
  })

  // A recovered boot sets the damaged envelope aside: that is no expense, and "1 entry" read as one missing.
  it('calls a whole stored copy set aside a damaged copy of the saved data, never an entry', () => {
    show({ quarantined: 1, copies: 1, unseen: 0, full: false })
    const card = screen.getByRole('region', { name: 'Needs attention' })
    expect(card).toHaveTextContent(
      'A damaged copy of your saved data is kept on this device, untouched.',
    )
    expect(card).not.toHaveTextContent(/entry/)
  })

  it('names entries and copies apart when both are set aside', () => {
    show({ quarantined: 1_203, copies: 2, unseen: 0, full: false })
    expect(screen.getByRole('region', { name: 'Needs attention' })).toHaveTextContent(
      "1,201 entries couldn't be read, and 2 damaged copies of your saved data were set aside. All of it is kept on this device, untouched.",
    )
    expect(screen.getByRole('button', { name: 'Download them' })).toBeInTheDocument()
  })

  it('marks them seen when shown, once', () => {
    show({ quarantined: 3, copies: 0, unseen: 3, full: false })
    expect(markAttentionSeen).toHaveBeenCalledTimes(1)
    expect(useExpenseStore.getState().attention.unseen).toBe(0)
  })

  it('downloads the entries as the store keeps them', async () => {
    const user = userEvent.setup()
    show({ quarantined: 1, copies: 0, unseen: 0, full: false })
    await user.click(screen.getByRole('button', { name: 'Download it' }))
    expect(quarantineFile).toHaveBeenCalledTimes(1)
    expect(downloaded).toHaveLength(1)
    expect(downloaded[0]?.name).toMatch(/^spendtrack-needs-attention-\d{4}-\d{2}-\d{2}\.json$/)
    await vi.waitFor(() => {
      expect(downloaded[0]?.body).toEqual({
        kind: 'needs-attention',
        entries: [{ raw: '{"id":1' }],
      })
    })
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Downloaded the entry')
  })

  it('says when there is no room to keep any more', () => {
    show({ quarantined: 40, copies: 0, unseen: 0, full: true })
    expect(screen.getByRole('region', { name: 'Needs attention' })).toHaveTextContent(
      /no room to keep any more/,
    )
  })

  it('takes focus when "Review" on the toast asked for it', () => {
    useUIStore.setState({ settingsFocus: 'backup-attention' })
    show({ quarantined: 2, copies: 0, unseen: 2, full: false })
    expect(screen.getByRole('region', { name: 'Needs attention' })).toHaveFocus()
    expect(useUIStore.getState().settingsFocus).toBeNull()
  })

  it('does not take focus otherwise', () => {
    show({ quarantined: 2, copies: 0, unseen: 2, full: false })
    expect(screen.getByRole('region', { name: 'Needs attention' })).not.toHaveFocus()
  })
})
