// Invented v4 data in the owner's shape (track spec §8.13): what 0.9.2 leaves in localStorage after
// 406 days of daily logging on a phone with sync on. NEVER real data: every row is generated from a
// seeded PRNG. Dates come in every form 0.9.x wrote: Z instants at local noon (the add sheet),
// raw instants (quick add), floating local noon (demo and e2e seeds) and bare days.
import { makeRng } from '../../../__tests__/support/rng'

export interface V4Row {
  id: string
  itemName: string
  amount: number
  category: string
  date: string
  createdAt: string
  updatedAt?: string
  notes?: string
}

export interface V4Fixture {
  /** The raw localStorage strings, as 0.9.2 wrote them. */
  readonly keys: Readonly<Record<string, string>>
  readonly rows: readonly V4Row[]
  readonly tombstones: readonly string[]
  readonly mappings: Readonly<Record<string, string>>
  readonly mappingStamps: Readonly<Record<string, string>>
  readonly budgets: Readonly<Record<string, number>>
  readonly budgetUpdatedAt: Readonly<Record<string, string>>
  readonly budgetDeletedAt: Readonly<Record<string, string>>
  readonly categories: readonly string[]
}

export const OWNER_CATS = [
  'Food & Dining',
  'Transportation',
  'Shopping',
  'Healthcare',
  'Grooming',
  'Subscriptions',
  'Investment',
  'Travel',
  'Social & Leisure',
  'Gaming',
  'Bills & Utilities',
  'Education',
  'Other',
] as const

const ITEMS: readonly (readonly [string, (typeof OWNER_CATS)[number], number])[] = [
  ['Chicken rice', 'Food & Dining', 4.5],
  ['Kopi O kosong', 'Food & Dining', 1.4],
  ['Mala hotpot with the section', 'Food & Dining', 18.9],
  ['Bubble tea', 'Food & Dining', 5.2],
  ['Cookhouse snacks', 'Food & Dining', 3.1],
  ['Grab to camp', 'Transportation', 21],
  ['MRT top up', 'Transportation', 20],
  ['Bus home', 'Transportation', 1.9],
  ['Shopee order: socks', 'Shopping', 12.9],
  ['Uniqlo tee', 'Shopping', 19.9],
  ['Clinic consult', 'Healthcare', 35],
  ['Haircut', 'Grooming', 12],
  ['Netflix', 'Subscriptions', 19.98],
  ['Spotify', 'Subscriptions', 10.98],
  ['Index fund top up', 'Investment', 200],
  ['Weekend chalet share', 'Travel', 60],
  ['Movie with friends', 'Social & Leisure', 13.5],
  ['Steam sale', 'Gaming', 9.99],
  ['Phone bill', 'Bills & Utilities', 28],
  ['Udemy course', 'Education', 15.9],
  ['Parcel postage', 'Other', 4.2],
]
const NOTES = ['bookout', 'split with section mates', 'reimbursable', 'promo code applied, 20% off']

/** 406 days before 19 Oct 2026, 04:00Z (local noon in Singapore). */
const START = Date.UTC(2025, 8, 8, 4)
const DAY = 86_400_000

const pad = (n: number): string => String(n).padStart(2, '0')
const dayOf = (t: number): string => {
  // the owner's day in Singapore (UTC+8), whatever zone the test runs in
  const d = new Date(t + 8 * 3_600_000)
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export interface FixtureOptions {
  readonly seed?: number
  readonly rows?: number
  readonly mappings?: number
  readonly tombstones?: number
  /** Leave the sync code out (a device that never joined). */
  readonly noSync?: boolean
}

/** 0.9.x generateId: base36 ms then base36 random. */
function legacyId(t: number, r: () => number): string {
  return (
    t.toString(36) +
    Math.floor(r() * 36 ** 10)
      .toString(36)
      .padStart(10, '0')
  )
}

export function ownerV4(opts: FixtureOptions = {}): V4Fixture {
  const rng = makeRng(opts.seed ?? 1)
  const n = opts.rows ?? 700
  const rows: V4Row[] = []
  for (let i = 0; i < n; i++) {
    const [name, category, base] = rng.pick(ITEMS)
    const at = START + Math.floor((i / n) * 406) * DAY + rng.int(14 * 3_600_000)
    const day = dayOf(at)
    const form = rng.int(20)
    // 12 of 20 the add sheet's Z noon, 5 a quick add's instant, 2 floating noon, 1 a bare day
    const date =
      form < 12
        ? new Date(
            Date.UTC(
              Number(day.slice(0, 4)),
              Number(day.slice(5, 7)) - 1,
              Number(day.slice(8, 10)),
              4,
            ),
          ).toISOString()
        : form < 17
          ? new Date(at).toISOString()
          : form < 19
            ? `${day}T12:00:00`
            : day
    const row: V4Row = {
      id: legacyId(at, rng.next),
      itemName: name,
      amount: Math.round(base * (0.6 + rng.next() * 0.8) * 100) / 100,
      category,
      date,
      createdAt: new Date(at).toISOString(),
    }
    if (rng.chance(0.2)) row.updatedAt = new Date(at + rng.between(1, 20) * DAY).toISOString()
    if (rng.chance(0.15)) row.notes = rng.pick(NOTES)
    rows.push(row)
  }
  const tombstones: string[] = []
  for (let i = 0; i < (opts.tombstones ?? 120); i++) {
    tombstones.push(legacyId(START + rng.int(406) * DAY, rng.next))
  }
  const mappings: Record<string, string> = {}
  const mappingStamps: Record<string, string> = {}
  for (let i = 0; i < (opts.mappings ?? 150); i++) {
    const [name, category] = rng.pick(ITEMS)
    const key = `${name} ${String(i)}`.toLowerCase()
    mappings[key] = category
    if (i % 5 !== 0) mappingStamps[key] = new Date(START + rng.int(406) * DAY).toISOString()
  }
  const budgets: Record<string, number> = {
    'Food & Dining': 300,
    Transportation: 120,
    Shopping: 150,
    Subscriptions: 40,
    Investment: 500,
  }
  const budgetUpdatedAt: Record<string, string> = {
    'Food & Dining': '2026-09-01T03:00:00.000Z',
    Transportation: '2026-09-02T03:00:00.000Z',
    Shopping: '2026-08-15T03:00:00.000Z',
    // re-set after an earlier removal: visible
    Subscriptions: '2026-10-01T03:00:00.000Z',
    Investment: '1970-01-01T00:00:00.000Z',
  }
  const budgetDeletedAt: Record<string, string> = {
    Subscriptions: '2026-09-20T03:00:00.000Z',
    // removed: the value is gone, the stamp stays
    Gaming: '2026-07-01T03:00:00.000Z',
  }
  const categories = [...OWNER_CATS]
  const keys: Record<string, string> = {
    expenses: JSON.stringify(rows),
    categories: JSON.stringify(categories),
    categoryMappings: JSON.stringify(mappings),
    categoryMappingUpdatedAt: JSON.stringify(mappingStamps),
    categoryBudgets: JSON.stringify(budgets),
    categoryBudgetUpdatedAt: JSON.stringify(budgetUpdatedAt),
    categoryBudgetDeletedAt: JSON.stringify(budgetDeletedAt),
    deletedExpenseIds: JSON.stringify(tombstones),
    'spendtrack:app': '0.8.5',
    'spendtrack:dev': 'ab12cd',
    'spendtrack:currency': 'SGD',
    categoryColors: '{"Food & Dining":"#f97316"}',
  }
  if (opts.noSync !== true) keys.syncId = 'invented-sync-code-0000-test'
  return {
    keys,
    rows,
    tombstones,
    mappings,
    mappingStamps,
    budgets,
    budgetUpdatedAt,
    budgetDeletedAt,
    categories,
  }
}

/** The same fixture with one key replaced (corrupt variants). */
export const withKey = (
  f: V4Fixture,
  key: string,
  value: string,
): Readonly<Record<string, string>> => ({
  ...f.keys,
  [key]: value,
})

/** Cuts a raw string `chars` before its end (a write torn by a killed tab). */
export const truncated = (raw: string, chars: number): string => raw.slice(0, raw.length - chars)
