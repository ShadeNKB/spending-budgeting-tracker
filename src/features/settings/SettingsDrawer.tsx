import { useCallback, useState } from 'react'
import { Wallet, Tags, Database, Cloud, Monitor, Moon, Sun, ChevronDown } from 'lucide-react'
import { Sheet } from '../../ui/Sheet'
import { Segmented } from '../../ui/Segmented'
import { useUIStore, type Theme } from '../../stores/useUIStore'
import { CURRENCIES, isSupportedCurrency } from '../../lib/format'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { DataUnavailable } from '../../app/DataNotices'
import { BackupPanel } from './BackupPanel'
import { BudgetsPanel } from './BudgetsPanel'
import { CategoriesPanel } from './CategoriesPanel'
import { SyncPanel } from './SyncPanel'
import { syncEnabled } from '../../services/syncConfig'

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
const DISPLAY_ID = 'settings-display'
const THEME_NAMES: Record<Theme, string> = { system: 'System', dark: 'Dark', light: 'Light' }

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
  const isMobile = useMediaQuery('(max-width: 767px)')
  // On a phone Theme and Currency, set once, fold into one row above the tabs: open on every
  // tab they pushed the section itself most of a screen down (F-109). Folded again on each
  // opening of the drawer.
  const [displayOpen, setDisplayOpen] = useState(false)
  const [openSeen, setOpenSeen] = useState(open)
  if (open !== openSeen) {
    setOpenSeen(open)
    if (!open) setDisplayOpen(false)
  }
  const displayShown = !isMobile || displayOpen
  // Stable: Sheet re-runs its opening focus when onClose changes, which sent focus to the close
  // button on every tab switch (and away from a control another panel asked to focus).
  const close = useCallback(() => setOpen(false), [setOpen])

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
        {isMobile && (
          <button
            type="button"
            aria-expanded={displayOpen}
            aria-controls={DISPLAY_ID}
            onClick={() => setDisplayOpen((shown) => !shown)}
            className="tap-target mb-3 flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-surface-2 px-3 text-left text-[13px]"
          >
            <span className="font-medium text-white">Display</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[var(--text-secondary)]">
              <span className="truncate">
                {THEME_NAMES[theme]} · {currency}
              </span>
              <ChevronDown
                size={15}
                aria-hidden
                className={'shrink-0 transition-transform ' + (displayOpen ? 'rotate-180' : '')}
              />
            </span>
          </button>
        )}
        <div id={DISPLAY_ID} hidden={!displayShown}>
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
                className="h-10 w-full appearance-none rounded-lg border border-white/[0.08] bg-surface-2 pl-3 pr-9 text-[13px] font-medium text-[var(--text-primary)] transition [color-scheme:dark] hover:border-white/20 [@media(pointer:coarse)]:h-11"
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
