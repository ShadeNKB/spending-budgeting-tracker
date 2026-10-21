import { useCallback } from 'react'
import { useUIStore } from '../stores/useUIStore'
import { currencySymbol, formatMoney, type MoneyOptions } from '../lib/format'

/** `formatMoney` bound to the selected currency; its identity changes only with the currency. */
export function useFormatMoney() {
  const currency = useUIStore((s) => s.currency)
  return useCallback((n: number, opts?: MoneyOptions) => formatMoney(n, opts, currency), [currency])
}

/** The selected currency's symbol, for amount-input prefixes (`S$`, `¥`). */
export function useCurrencySymbol(): string {
  return currencySymbol(useUIStore((s) => s.currency))
}
