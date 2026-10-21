/**
 * The one money module. Every amount on screen goes through `formatMoney` (or the
 * `useFormatMoney` hook that binds it to the chosen currency), so the symbol, the
 * fraction digits and the rounding are identical on every surface.
 *
 * Output is `sign + symbol + number`, for example `S$1,234.50`, `-¥1,500`, `+€4.20`.
 * The symbol comes from the table below rather than from `Intl` (en-US renders SGD as
 * `SGD 14.60`), and the number from a cached `Intl.NumberFormat` per fraction-digit count:
 * building a formatter costs ~70x more than reusing one, and Pulse renders ~240 amounts.
 */

export const CURRENCIES = [
  { code: 'USD', symbol: '$', label: 'USD — $' },
  { code: 'SGD', symbol: 'S$', label: 'SGD — S$' },
  { code: 'EUR', symbol: '€', label: 'EUR — €' },
  { code: 'GBP', symbol: '£', label: 'GBP — £' },
  { code: 'JPY', symbol: '¥', label: 'JPY — ¥' },
  { code: 'MYR', symbol: 'RM', label: 'MYR — RM' },
  { code: 'AUD', symbol: 'A$', label: 'AUD — A$' },
  { code: 'CAD', symbol: 'C$', label: 'CAD — C$' },
] as const

export type SupportedCurrency = (typeof CURRENCIES)[number]['code']

export interface MoneyOptions {
  compact?: boolean
  sign?: boolean
}

export const isSupportedCurrency = (v: unknown): v is SupportedCurrency =>
  CURRENCIES.some((c) => c.code === v)

interface CurrencyStyle {
  symbol: string
  fractionDigits: number
}

const styleCache = new Map<string, CurrencyStyle>()
const numberCache = new Map<number, Intl.NumberFormat>()

function currencyStyle(code: string): CurrencyStyle {
  const cached = styleCache.get(code)
  if (cached) return cached
  const known = CURRENCIES.find((c) => c.code === code)
  let fractionDigits = 2
  try {
    fractionDigits =
      new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2
  } catch {
    // Not an ISO 4217 code: keep two decimals and show the code itself as the symbol.
  }
  const style: CurrencyStyle = {
    symbol: known ? known.symbol : `${code.toUpperCase()}\u00a0`,
    fractionDigits,
  }
  styleCache.set(code, style)
  return style
}

function numberFormat(fractionDigits: number): Intl.NumberFormat {
  let nf = numberCache.get(fractionDigits)
  if (!nf) {
    nf = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    })
    numberCache.set(fractionDigits, nf)
  }
  return nf
}

/** The display symbol for a currency code (`S$` for SGD, `RM` for MYR). */
export const currencySymbol = (code: string): string => currencyStyle(code).symbol.trim()

const HAS_NONZERO_DIGIT = /[1-9]/

/** One decimal below 10 units, none from 10 up, judged after rounding (9.96 → "10", not "10.0"). */
const scaled = (value: number, unit: string): string => {
  const oneDecimal = value.toFixed(1)
  return (Number(oneDecimal) >= 10 ? value.toFixed(0) : oneDecimal) + unit
}

/** `1.5k`, `13k`, `2.4M`: the unit is picked after rounding, so 999,950 reads `1.0M`, never `1000k`. */
const compactBody = (abs: number): string =>
  abs >= 999_500 ? scaled(abs / 1_000_000, 'M') : scaled(abs / 1000, 'k')

export const formatMoney = (n: number, opts: MoneyOptions = {}, currency = 'USD'): string => {
  const { symbol, fractionDigits } = currencyStyle(currency)
  if (!Number.isFinite(n)) return `${symbol}${numberFormat(fractionDigits).format(0)}`
  const abs = Math.abs(n)
  const body =
    opts.compact && abs >= 1000 ? compactBody(abs) : numberFormat(fractionDigits).format(abs)
  // A value that rounds to zero (-0.001, or -0.4 yen) never carries a sign.
  const sign = !HAS_NONZERO_DIGIT.test(body) ? '' : n < 0 ? '-' : opts.sign && n > 0 ? '+' : ''
  return `${sign}${symbol}${body}`
}

let intFormat: Intl.NumberFormat | undefined

export const formatInt = (n: number): string => {
  intFormat ??= new Intl.NumberFormat('en-US')
  return intFormat.format(Math.round(n))
}

const TIME_ZONE_CURRENCY: Readonly<Record<string, SupportedCurrency>> = {
  'Asia/Singapore': 'SGD',
  Singapore: 'SGD',
  'Asia/Kuala_Lumpur': 'MYR',
  'Asia/Kuching': 'MYR',
  'Asia/Tokyo': 'JPY',
  'Europe/London': 'GBP',
}

const EURO_REGIONS = new Set([
  'AT',
  'BE',
  'BG',
  'CY',
  'DE',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PT',
  'SI',
  'SK',
])

const REGION_CURRENCY: Readonly<Record<string, SupportedCurrency>> = {
  SG: 'SGD',
  MY: 'MYR',
  JP: 'JPY',
  GB: 'GBP',
  AU: 'AUD',
  CA: 'CAD',
  US: 'USD',
}

/** The region subtag of a BCP 47 tag (`zh-Hans-SG` → `SG`), ignoring extensions. */
function regionOf(tag: string): string | undefined {
  const parts = tag.split(/[-_]/)
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (part.length === 1) return undefined
    if (/^[A-Za-z]{2}$/.test(part)) return part.toUpperCase()
  }
  return undefined
}

function currencyForTimeZone(timeZone: string): SupportedCurrency | undefined {
  if (Object.hasOwn(TIME_ZONE_CURRENCY, timeZone)) return TIME_ZONE_CURRENCY[timeZone]
  if (timeZone.startsWith('Australia/')) return 'AUD'
  return undefined
}

function currencyForRegion(region: string): SupportedCurrency | undefined {
  if (EURO_REGIONS.has(region)) return 'EUR'
  return Object.hasOwn(REGION_CURRENCY, region) ? REGION_CURRENCY[region] : undefined
}

/**
 * The currency a fresh profile starts with: the device time zone first (a Singapore
 * phone set to en-US is still in Singapore), then the first language with a known
 * region, else USD. Pure — the caller reads `Intl` / `navigator` and catches failures.
 */
export function resolveDefaultCurrency(env: {
  timeZone?: string | undefined
  languages?: readonly string[] | undefined
}): SupportedCurrency {
  const fromZone = env.timeZone ? currencyForTimeZone(env.timeZone) : undefined
  if (fromZone) return fromZone
  for (const tag of env.languages ?? []) {
    const region = regionOf(tag)
    const fromRegion = region ? currencyForRegion(region) : undefined
    if (fromRegion) return fromRegion
  }
  return 'USD'
}
