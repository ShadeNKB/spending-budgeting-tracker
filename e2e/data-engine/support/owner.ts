// An invented dataset in the owner's shape (never his data): about 700 entries over 406 days,
// 150 learned item picks with their stamps, 120 deletions, budgets with both stamps, written as
// the eight v4 keys 0.9.2 keeps. Seeded, so every run gets the same one.

const CATEGORIES = [
  'Food & Dining',
  'Transportation',
  'Shopping',
  'Subscriptions',
  'Healthcare',
  'Social & Leisure',
  'Grooming',
  'Travel',
  'Bills & Utilities',
  'Education',
  'Other',
] as const
const ITEMS = [
  'kopi',
  'laksa',
  'grab',
  'mrt',
  'shopee',
  'spotify',
  'clinic',
  'movie',
  'haircut',
  'hotel',
] as const

/** mulberry32: small, seeded, good enough for test data. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const dayOf = (start: number, i: number) => {
  const d = new Date(start + i * 86_400_000)
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export interface OwnerShape {
  /** The v4 keys as stored strings. */
  readonly keys: Record<string, string>
  readonly liveIds: readonly string[]
  readonly deletedIds: readonly string[]
}

export function ownerShapedV4(seed = 20261031): OwnerShape {
  const random = rng(seed)
  const pick = <T>(list: readonly [T, ...T[]]): T =>
    list[Math.floor(random() * list.length)] ?? list[0]
  const start = Date.UTC(2025, 8, 20)
  const expenses = Array.from({ length: 700 }, (_, i) => {
    const day = dayOf(start, Math.floor((i * 406) / 700))
    const item = `${pick(ITEMS)} ${pad(i, 4)}`
    const createdAt = new Date(`${day}T04:${pad(i % 60)}:00.000Z`).toISOString()
    return {
      id: `owner-${pad(i, 4)}`,
      itemName: item,
      amount: Math.round((1 + random() * 80) * 100) / 100,
      category: pick(CATEGORIES),
      date: `${day}T12:00:00`,
      ...(i % 9 === 0 ? { notes: `note ${pad(i, 4)}` } : {}),
      createdAt,
      ...(i % 5 === 0
        ? { updatedAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString() }
        : {}),
    }
  })
  const deletedIds = Array.from({ length: 120 }, (_, i) => `gone-${pad(i, 4)}`)
  const mappings: Record<string, string> = {}
  const mappingStamps: Record<string, string> = {}
  for (let i = 0; i < 150; i++) {
    const item = `item ${pad(i, 3)}`
    mappings[item] = pick(CATEGORIES)
    mappingStamps[item] = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString()
  }
  const budgets = { 'Food & Dining': 300, Transportation: 80, Shopping: 120, Subscriptions: 40 }
  const budgetStamps = {
    'Food & Dining': '2026-09-01T02:00:00.000Z',
    Transportation: '2026-09-02T02:00:00.000Z',
    Shopping: '2026-09-03T02:00:00.000Z',
    Subscriptions: '2026-09-04T02:00:00.000Z',
  }
  const budgetDeleted = { Travel: '2026-08-01T02:00:00.000Z' }
  return {
    keys: {
      expenses: JSON.stringify(expenses),
      categories: JSON.stringify([...CATEGORIES]),
      categoryMappings: JSON.stringify(mappings),
      categoryMappingUpdatedAt: JSON.stringify(mappingStamps),
      categoryBudgets: JSON.stringify(budgets),
      categoryBudgetUpdatedAt: JSON.stringify(budgetStamps),
      categoryBudgetDeletedAt: JSON.stringify(budgetDeleted),
      deletedExpenseIds: JSON.stringify(deletedIds),
      'spendtrack:app': '0.8.5',
      'spendtrack:dev': 'e2eown',
      'spendtrack:currency': 'SGD',
    },
    liveIds: expenses.map((e) => e.id),
    deletedIds,
  }
}
