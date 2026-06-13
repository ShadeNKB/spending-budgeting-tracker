import { create } from 'zustand'

export interface Toast {
  id: string
  kind: 'success' | 'error' | 'info' | 'warning'
  message: string
  action?: { label: string; onClick: () => void }
  duration?: number
}

const CURRENCY_KEY = 'spendtrack:currency'

export const SUPPORTED_CURRENCIES = [
  { code: 'USD', label: 'USD — $' },
  { code: 'SGD', label: 'SGD — S$' },
  { code: 'EUR', label: 'EUR — €' },
  { code: 'GBP', label: 'GBP — £' },
  { code: 'JPY', label: 'JPY — ¥' },
  { code: 'MYR', label: 'MYR — RM' },
  { code: 'AUD', label: 'AUD — A$' },
  { code: 'CAD', label: 'CAD — C$' },
] as const

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]['code']

function readCurrency(): string {
  try {
    return localStorage.getItem(CURRENCY_KEY) ?? 'USD'
  } catch {
    return 'USD'
  }
}

interface UIState {
  toasts: Toast[]
  paletteOpen: boolean
  settingsOpen: boolean
  settingsTab: 'categories' | 'budgets' | 'backup' | 'sync'
  addSheetOpen: boolean
  hotkeysOpen: boolean
  smartInputFocused: boolean
  currency: string

  pushToast: (t: Omit<Toast, 'id'>) => string
  dismissToast: (id: string) => void

  setPaletteOpen: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  setSettingsTab: (v: UIState['settingsTab']) => void
  setAddSheetOpen: (v: boolean) => void
  setHotkeysOpen: (v: boolean) => void
  setSmartInputFocused: (v: boolean) => void
  setCurrency: (v: string) => void
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
    try {
      localStorage.setItem(CURRENCY_KEY, v)
    } catch {}
    set({ currency: v })
  },
}))
