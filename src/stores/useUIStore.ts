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
  settingsTab: 'categories' | 'budgets' | 'backup' | 'sync'
  addSheetOpen: boolean
  hotkeysOpen: boolean
  smartInputFocused: boolean
  currency: SupportedCurrency
  theme: Theme

  pushToast: (t: Omit<Toast, 'id'>) => string
  dismissToast: (id: string) => void

  setPaletteOpen: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  setSettingsTab: (v: UIState['settingsTab']) => void
  setAddSheetOpen: (v: boolean) => void
  setHotkeysOpen: (v: boolean) => void
  setSmartInputFocused: (v: boolean) => void
  setCurrency: (v: SupportedCurrency) => void
  setTheme: (v: Theme) => void
}

export const useUIStore = create<UIState>((set) => ({
  toasts: [],
  paletteOpen: false,
  settingsOpen: false,
  settingsTab: 'categories',
  addSheetOpen: false,
  hotkeysOpen: false,
  smartInputFocused: false,
  currency: readCurrency(),
  theme: readTheme(),

  pushToast: (t) => {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  setPaletteOpen: (v) => set({ paletteOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setSettingsTab: (v) => set({ settingsTab: v }),
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
