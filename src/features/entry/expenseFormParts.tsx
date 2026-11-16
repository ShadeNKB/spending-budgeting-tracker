import { useId, type RefObject } from 'react'
import { ChevronDown } from 'lucide-react'
import { Segmented, type SegmentedOption } from '../../ui/Segmented'
import { DatePicker } from '../../ui/DatePicker'
import { addDays, type DayKey } from '../../lib/dates'
import { chosenChipFill } from './expenseForm'
import type { EntryKind } from '../../data/core/types'

/*
 * The parts of the form the Add and Edit sheets both show, drawn the same in each. What a part
 * does with a pick is the sheet's own (see each one's props).
 */

const KINDS: SegmentedOption<EntryKind>[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'refund', label: 'Refund' },
]

/** Which way the money went: expense, income or refund. */
export function KindSwitch({
  value,
  onChange,
}: {
  value: EntryKind
  onChange: (kind: EntryKind) => void
}) {
  return (
    <div>
      <Segmented<EntryKind>
        label="Kind of entry"
        value={value}
        onChange={onChange}
        size="sm"
        options={KINDS}
      />
    </div>
  )
}

/**
 * Today, Yesterday, 2d ago and 3d ago, then the calendar ("Pick date", lit while the day is none
 * of those). They wrap rather than scroll: every one stays in sight on a narrow phone. 36 px pills
 * 8 px apart, so their 44 px touch areas meet without overlapping, row to row too.
 */
export function DatePresets({
  value,
  today,
  onChange,
  labelledBy,
}: {
  value: DayKey
  today: DayKey
  onChange: (day: DayKey) => void
  /** The id of the sheet's own visible label; without one the group is named "Date". */
  labelledBy?: string
}) {
  // Calendar days, not 24 h steps: the day after a DST change is 23 or 25 hours long.
  const presets = [
    { id: 'today', label: 'Today', val: today },
    { id: 'yesterday', label: 'Yesterday', val: addDays(today, -1) },
    { id: '-2', label: '2d ago', val: addDays(today, -2) },
    { id: '-3', label: '3d ago', val: addDays(today, -3) },
  ]
  const isPreset = presets.some((p) => p.val === value)
  return (
    <div
      role="group"
      aria-label={labelledBy === undefined ? 'Date' : undefined}
      aria-labelledby={labelledBy}
      className="flex flex-wrap items-center gap-2"
    >
      {presets.map((p) => (
        <button
          type="button"
          key={p.id}
          aria-pressed={value === p.val}
          onClick={() => onChange(p.val)}
          className={`tap-target inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition ${
            value === p.val
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-white/[0.08] text-[var(--text-secondary)] hover:border-white/20 hover:text-white'
          }`}
        >
          {p.label}
        </button>
      ))}
      {/* The calendar opens on the entry's day, a preset's too ("Pick date" then). */}
      <DatePicker
        variant="pill"
        value={value}
        onChange={(v) => {
          onChange(v || today)
        }}
        max={today}
        placeholder="Pick date"
        active={!isPreset}
      />
    </div>
  )
}

/**
 * The Category label and its chips: the first eight categories, then the rest in a "More…" chip.
 * A chip tapped again goes back to `clearTo`. `onChange` gets each pick as it is, the "More…"
 * option's empty value included: the sheet decides what that means.
 */
export function CategoryChips({
  categories,
  value,
  clearTo,
  onChange,
  refund,
  suggestion = null,
  error,
  groupRef,
}: {
  categories: readonly string[]
  value: string
  /** The Add sheet's no category (`''`); the Edit sheet's Other, as an entry always has one. */
  clearTo: string
  onChange: (category: string) => void
  /** A refund's category is the one it comes off, and the label says so. */
  refund: boolean
  /** The category the Add sheet would file the entry under when none is picked. */
  suggestion?: string | null
  /** Said under the chips, and the group is described by it. */
  error?: string
  /** The Add sheet focuses the first chip when a refund is sent with no category. */
  groupRef?: RefObject<HTMLDivElement | null>
}) {
  const labelId = useId()
  const errorId = useId()
  const more = categories.slice(8)
  const shown = value || suggestion || ''
  return (
    <div className="flex flex-col gap-1.5">
      <span
        id={labelId}
        className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]"
      >
        {refund ? 'Category it comes off' : 'Category'}
        {suggestion !== null && (
          <span className="normal-case tracking-normal text-[var(--text-tertiary)]">
            {' '}
            · suggested from your entries
          </span>
        )}
      </span>
      {/* 36 px chips 8 px apart: each gets a 44 px hit area on touch, none overlapping. */}
      <div
        ref={groupRef}
        role="group"
        aria-labelledby={labelId}
        aria-describedby={error === undefined ? undefined : errorId}
        className="flex flex-wrap gap-2"
      >
        {categories.slice(0, 8).map((c) => {
          const selected = value === c
          return (
            <button
              type="button"
              key={c}
              aria-pressed={selected}
              // Named as suggested, in one piece (a hidden span beside the text is read with a
              // stray space before its comma).
              aria-label={suggestion === c ? `${c}, suggested` : undefined}
              onClick={() => onChange(selected ? clearTo : c)}
              className={`tap-target inline-flex h-9 items-center gap-1 rounded-full border px-3 text-[12px] font-medium transition ${
                selected
                  ? 'border-transparent text-surface-0'
                  : suggestion === c
                    ? 'border-dashed text-white'
                    : 'border-white/[0.08] text-[var(--text-secondary)] hover:text-white'
              }`}
              style={
                selected
                  ? { background: chosenChipFill(c) }
                  : suggestion === c
                    ? { borderColor: chosenChipFill(c) }
                    : undefined
              }
            >
              {c}
            </button>
          )
        })}
        {more.length > 0 && (
          // A chip like its neighbours: the 12 px label is drawn here, and the native select sits
          // invisibly on top to take the tap (8 px taller on touch: a 44 px target). Touch screens
          // floor the select's own text at 16 px (index.css, against iOS focus zoom), which would
          // make this chip bigger than the rest. The chip draws the select's focus ring.
          <div className="field-focus relative inline-flex h-9 max-w-full items-center rounded-full border border-white/[0.08] bg-surface-2 pl-3 pr-6 text-[12px] text-[var(--text-secondary)]">
            <span aria-hidden className="min-w-0 truncate">
              {more.includes(shown) ? shown : 'More…'}
            </span>
            <select
              aria-label="More categories"
              // A chip's category is no option here: "More…" is shown, as for none.
              value={more.includes(value) ? value : ''}
              onChange={(e) => onChange(e.target.value)}
              className="field-control absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0 [@media(pointer:coarse)]:-inset-y-1 [@media(pointer:coarse)]:h-auto"
            >
              <option value="">More…</option>
              {more.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <ChevronDown
              size={10}
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
          </div>
        )}
      </div>
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-[12px] text-negative">
          {error}
        </p>
      )}
    </div>
  )
}
