export const formatMoney = (
  n: number,
  opts: { compact?: boolean; sign?: boolean } = {},
  currency = 'USD',
): string => {
  if (!Number.isFinite(n)) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(0)
  }
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : opts.sign && n > 0 ? '+' : ''
  if (opts.compact && abs >= 1000) {
    const sym =
      new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 0 })
        .formatToParts(1)
        .find((p) => p.type === 'currency')?.value ?? currency
    const v =
      abs >= 1_000_000
        ? (abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1) + 'M'
        : (abs / 1000).toFixed(abs >= 10_000 ? 0 : 1) + 'k'
    return `${sign}${sym}${v}`
  }
  const str = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(abs)
  return `${sign}${str}`
}

export const formatInt = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n))
