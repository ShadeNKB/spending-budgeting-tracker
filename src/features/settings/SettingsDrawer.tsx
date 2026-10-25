import { useCallback, useEffect, useRef, useState } from 'react'
import { format } from 'date-fns'
import {
  Plus,
  Trash2,
  Download,
  Upload,
  FileDown,
  Wallet,
  Tags,
  Database,
  Cloud,
  Check,
  X,
  Smartphone,
  Monitor,
  Moon,
  Sun,
  ChevronDown,
  AlertTriangle,
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
import { useExpenseStore } from '../../stores/useExpenseStore'
import { SyncPanel } from './SyncPanel'
import { syncEnabled } from '../../services/syncConfig'
import { useToast } from '../../hooks/useToast'
import { useCurrencySymbol, useFormatMoney } from '../../hooks/useFormatMoney'
import { downloadJSON, downloadCSV } from '../../lib/download'
import { expensesToCsv } from '../../lib/csv'
import { colorFromString } from '../../lib/analytics'
import { BackupTooLargeError, parseBackup } from '../../lib/backup'
import type { BackupData } from '../../types'

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
  const panelIsText = (tab === 'sync' && !syncEnabled) || (tab === 'budgets' && noCategories)

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
          </p>
        </div>
        {/* Icons only on a phone, so each tab is named by aria-label. 36 px tall inside the 4 px
            track: a 44 px touch area that stays within it. */}
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
              aria-label={label}
              title={label}
              className={
                'tap-target inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-[12px] font-medium transition sm:px-3 ' +
                (tab === key
                  ? 'bg-accent/12 text-accent shadow-[inset_0_0_0_1px_rgba(34,211,238,0.18)]'
                  : 'text-[var(--text-secondary)] hover:text-white')
              }
            >
              <Icon size={13} aria-hidden />
              <span className="hidden sm:inline">{label}</span>
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
        {tab === 'categories' && <CategoriesPanel />}
        {tab === 'budgets' && <BudgetsPanel />}
        {tab === 'backup' && <BackupPanel />}
        {tab === 'sync' && <SyncPanel />}
      </div>
    </Sheet>
  )
}

function CategoriesPanel() {
  const categories = useExpenseStore((s) => s.categories)
  const expenses = useExpenseStore((s) => s.expenses)
  const add = useExpenseStore((s) => s.addCategory)
  const rename = useExpenseStore((s) => s.renameCategory)
  const remove = useExpenseStore((s) => s.removeCategory)
  const budgets = useExpenseStore((s) => s.budgets)
  const toast = useToast()
  const [newCat, setNewCat] = useState('')
  const confirm = useInlineConfirm<string>()

  // A Map: a category may be named "__proto__" or "constructor".
  const counts = new Map(
    categories.map((c) => [c, expenses.filter((e) => e.category === c).length]),
  )

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
              if (e.key === 'Enter' && newCat.trim()) {
                add(newCat.trim())
                setNewCat('')
                toast.success('Category added')
              }
            }}
          />
        </div>
        <Button
          className="shrink-0"
          onClick={() => {
            if (newCat.trim()) {
              add(newCat.trim())
              setNewCat('')
              toast.success('Category added')
            }
          }}
        >
          <Plus size={14} /> Add
        </Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {categories.map((c, index) => {
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
              {confirm.pending === c ? (
                <InlineConfirm
                  layout="row"
                  question={`Delete ${c}?`}
                  detail={
                    // Its expenses are refiled to Other (deleting Other itself leaves them be).
                    (count === 0
                      ? 'No expenses use it'
                      : c === 'Other'
                        ? `${count} ${noun} ${one ? 'stays' : 'stay'} in Other`
                        : `${count} ${noun} ${one ? 'moves' : 'move'} to Other`) +
                    (Object.hasOwn(budgets, c) ? ' · its budget goes too' : '')
                  }
                  confirmLabel={<Check size={14} aria-hidden />}
                  confirmName={`Delete category ${c}`}
                  cancelLabel={<X size={14} aria-hidden />}
                  cancelName={`Keep ${c}`}
                  onConfirm={() => {
                    // Focus moves on to the row that takes this one's place.
                    const next = categories[index + 1] ?? categories[index - 1]
                    remove(c)
                    toast.info('Category deleted')
                    confirm.close(next === undefined ? ADD_CATEGORY_ID : confirm.triggerId(next))
                  }}
                  onCancel={() => confirm.close()}
                />
              ) : (
                <>
                  <input
                    aria-label={`Rename category ${c}`}
                    defaultValue={c}
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      if (v && v !== c) {
                        rename(c, v)
                        toast.success('Renamed')
                      }
                    }}
                    className="-mx-1 h-9 min-w-0 flex-1 rounded-md bg-transparent px-1 text-[13px] text-white [@media(pointer:coarse)]:h-11"
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
  const setBudget = useExpenseStore((s) => s.setBudget)
  const removeBudget = useExpenseStore((s) => s.removeBudget)
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
                    const v = parseFloat(e.target.value)
                    // Leaving the field unchanged is no edit (and no toast).
                    if (v === current) return
                    if (Number.isFinite(v) && v > 0) {
                      setBudget(c, v)
                      toast.success(`${c}: ${fmt(v)} budget set`)
                    } else if (e.target.value === '' && current != null) {
                      removeBudget(c)
                      toast.info(`Budget cleared`)
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

function BackupPanel() {
  const expenses = useExpenseStore((s) => s.expenses)
  const exportBackup = useExpenseStore((s) => s.exportBackup)
  const importBackup = useExpenseStore((s) => s.importBackup)
  const clearAllExpenses = useExpenseStore((s) => s.clearAllExpenses)
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  // Sync's "Export backup" sends focus here.
  const takeFocus = useCallback((button: HTMLButtonElement | null) => {
    if (button && useUIStore.getState().takeSettingsFocus('backup-download')) button.focus()
  }, [])
  const [pendingImport, setPendingImport] = useState<{ data: BackupData; count: number } | null>(
    null,
  )
  const clearConfirm = useInlineConfirm<true>()
  /** Focus for the import question; the backup itself waits in `pendingImport`. */
  const importConfirm = useInlineConfirm<true>()

  const exportJson = () => {
    downloadJSON(`spendtrack-backup-${format(new Date(), 'yyyy-MM-dd')}.json`, exportBackup())
    toast.success('Backup downloaded')
  }

  const exportCsv = () => {
    downloadCSV(`spendtrack-${format(new Date(), 'yyyy-MM-dd')}.csv`, expensesToCsv(expenses))
    toast.success('CSV exported')
  }

  const MAX_IMPORT_BYTES = 8 * 1024 * 1024 // 8 MB safety cap

  const onFile = (f: File) => {
    if (f.size > MAX_IMPORT_BYTES) {
      toast.error(`File too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Max 8 MB.`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      try {
        if (typeof reader.result !== 'string') throw new Error('unreadable file')
        const data = parseBackup(JSON.parse(reader.result))
        setPendingImport({ data, count: data.expenses.length })
        importConfirm.ask(true)
      } catch (err) {
        if (err instanceof BackupTooLargeError) {
          toast.error(err.message)
          return
        }
        const msg = err instanceof Error ? err.message : 'parse error'
        toast.error(`Invalid backup file — ${msg}`)
      }
    }
    reader.onerror = () => toast.error('Could not read the file')
    reader.readAsText(f)
  }

  const confirmImport = () => {
    if (!pendingImport) return
    importBackup(pendingImport.data)
    toast.success(`Imported ${expenseCount(pendingImport.count)}`)
    setPendingImport(null)
    importConfirm.close()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="text-[13px] font-semibold text-white">
          {expenses.length} expenses stored locally
        </div>
        <div className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          All data lives in <strong className="text-white/70">this browser on this device</strong>.
          No account, no cloud, no sharing across devices automatically.
        </div>
        <div className="mt-1 flex flex-col gap-2">
          <div className="flex items-start gap-2 text-[12px] text-[var(--text-tertiary)]">
            <Monitor size={12} className="mt-0.5 shrink-0 text-accent/60" />
            <span>
              <strong className="text-white/70">Laptop:</strong> Use in browser, or run locally for
              full offline ownership.
            </span>
          </div>
          <div className="flex items-start gap-2 text-[12px] text-[var(--text-tertiary)]">
            <Smartphone size={12} className="mt-0.5 shrink-0 text-accent/60" />
            <span>
              <strong className="text-white/70">Phone:</strong> Open the URL in mobile browser → tap
              Share → Add to Home Screen to install as an app.
            </span>
          </div>
          <div className="flex items-start gap-2 text-[12px] text-[var(--text-tertiary)]">
            <Database size={12} className="mt-0.5 shrink-0 text-accent/60" />
            <span>
              <strong className="text-white/70">Multiple devices:</strong> Export a JSON backup
              here, then import it on the other device.
            </span>
          </div>
        </div>
      </div>

      {pendingImport && (
        <InlineConfirm
          tone="warning"
          question={`Import ${expenseCount(pendingImport.count)}?`}
          detail="This will replace all current data. This cannot be undone."
          confirmLabel="Confirm import"
          onConfirm={confirmImport}
          onCancel={() => {
            setPendingImport(null)
            importConfirm.close()
          }}
        />
      )}

      <Button ref={takeFocus} onClick={exportJson} variant="primary">
        <Download size={14} /> Download JSON backup
      </Button>
      <Button onClick={exportCsv} variant="ghost">
        <FileDown size={14} /> Export to CSV
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
      <Button
        id={importConfirm.triggerId()}
        onClick={() => fileRef.current?.click()}
        variant="ghost"
      >
        <Upload size={14} /> Import JSON backup
      </Button>

      <div className="mt-1 border-t border-white/[0.06] pt-3">
        {clearConfirm.pending ? (
          <InlineConfirm
            icon={<AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-negative" />}
            question={`Delete all ${expenseCount(expenses.length)}?`}
            detail={
              <>
                This permanently removes all locally stored expense data. Your categories, budgets,
                and settings are kept.{' '}
                <strong className="text-white/60">This cannot be undone.</strong>
              </>
            }
            confirmLabel="Yes, delete all"
            onConfirm={() => {
              clearAllExpenses()
              toast.info('All expenses cleared')
              clearConfirm.close()
            }}
            onCancel={() => clearConfirm.close()}
          />
        ) : (
          <Button
            id={clearConfirm.triggerId()}
            onClick={() => clearConfirm.ask(true)}
            variant="ghost"
            className="w-full text-negative/70 hover:!border-negative/30 hover:!bg-negative/10 hover:text-negative"
          >
            <Trash2 size={14} /> Clear all expenses
          </Button>
        )}
      </div>
    </div>
  )
}

/** "1 expense", "12 expenses". */
function expenseCount(n: number): string {
  return `${n} ${n === 1 ? 'expense' : 'expenses'}`
}
