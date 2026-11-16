import { useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { CalendarDays } from 'lucide-react'
import { Sheet } from '../../ui/Sheet'
import { Input } from '../../ui/Input'
import { Button } from '../../ui/Button'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { useHaptic } from '../../hooks/useHaptic'
import { useCurrencySymbol, useFormatMoney } from '../../hooks/useFormatMoney'
import { useToday } from '../../hooks/useToday'
import { formatKey, keyYear, shortDate, shortDateYear, type DayKey } from '../../lib/dates'
import { shieldKeyGesture } from '../../ui/pressShield'
import { DataUnavailable } from '../../app/DataNotices'
import {
  addAndConfirm,
  useLearnedCategory,
  firstInvalidField,
  validateExpenseForm,
  type ExpenseFormErrors,
  type ExpenseFormField,
} from './expenseForm'
import { CategoryChips, DatePresets, KindSwitch } from './expenseFormParts'
import type { EntryKind } from '../../data/core/types'
import type { ExpenseView } from '../../types'

interface Props {
  open: boolean
  onClose: () => void
  /** `date` is a day, `yyyy-MM-dd`. */
  prefill?: {
    itemName?: string
    amount?: number
    category?: string
    date?: DayKey
    notes?: string
    /** Opens the sheet on that kind (the Fix of an unreadable income or refund). */
    kind?: EntryKind
  }
  /** The entry was added (before the sheet closes): Recovery's Fix marks its row fixed. */
  onAdded?: (added: ExpenseView) => void
  /** Said after the confirmation ("Added "Kopi" · $1.80. <note>"). */
  addedNote?: string
  /** Where focus goes on close when the control that opened the sheet is gone. */
  returnFocus?: () => HTMLElement | null
}

/** What the sheet is adding, in its title and in the confirmation ("Added refund …"). */
const NOUN: Record<EntryKind, string> = { expense: 'expense', income: 'income', refund: 'refund' }

const PLACEHOLDER: Record<EntryKind, string> = {
  expense: 'e.g. Coffee, Grab, Spotify',
  income: 'e.g. Allowance, Pay, Sold bike',
  refund: 'e.g. Returned shoes, Dinner split',
}

function formFrom(prefill: Props['prefill'], today: string) {
  return {
    itemName: prefill?.itemName ?? '',
    amount: prefill?.amount ? String(prefill.amount) : '',
    category: prefill?.category ?? '',
    date: prefill?.date ?? today,
    notes: prefill?.notes ?? '',
  }
}

export function AddExpenseSheet({
  open,
  onClose,
  prefill,
  onAdded,
  addedNote,
  returnFocus,
}: Props) {
  const categories = useExpenseStore((s) => s.categories)
  // The data engine did not load (bootError): nothing typed here could be saved this time.
  const cantSave = useExpenseStore((s) => s.bootError !== null)
  const toast = useToast()
  const vibrate = useHaptic()
  const fmt = useFormatMoney()
  const symbol = useCurrencySymbol()
  const categoryGroup = useRef<HTMLDivElement>(null)
  const fields: Record<ExpenseFormField, React.RefObject<HTMLInputElement | null>> = {
    itemName: useRef<HTMLInputElement>(null),
    amount: useRef<HTMLInputElement>(null),
  }

  const today = useToday()
  // "Oct 17", or "Dec 31, 2025" for another year — read from the key, never through `new Date(key)`
  // (UTC midnight, the day before west of UTC).
  const dayLabel = (day: DayKey) =>
    keyYear(day) === keyYear(today) ? shortDate(day) : shortDateYear(day)

  const [form, setForm] = useState(() => formFrom(prefill, today))
  const [errors, setErrors] = useState<ExpenseFormErrors>({})
  // Income and refunds (F-058) are added from the same sheet: an expense every time it opens,
  // unless what opened it says otherwise.
  const [kind, setKind] = useState<EntryKind>(prefill?.kind ?? 'expense')
  const income = kind === 'income'
  const refund = kind === 'refund'
  // A refund was sent with no category to come off (see `submit`): said at the chips.
  const [needsCategory, setNeedsCategory] = useState(false)

  // Refill the form each time the sheet opens (SmartInput passes what was typed as a prefill),
  // and only then: refilling on later prefill or date changes would wipe what the user typed.
  // Done while rendering, not in an effect. The sheet often mounts already open (on its first
  // tap, once its chunk has loaded), and an effect after that render runs once the form is on
  // screen, where it could wipe the first keystrokes.
  const [openSeen, setOpenSeen] = useState(open)
  if (open !== openSeen) {
    setOpenSeen(open)
    if (open) {
      setForm(formFrom(prefill, today))
      setErrors({})
      setKind(prefill?.kind ?? 'expense')
      setNeedsCategory(false)
    }
  }

  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (k === 'itemName' || k === 'amount') setErrors((e) => ({ ...e, [k]: undefined }))
    // a pick answers it; a new name may bring a suggestion that does
    if (k === 'category' || k === 'itemName') setNeedsCategory(false)
  }

  // The category the app files the entry under when none is picked: the same matcher as the
  // add itself (and the quick bar's), shown before Add rather than found out after it.
  const learned = useLearnedCategory(form.itemName)
  const suggestion = form.category === '' ? learned : null

  const submit = () => {
    const errs = validateExpenseForm(form, fmt)
    const invalid = firstInvalidField(errs)
    if (invalid) {
      // Mark the fields first, so the focused one is announced with its error.
      flushSync(() => {
        setErrors(errs)
      })
      fields[invalid].current?.focus()
      return
    }
    // A refund comes off a category. With none picked and none learned for its name it would
    // land in Other, take that below zero and leave the category it belongs to as it was: an
    // expense filed under Other is only unsorted, a refund there is in the wrong sum.
    if (refund && form.category === '' && suggestion === null) {
      flushSync(() => {
        setNeedsCategory(true)
      })
      categoryGroup.current?.querySelector('button')?.focus()
      return
    }
    const isBackdated = form.date !== today
    const created = addAndConfirm(
      toast,
      vibrate,
      {
        itemName: form.itemName.trim(),
        amount: parseFloat(form.amount),
        // Income is filed under no category; a refund under the one it comes off.
        ...(income ? {} : { category: form.category || undefined }),
        ...(kind === 'expense' ? {} : { kind }),
        // The picked day as it is: the store keeps it as the entry's day (P2-2).
        day: form.date,
        notes: form.notes.trim() || undefined,
      },
      (added) =>
        // a refund names the category it came off: the one figure that just moved
        `Added ${kind === 'expense' ? '' : `${NOUN[kind]} `}"${added.itemName}" · ${fmt(added.amount)}${refund ? ` · off ${added.category}` : ''}${isBackdated ? ` · ${dayLabel(form.date)}` : ''}${addedNote === undefined ? '' : `. ${addedNote}`}`,
      onAdded,
    )
    // Refused: the sheet stays open with everything typed, so the owner can fix what the
    // message names.
    if (created === null) return
    setForm({ itemName: '', amount: '', category: '', date: today, notes: '' })
    setKind('expense')
    onClose()
  }

  // Enter in What goes on to Amount while it is empty (the phone's Next key), never to an "Enter
  // a valid amount" error; anywhere else it adds. A held Enter (key repeat) or the Enter that
  // confirms an IME word does nothing, and the second Enter of a double press never lands where
  // the first one sent focus (pressShield).
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.repeat || e.nativeEvent.isComposing) return
    if (e.currentTarget === fields.itemName.current && form.amount.trim() === '') {
      e.preventDefault()
      fields.amount.current?.focus()
    } else submit()
    shieldKeyGesture(e.key)
  }

  const isBackdated = form.date && form.date !== today

  // Said as the sheet opens, before anything is typed, never only on Save (a Reload would
  // then throw away the whole form).
  if (cantSave) {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title="Add expense"
        side="bottom"
        returnFocus={returnFocus}
      >
        <div className="flex flex-col gap-3 px-4 pb-6 pt-2">
          <DataUnavailable
            failed
            detail="Nothing can be added until it does. Reload to try again: your data is still saved on this device."
          />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Add ${NOUN[kind]}`}
      side="bottom"
      returnFocus={returnFocus}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button onClick={submit} className="flex-1">
            Add{isBackdated ? ` for ${dayLabel(form.date)}` : ''}
          </Button>
        </>
      }
    >
      {/* WebKit reveals only the caret line of a text field when the sheet itself scrolls:
          focus brings the whole control, ring included (its scroll-margin), into view. */}
      <div
        onFocus={(e) => {
          e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }}
        className="flex flex-col gap-3 px-4 pb-6 pt-2"
      >
        {/* Which way the money went. Income: pay, an allowance, a sale. It is not spending, so
            it takes no category and is in no spending total. Refund: money back for something
            paid for. It is spending undone, so it takes the category it comes off (the
            Category label says so, where the choice is made). */}
        <KindSwitch
          value={kind}
          onChange={(k) => {
            setKind(k)
            setNeedsCategory(false)
          }}
        />

        {/* Date selector, named "Date" with no label of its own. The presets wrap rather than
            scroll, as in the Edit sheet. */}
        <DatePresets
          value={form.date}
          today={today}
          onChange={(day) => {
            set('date', day)
          }}
        />

        {isBackdated && (
          <div className="flex items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-[12px] text-accent">
            <CalendarDays size={12} />
            Logging for{' '}
            {formatKey(
              form.date,
              keyYear(form.date) === keyYear(today) ? 'EEEE, MMMM d' : 'EEEE, MMMM d, yyyy',
            )}
          </div>
        )}

        <Input
          ref={fields.itemName}
          label="What"
          placeholder={PLACEHOLDER[kind]}
          value={form.itemName}
          onChange={(e) => set('itemName', e.target.value)}
          error={errors.itemName}
          autoFocus
          enterKeyHint={form.amount.trim() === '' ? 'next' : 'done'}
          onKeyDown={onEnter}
        />

        <Input
          ref={fields.amount}
          label="Amount"
          type="number"
          inputMode="decimal"
          prefix={symbol}
          mono
          placeholder="0.00"
          value={form.amount}
          onChange={(e) => set('amount', e.target.value)}
          error={errors.amount}
          enterKeyHint="done"
          onKeyDown={onEnter}
        />

        {!income && (
          <CategoryChips
            categories={categories}
            value={form.category}
            clearTo=""
            onChange={(c) => {
              set('category', c)
            }}
            refund={refund}
            suggestion={suggestion}
            error={needsCategory ? 'Pick the category this refund comes off.' : undefined}
            groupRef={categoryGroup}
          />
        )}

        <Input
          label="Notes (optional)"
          placeholder="Any extra detail"
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </div>
    </Sheet>
  )
}
