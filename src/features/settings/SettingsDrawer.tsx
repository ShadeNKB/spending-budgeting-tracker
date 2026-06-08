import { useEffect, useRef, useState } from 'react'
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
  Check,
  X,
  Smartphone,
  Monitor,
  AlertTriangle,
} from 'lucide-react'
import { Sheet } from '../../ui/Sheet'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Pill } from '../../ui/Pill'
import { useUIStore } from '../../stores/useUIStore'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { formatMoney } from '../../lib/format'
import { downloadJSON, downloadCSV } from '../../lib/download'
import { colorFromString } from '../../lib/analytics'
import type { BackupData } from '../../types'

type Tab = 'categories' | 'budgets' | 'backup'

export function SettingsDrawer() {
  const open = useUIStore((s) => s.settingsOpen)
  const setOpen = useUIStore((s) => s.setSettingsOpen)
  const tab = useUIStore((s) => s.settingsTab) as Tab
  const setTab = useUIStore((s) => s.setSettingsTab)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return (
    <Sheet
      open={open}
      onClose={() => setOpen(false)}
      title="Settings"
      side={isMobile ? 'bottom' : 'right'}
      width={460}
    >
      <div className="px-5 pb-2 pt-4">
        <div className="flex w-full items-center gap-1 rounded-full border border-white/[0.06] bg-surface-1 p-1">
          {(
            [
              ['categories', Tags, 'Categories'],
              ['budgets', Wallet, 'Budgets'],
              ['backup', Database, 'Backup'],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              type="button"
              key={key}
              onClick={() => setTab(key)}
              className={
                'inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition ' +
                (tab === key
                  ? 'bg-accent/12 text-accent shadow-[inset_0_0_0_1px_rgba(34,211,238,0.18)]'
                  : 'text-[var(--text-secondary)] hover:text-white')
              }
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {tab === 'categories' && <CategoriesPanel />}
        {tab === 'budgets' && <BudgetsPanel />}
        {tab === 'backup' && <BackupPanel />}
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
  const toast = useToast()
  const [newCat, setNewCat] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const counts = categories.reduce<Record<string, number>>((acc, c) => {
    acc[c] = expenses.filter((e) => e.category === c).length
    return acc
  }, {})

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
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
        {categories.map((c) => (
          <li
            key={c}
            className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-2.5"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: colorFromString(c) }}
            />
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
              className="min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none"
            />
            <Pill tone="default">{counts[c] ?? 0}</Pill>
            {confirmDelete === c ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    remove(c)
                    setConfirmDelete(null)
                    toast.info('Category deleted')
                  }}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-negative/10 text-negative transition hover:bg-negative/20"
                  title="Confirm delete"
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-surface-2"
                  title="Cancel"
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(c)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-negative/10 hover:text-negative"
                title="Delete category"
              >
                <Trash2 size={13} />
              </button>
            )}
          </li>
        ))}
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

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--text-tertiary)]">
        Set a monthly cap for categories you want to track against.
      </p>
      <ul className="flex flex-col gap-1.5">
        {categories.map((c) => {
          const current = budgets[c]
          return (
            <li
              key={c}
              className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-2"
            >
              <span className="h-2 w-2 rounded-full" style={{ background: colorFromString(c) }} />
              <span className="flex-1 text-[13px] text-white">{c}</span>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[var(--text-tertiary)]">$</span>
                <input
                  key={`${c}-${current ?? 'none'}`}
                  type="number"
                  inputMode="decimal"
                  defaultValue={current ?? ''}
                  aria-label={`Monthly budget for ${c}`}
                  placeholder="—"
                  className="h-8 w-24 rounded-md border border-white/[0.06] bg-surface-2 px-2 text-right font-mono text-[13px] tabular-nums text-white outline-none [color-scheme:dark] focus:border-accent/60"
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value)
                    if (Number.isFinite(v) && v > 0) {
                      setBudget(c, v)
                      toast.success(`${c}: ${formatMoney(v)} budget set`)
                    } else if (e.target.value === '' && current != null) {
                      removeBudget(c)
                      toast.info(`Budget cleared`)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
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
  const [pendingImport, setPendingImport] = useState<{ data: BackupData; count: number } | null>(
    null,
  )
  const [confirmClear, setConfirmClear] = useState(false)

  const exportJson = () => {
    downloadJSON(`spendtrack-backup-${format(new Date(), 'yyyy-MM-dd')}.json`, exportBackup())
    toast.success('Backup downloaded')
  }

  const escapeCsvField = (value: string | number | undefined) => {
    const raw = String(value ?? '')
    return `"${raw.replace(/"/g, '""')}"`
  }

  const exportCsv = () => {
    const headers = ['Date', 'Item', 'Category', 'Amount', 'Notes']
    const rows = expenses.map((e) =>
      [format(new Date(e.date), 'yyyy-MM-dd'), e.itemName, e.category, e.amount, e.notes]
        .map(escapeCsvField)
        .join(','),
    )
    const csv = [headers.join(','), ...rows].join('\n')
    downloadCSV(`spendtrack-${format(new Date(), 'yyyy-MM-dd')}.csv`, csv)
    toast.success('CSV exported')
  }

  const MAX_IMPORT_BYTES = 8 * 1024 * 1024 // 8 MB safety cap
  const MAX_IMPORT_EXPENSES = 50_000 // sanity cap to avoid freezing the browser

  const onFile = (f: File) => {
    if (f.size > MAX_IMPORT_BYTES) {
      toast.error(`File too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Max 8 MB.`)
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const raw = JSON.parse(e.target!.result as string) as Partial<BackupData>
        if (!raw || typeof raw !== 'object') throw new Error('not an object')
        if (!Array.isArray(raw.expenses)) throw new Error('missing expenses[]')
        if (raw.expenses.length > MAX_IMPORT_EXPENSES) {
          toast.error(
            `Backup has ${raw.expenses.length.toLocaleString()} entries — too large to import safely.`,
          )
          return
        }
        // Shallow schema validation on every expense — reject anything that
        // would corrupt analytics/sync downstream.
        for (const x of raw.expenses) {
          if (!x || typeof x !== 'object') throw new Error('malformed expense')
          if (typeof x.id !== 'string' || !x.id) throw new Error('missing id')
          if (typeof x.itemName !== 'string') throw new Error('missing itemName')
          if (typeof x.amount !== 'number' || !Number.isFinite(x.amount) || x.amount <= 0) {
            throw new Error(`bad amount on "${x.itemName ?? x.id}"`)
          }
          if (typeof x.date !== 'string') throw new Error('missing date')
          if (typeof x.category !== 'string') throw new Error('missing category')
        }
        const data: BackupData = {
          expenses: raw.expenses,
          categories: Array.isArray(raw.categories) ? raw.categories : [],
          categoryMappings: (raw.categoryMappings ?? {}) as BackupData['categoryMappings'],
          budgets: (raw.budgets ?? {}) as BackupData['budgets'],
          budgetUpdatedAt: (raw.budgetUpdatedAt ?? {}) as BackupData['budgetUpdatedAt'],
          budgetDeletedAt: (raw.budgetDeletedAt ?? {}) as BackupData['budgetDeletedAt'],
          deletedIds: Array.isArray(raw.deletedIds) ? raw.deletedIds : [],
          exportDate:
            typeof raw.exportDate === 'string' ? raw.exportDate : new Date().toISOString(),
          version: typeof raw.version === 'string' ? raw.version : '4.0',
        }
        setPendingImport({ data, count: data.expenses.length })
      } catch (err) {
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
    toast.success(`Imported ${pendingImport.count} expenses`)
    setPendingImport(null)
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
        <div className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/[0.07] p-4">
          <div>
            <div className="text-[13px] font-semibold text-white">
              Import {pendingImport.count} expenses?
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--text-tertiary)]">
              This will replace all current data. This cannot be undone.
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={confirmImport} variant="primary" className="flex-1">
              Confirm import
            </Button>
            <Button onClick={() => setPendingImport(null)} variant="ghost" className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      )}

      <Button onClick={exportJson} variant="primary">
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
      <Button onClick={() => fileRef.current?.click()} variant="ghost">
        <Upload size={14} /> Import JSON backup
      </Button>

      <div className="mt-1 border-t border-white/[0.06] pt-3">
        {confirmClear ? (
          <div className="flex flex-col gap-3 rounded-lg border border-negative/30 bg-negative/[0.07] p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-negative" />
              <div>
                <div className="text-[13px] font-semibold text-white">
                  Delete all {expenses.length} expenses?
                </div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
                  This permanently removes all locally stored expense data. Your categories,
                  budgets, and settings are kept.{' '}
                  <strong className="text-white/60">This cannot be undone.</strong>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  clearAllExpenses()
                  setConfirmClear(false)
                  toast.info('All expenses cleared')
                }}
                variant="primary"
                className="flex-1 border-transparent !bg-negative/80 hover:!bg-negative"
              >
                Yes, delete all
              </Button>
              <Button onClick={() => setConfirmClear(false)} variant="ghost" className="flex-1">
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            onClick={() => setConfirmClear(true)}
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
