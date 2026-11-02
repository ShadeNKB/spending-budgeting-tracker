import type { Page } from '@playwright/test'

// What the app saved, read the way any build of it saved it. 0.10.0 keeps one envelope,
// `st5:db` = "5|<digest>|<body>", whose body's `doc` is the v5 wire document (live entries only,
// in id order, v4-compatible fields plus `day`, `fs`, `h`); it also writes the v4 keys as a
// rollback mirror, but only on a 1 s idle debounce, so the envelope is the truth right after a
// change. Before the first v5 boot (or on 0.9.x) the v4 `expenses` key is.

export interface StoredExpense {
  readonly id: string
  readonly itemName: string
  readonly amount: number
  readonly category: string
  readonly date: string
  readonly createdAt: string
  readonly updatedAt?: string
  readonly notes?: string
  /** The calendar day (v5 writes it; older rows derive it from `date`). */
  readonly day?: string
}

/** In the page: the stored live entries, from the envelope when there is one. */
function readStored(): unknown {
  const envelope = localStorage.getItem('st5:db')
  if (envelope !== null) {
    const body: unknown = JSON.parse(envelope.slice(envelope.indexOf('|', 2) + 1))
    if (typeof body !== 'object' || body === null || !('doc' in body)) return []
    const doc: unknown = body.doc
    return typeof doc === 'object' && doc !== null && 'expenses' in doc ? doc.expenses : []
  }
  const v4: unknown = JSON.parse(localStorage.getItem('expenses') ?? '[]')
  return v4
}

const isStored = (r: unknown): r is StoredExpense =>
  typeof r === 'object' && r !== null && 'id' in r && typeof r.id === 'string'

/** Newest first, as the ledger lists them: by creation time, then id. */
const newestFirst = (a: StoredExpense, b: StoredExpense) =>
  a.createdAt === b.createdAt
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : a.createdAt < b.createdAt
      ? 1
      : -1

/** The live entries the page has saved, newest first. */
export async function storedExpenses(page: Page): Promise<StoredExpense[]> {
  const rows = await page.evaluate(readStored)
  return (Array.isArray(rows) ? rows : []).filter(isStored).sort(newestFirst)
}

/** Whether the page has its v5 envelope yet. */
export const hasEnvelope = (page: Page): Promise<boolean> =>
  page.evaluate(() => localStorage.getItem('st5:db') !== null)

/** Every key the page has stored, as raw strings. */
export const rawStorage = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => {
    const out: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key === null) continue
      const value = localStorage.getItem(key)
      if (value !== null) out[key] = value
    }
    return out
  })
