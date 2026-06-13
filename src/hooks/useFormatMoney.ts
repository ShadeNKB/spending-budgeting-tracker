import { useUIStore } from '../stores/useUIStore'
import { formatMoney } from '../lib/format'

export function useFormatMoney() {
  const currency = useUIStore((s) => s.currency)
  return (n: number, opts?: Parameters<typeof formatMoney>[1]) => formatMoney(n, opts, currency)
}
