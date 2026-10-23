import { create } from 'zustand'
import { isSupportedCurrency, resolveDefaultCurrency, type SupportedCurrency } from '../lib/format'

export interface Toast {
  id: string
  kind: 'success' | 'error' | 'info' | 'warning'
  message: string
  action?: { label: string; onClick: () => void }
  duration?: number
}

const CURRENCY_KEY = 'spendtrack:currency'
const THEME_KEY = 'spendtrack:theme'

export type Theme = 'dark' | 'light' | 'system'

export type SettingsTab = 'categories' | 'budgets' | 'backup' | 'sync'
/** A control in Settings that another panel can send focus to. */
export type SettingsControl = 'backup-download'

// Preferences are best-effort: if storage is unavailable they last for this session only.
function persistPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Session-only preference.
  }
}

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function detectDefaultCurrency(): SupportedCurrency {
  let timeZone: string | undefined
  let languages: readonly string[] | undefined
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    // No Intl time zone data: rely on the languages.
  }
  try {
    languages = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  } catch {
    // No navigator (or it is blocked): rely on the time zone.
  }
  return resolveDefaultCurrency({ timeZone, languages })
}

// A stored valid choice always wins. Otherwise (first run, or a stored code outside the
// supported set) the device's currency is resolved once and persisted, so the symbol never
// changes on its own when travelling.
function readCurrency(): SupportedCurrency {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(CURRENCY_KEY)
  } catch {
    // Storage unavailable: resolve for this session.
  }
  if (isSupportedCurrency(stored)) return stored
  const resolved = detectDefaultCurrency()
  persistPreference(CURRENCY_KEY, resolved)
  return resolved
}

interface UIState {
  toasts: Toast[]
  paletteOpen: boolean
  settingsOpen: boolean
  settingsTab: SettingsTab
  /** A control that takes focus when it next mounts (asked for by another panel). */
  settingsFocus: SettingsControl | null
  addSheetOpen: boolean
  hotkeysOpen: boolean
  smartInputFocused: boolean
  currency: SupportedCurrency
  theme: Theme

  pushToast: (t: Omit<Toast, 'id'>) => string
  dismissToast: (id: string) => void

  setPaletteOpen: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  setSettingsTab: (v: SettingsTab) => void
  /** Opens `tab` with focus on `control`. */
  focusSettings: (tab: SettingsTab, control: SettingsControl) => void
  /** True once, for the control focus was asked for: it then takes focus. */
  takeSettingsFocus: (control: SettingsControl) => boolean
  setAddSheetOpen: (v: boolean) => void
  setHotkeysOpen: (v: boolean) => void
  setSmartInputFocused: (v: boolean) => void
  setCurrency: (v: SupportedCurrency) => void
  setTheme: (v: Theme) => void
}

/** Settings is open on its Sync tab, whose status row and banners say what sync is doing. */
export const syncPanelShown = (s: Pick<UIState, 'settingsOpen' | 'settingsTab'>): boolean =>
  s.settingsOpen && s.settingsTab === 'sync'

export const useUIStore = create<UIState>((set, get) => ({
  toasts: [],
  paletteOpen: false,
  settingsOpen: false,
  settingsTab: 'categories',
  settingsFocus: null,
  addSheetOpen: false,
  hotkeysOpen: false,
  smartInputFocused: false,
  currency: readCurrency(),
  theme: readTheme(),

  pushToast: (t) => {
    // The same news twice (a background failure and the owner's own retry) shows once. A toast
    // with an action is never merged: each Undo undoes its own change.
    const same = t.action
      ? undefined
      : get().toasts.find((x) => !x.action && x.kind === t.kind && x.message === t.message)
    if (same) return same.id
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  setPaletteOpen: (v) => set({ paletteOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSettingsTab: (v) => set({ settingsTab: v }),
  focusSettings: (tab, control) => set({ settingsTab: tab, settingsFocus: control }),
  takeSettingsFocus: (control) => {
    if (get().settingsFocus !== control) return false
    set({ settingsFocus: null })
    return true
  },
  setAddSheetOpen: (v) => set({ addSheetOpen: v }),
  setHotkeysOpen: (v) => set({ hotkeysOpen: v }),
  setSmartInputFocused: (v) => set({ smartInputFocused: v }),
  setCurrency: (v) => {
    persistPreference(CURRENCY_KEY, v)
    set({ currency: v })
  },
  setTheme: (v) => {
    persistPreference(THEME_KEY, v)
    set({ theme: v })
  },
}))
