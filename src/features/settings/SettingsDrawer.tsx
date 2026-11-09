import { useCallback, useEffect, useState } from 'react'
import {
  Plus,
  Trash2,
  Wallet,
  Tags,
  Database,
  Cloud,
  Check,
  X,
  Monitor,
  Moon,
  Sun,
  ChevronDown,
  Lock,
} from 'lucide-react'
import { Sheet } from '../../ui/Sheet'
import { Segmented } from '../../ui/Segmented'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Pill } from '../../ui/Pill'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { useInlineConfirm } from '../../hooks/useInlineConfirm'
import { useUIStore, type Theme } from '../../stores/useUIStore'
import { CURRENCIES, isSupportedCurrency } from '../../lib/format'
import { undoOutcomeMessage, useExpenseStore } from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { DataUnavailable } from '../../app/DataNotices'
import { BackupPanel } from './BackupPanel'
import { SyncPanel } from './SyncPanel'
import { syncEnabled } from '../../services/syncConfig'
import { useToast } from '../../hooks/useToast'
import { useCurrencySymbol, useFormatMoney } from '../../hooks/useFormatMoney'
import { colorFromString } from '../../lib/analytics'

const SECTIONS = [
  ['categories', Tags, 'Categories'],
  ['budgets', Wallet, 'Budgets'],
  ['backup', Database, 'Backup'],
  ['sync', Cloud, 'Sync'],
] as const

type Section = (typeof SECTIONS)[number][0]

// One Settings drawer exists at a time, so fixed ids are unique.
const tabId = (section: Section) => `settings-tab-${section}`
const panelId = (section: Section) => `settings-panel-${section}`
const ADD_CATEGORY_ID = 'settings-add-category'
/** Where a deleted category's entries go: it can be neither renamed nor deleted. */
const OTHER = 'Other'

/** Arrow keys move along the tabs (wrapping), Home and End jump to the ends. */
function sectionAfterKey(key: string, index: number): number | null {
  const count = SECTIONS.length
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function SettingsDrawer() {
  const open = useUIStore((s) => s.settingsOpen)
  const setOpen = useUIStore((s) => s.setSettingsOpen)
  const tab = useUIStore((s) => s.settingsTab)
  const setTab = useUIStore((s) => s.setSettingsTab)
  const currency = useUIStore((s) => s.currency)
  const setCurrency = useUIStore((s) => s.setCurrency)
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)
  // The currency is one setting for every synced device (P2-11).
  const synced = useSyncStore((s) => s.syncId !== null)
  const [isMobile, setIsMobile] = useState(false)
  // Stable: Sheet re-runs its opening focus when onClose changes, which sent focus to the close
  // button on every tab switch (and away from a control another panel asked to focus).
  const close = useCallback(() => setOpen(false), [setOpen])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  // Tab from the tabs lands in the chosen section: on its first control, or on the panel itself
  // when the section is text only (Sync without a relay, Budgets without categories).
  const noCategories = useExpenseStore((s) => s.categories.length === 0)
  // The data tabs need the data: until it has loaded (or when it never will) they say so.
  const data = useExpenseStore((s) =>
    s.bootError !== null ? 'failed' : s.hydrated ? 'ready' : 'loading',
  )
  const dataTab = tab !== 'sync'
  const panelIsText =
    (tab === 'sync' && !syncEnabled) ||
    (tab === 'budgets' && noCategories) ||
    (dataTab && data === 'loading')

  // Tabs with automatic activation: the arrow keys switch the section as they move focus. With a
  // modifier the key is the browser's or the system's (Alt+Left is Back).
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const next = SECTIONS[sectionAfterKey(e.key, index) ?? -1]
    if (!next) return
    e.preventDefault()
    setTab(next[0])
    document.getElementById(tabId(next[0]))?.focus()
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Settings"
      side={isMobile ? 'bottom' : 'right'}
      width={460}
    >
      <div className="px-5 pb-2 pt-4">
        <div className="mb-3 flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
            Theme
          </span>
          <Segmented<Theme>
            value={theme}
            onChange={setTheme}
            label="Theme"
            fullWidth
            options={[
              {
                value: 'system',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <Monitor size={13} /> System
                  </span>
                ),
              },
              {
                value: 'dark',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <Moon size={13} /> Dark
                  </span>
                ),
              },
              {
                value: 'light',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <Sun size={13} /> Light
                  </span>
                ),
              },
            ]}
          />
        </div>
        <div className="mb-4 flex flex-col gap-1.5">
          <label
            htmlFor="currency-select"
            className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]"
          >
            Currency
          </label>
          <div className="relative">
            <select
              id="currency-select"
              aria-describedby="currency-hint"
              value={currency}
              onChange={(e) => {
                const next = e.target.value
                if (isSupportedCurrency(next)) setCurrency(next)
              }}
              className="h-10 w-full appearance-none rounded-lg border border-white/[0.08] bg-surface-2 pl-3 pr-9 text-[13px] font-medium text-[var(--text-primary)] transition [color-scheme:dark] hover:border-white/[0.14] [@media(pointer:coarse)]:h-11"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={15}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
          </div>
          <p id="currency-hint" className="text-[12px] text-[var(--text-tertiary)]">
            Changes the symbol only — amounts aren't converted.
            {synced && ' Applies on all your synced devices.'}
          </p>
        </div>
        {/* Every tab shows its name (F-109): on a phone under its icon, as in the tab bar, so
            four fit at 320 px. 36 px tall inside the 4 px track: a 44 px touch area that stays
            within it. */}
        <div
          role="tablist"
          aria-label="Settings sections"
          className="flex w-full items-center gap-1 rounded-full border border-white/[0.06] bg-surface-1 p-1"
        >
          {SECTIONS.map(([key, Icon, label], index) => (
            <button
              type="button"
              role="tab"
              key={key}
              id={tabId(key)}
              aria-selected={tab === key}
              aria-controls={panelId(key)}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              className={
                'tap-target inline-flex h-9 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-medium leading-none transition sm:flex-row sm:gap-1.5 sm:px-3 sm:text-[12px] ' +
                (tab === key
                  ? 'bg-accent/12 text-accent shadow-[inset_0_0_0_1px_rgba(34,211,238,0.18)]'
                  : 'text-[var(--text-secondary)] hover:text-white')
              }
            >
              <Icon size={13} aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* As a tab stop (text only) its ring is drawn inside it, where the sheet's scroller
          cannot cut it. WebKit reveals only the caret line of a text field that Tab lands on,
          leaving the field's bottom and ring under the sheet's edge: focus brings the whole
          control, ring included (its scroll-margin), into view. */}
      <div
        role="tabpanel"
        id={panelId(tab)}
        aria-labelledby={tabId(tab)}
        tabIndex={panelIsText ? 0 : undefined}
        onFocus={(e) => {
          e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }}
        className="focus-inset p-5"
      >
        {dataTab && data !== 'ready' ? (
          <DataUnavailable failed={data === 'failed'} />
        ) : (
          <>
            {tab === 'categories' && <CategoriesPanel />}
            {tab === 'budgets' && <BudgetsPanel />}
            {tab === 'backup' && <BackupPanel />}
            {tab === 'sync' && <SyncPanel />}
          </>
        )}
      </div>
    </Sheet>
  )
}

function CategoriesPanel() {
  const categories = useExpenseStore((s) => s.categories)
  const expenses = useExpenseStore((s) => s.expenses)
  const budgets = useExpenseStore((s) => s.budgets)
  const toast = useToast()
  const [newCat, setNewCat] = useState('')
  const confirm = useInlineConfirm<string>()
  // A rename onto a name already listed would merge the two: it is asked first (F-076).
  const merge = useInlineConfirm<{ readonly from: string; readonly to: string }>()

  // A name the store refuses (reserved, too long) is said, never dropped in silence; a name it
  // already lists changes nothing, and is said too (the text stays, to be changed).
  const addNew = () => {
    const name = newCat.trim()
    if (!name) return
    const before = useExpenseStore.getState().categories
    try {
      useExpenseStore.getState().addCategory(name)
    } catch (err) {
      toast.error(errorMessage(err))
      return
    }
    if (useExpenseStore.getState().categories === before) {
      toast.info(`"${name}" is already a category`)
      return
    }
    setNewCat('')
    toast.success('Category added')
  }

  /** The toast of a category change, with the Undo of the entry it just put on the stack. */
  const changedToast = (message: string) => {
    const entry = useExpenseStore.getState().undoStack.at(-1)
    const undoId = entry?.id.startsWith('cat-') === true ? entry.id : null
    toast.info(message, {
      undoId: undoId ?? undefined,
      action:
        undoId === null
          ? undefined
          : {
              label: 'Undo',
              onClick: () => {
                const outcome = useExpenseStore.getState().consumeUndo(undoId)
                if (outcome !== null && outcome.skipped > 0) {
                  toast.warning(undoOutcomeMessage(outcome))
                }
              },
            },
    })
  }

  // A rename onto a name that is listed already merges the two (its entries, budget and item
  // picks move). A blur (a tap anywhere else) must not do that by accident: it asks first, in
  // the row, and Keep leaves the name as it was. Either way the toast has an Undo.
  const rename = (from: string, to: string): boolean => {
    const merging = useExpenseStore.getState().categories.includes(to)
    try {
      useExpenseStore.getState().renameCategory(from, to)
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    }
    changedToast(merging ? `Merged "${from}" into "${to}"` : 'Renamed')
    return true
  }
  const renameTo = (field: HTMLInputElement, from: string) => {
    const to = field.value.trim()
    if (!to || to === from) {
      field.value = from
      return
    }
    if (useExpenseStore.getState().categories.includes(to)) {
      merge.ask({ from, to }, from)
      return
    }
    if (!rename(from, to)) field.value = from
  }

  const removeOne = (name: string) => {
    try {
      useExpenseStore.getState().removeCategory(name)
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    }
    changedToast('Category deleted')
    return true
  }

  // A Map: a category may be named "__proto__" or "constructor".
  const counts = new Map(
    categories.map((c) => [c, expenses.filter((e) => e.category === c).length]),
  )
  // Focus after a delete moves along the rows that can be deleted (Other cannot).
  const deletable = categories.filter((c) => c !== OTHER)

  return (
    <div className="flex flex-col gap-3">
      {/* The field gives way on a narrow screen (a field's own minimum width would push "Add"
          out of the sheet at 320 px); the button keeps its size. */}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={ADD_CATEGORY_ID}
            label="Add category"
            placeholder="e.g. Gifts"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addNew()
            }}
          />
        </div>
        <Button className="shrink-0" onClick={addNew}>
          <Plus size={14} /> Add
        </Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {categories.map((c) => {
          const count = counts.get(c) ?? 0
          const one = count === 1
          const noun = one ? 'expense' : 'expenses'
          return (
            <li
              key={c}
              className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-1.5"
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: colorFromString(c) }}
              />
              {merge.pending?.from === c ? (
                <InlineConfirm
                  layout="row"
                  tone="warning"
                  question={`Merge into ${merge.pending.to}?`}
                  detail={
                    (count === 0
                      ? `${c} has no expenses`
                      : `${count.toLocaleString()} ${noun} ${one ? 'moves' : 'move'} to ${merge.pending.to}`) +
                    (Object.hasOwn(budgets, c) ? ` · ${c}'s budget goes too` : '')
                  }
                  confirmLabel={<Check size={14} aria-hidden />}
                  confirmName={`Merge ${c} into ${merge.pending.to}`}
                  cancelLabel={<X size={14} aria-hidden />}
                  cancelName={`Keep ${c}`}
                  onConfirm={() => {
                    const { to } = merge.pending ?? { to: c }
                    // Focus goes on to the row it merged into (Other has no field: Add, then).
                    merge.close(
                      rename(c, to)
                        ? to === OTHER
                          ? ADD_CATEGORY_ID
                          : merge.triggerId(to)
                        : undefined,
                    )
                  }}
                  onCancel={() => merge.close()}
                />
              ) : confirm.pending === c ? (
                <InlineConfirm
                  layout="row"
                  question={`Delete ${c}?`}
                  detail={
                    // Its expenses are refiled to Other.
                    (count === 0
                      ? 'No expenses use it'
                      : `${count.toLocaleString()} ${noun} ${one ? 'moves' : 'move'} to Other`) +
                    (Object.hasOwn(budgets, c) ? ' · its budget goes too' : '')
                  }
                  confirmLabel={<Check size={14} aria-hidden />}
                  confirmName={`Delete category ${c}`}
                  cancelLabel={<X size={14} aria-hidden />}
                  cancelName={`Keep ${c}`}
                  onConfirm={() => {
                    // Focus moves on to the row that takes this one's place.
                    const at = deletable.indexOf(c)
                    const next = deletable[at + 1] ?? deletable[at - 1]
                    if (!removeOne(c)) {
                      confirm.close()
                      return
                    }
                    confirm.close(next === undefined ? ADD_CATEGORY_ID : confirm.triggerId(next))
                  }}
                  onCancel={() => confirm.close()}
                />
              ) : c === OTHER ? (
                <>
                  {/* As tall as a rename field, so every row lines up. */}
                  <span className="flex h-9 min-w-0 flex-1 items-center text-[13px] text-white [@media(pointer:coarse)]:h-11">
                    {c}
                    <span className="sr-only">: deleted categories' entries go here</span>
                  </span>
                  <Pill tone="default">
                    {count}
                    <span className="sr-only"> {noun}</span>
                  </Pill>
                  <span
                    aria-hidden
                    title="Other holds the entries of deleted categories, so it stays"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-tertiary)]"
                  >
                    <Lock size={12} />
                  </span>
                </>
              ) : (
                <>
                  {/* Renames as focus leaves it, or on Return. The dashed rule marks it as a field
                      on a touch screen, where there is no hover to show it. */}
                  <input
                    id={merge.triggerId(c)}
                    aria-label={`Rename category ${c}`}
                    defaultValue={c}
                    enterKeyHint="done"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
                    }}
                    onBlur={(e) => {
                      renameTo(e.target, c)
                    }}
                    className="-mx-1 h-9 min-w-0 flex-1 rounded-none border-b border-dashed border-white/[0.14] bg-transparent px-1 text-[13px] text-white transition-colors hover:border-white/30 focus:border-accent/60 [@media(pointer:coarse)]:h-11"
                  />
                  <Pill tone="default">
                    {count}
                    <span className="sr-only"> {noun}</span>
                  </Pill>
                  <button
                    type="button"
                    id={confirm.triggerId(c)}
                    onClick={() => confirm.ask(c, c)}
                    aria-label={`Delete category ${c}`}
                    title={`Delete category ${c}`}
                    className="tap-target inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-negative/10 hover:text-negative"
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function BudgetsPanel() {
  const categories = useExpenseStore((s) => s.categories)
  const budgets = useExpenseStore((s) => s.budgets)
  const toast = useToast()
  const fmt = useFormatMoney()
  const symbol = useCurrencySymbol()

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--text-tertiary)]">
        Set a monthly cap for categories you want to track against.
      </p>
      <ul className="flex flex-col gap-1.5">
        {categories.map((c) => {
          // Own keys only: a category named "constructor" has no budget of Object's.
          const current = Object.hasOwn(budgets, c) ? budgets[c] : undefined
          return (
            <li
              key={c}
              className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-2 [@media(pointer:coarse)]:py-1"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ background: colorFromString(c) }}
              />
              <span className="flex-1 text-[13px] text-white">{c}</span>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[var(--text-tertiary)]">{symbol}</span>
                <input
                  key={`${c}-${current ?? 'none'}`}
                  type="number"
                  inputMode="decimal"
                  defaultValue={current ?? ''}
                  aria-label={`Monthly budget for ${c}`}
                  placeholder="—"
                  // Wider and 44 px tall on touch screens, where the text is floored at 16 px
                  // (index.css, against iOS focus zoom): 9 characters (123456.78) still fit.
                  className="h-8 w-24 rounded-md border border-white/[0.06] bg-surface-2 px-2 text-right font-mono text-[13px] tabular-nums text-white [color-scheme:dark] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-28"
                  onBlur={(e) => {
                    const field = e.target
                    // A number field reads "" for what it cannot parse ("12,50" in some
                    // browsers): a typo to refuse, never an emptied field that clears the
                    // budget (F-114).
                    if (field.validity.badInput) {
                      field.value = current === undefined ? '' : String(current)
                      toast.error('Enter the budget as a number, like 250 or 99.50.')
                      return
                    }
                    const raw = field.value.trim()
                    const store = useExpenseStore.getState()
                    try {
                      if (raw === '') {
                        // An empty field clears the budget; leaving it empty is no edit.
                        if (current === undefined) return
                        store.removeBudget(c)
                        toast.info('Budget cleared')
                        return
                      }
                      const v = Number(raw)
                      // Leaving the field unchanged is no edit (and no toast).
                      if (v === current) return
                      // 0, a negative or a too-large cap is refused by the store, with its reason.
                      store.setBudget(c, v)
                      toast.success(`${c}: ${fmt(v)} budget set`)
                    } catch (err) {
                      // The store kept the budget it had: so does the field.
                      field.value = current === undefined ? '' : String(current)
                      toast.error(errorMessage(err))
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** What an action that refused its input said (P2-13). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "That didn't work. Nothing was changed."
}
