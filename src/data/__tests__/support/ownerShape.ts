// Synthetic data in the owner's shape (invented): ~240 B per row on the wire, entries over 406 days,
// the categories and kinds of names a full-time NSF in Singapore logs, a third of the rows legacy
// (migrated from v4, unsealed), the rest written by v5 (sealed, with a day), some edited later.
import { localNoonIso } from '../../core/dates'
import { newId } from '../../core/ids'
import { iso } from '../../core/stamp'
import type { BudgetReg, Doc, ExpenseRec, MapReg, Reg, Stamp } from '../../core/types'
import { extrasOf } from './gen'
import { makeRng } from './rng'

const START = Date.UTC(2025, 8, 9, 4) // 406 days before mid-October 2026
const DAY = 86_400_000
export const OWNER_CATEGORIES = [
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
  'Other',
] as const
const ITEMS: readonly (readonly [string, (typeof OWNER_CATEGORIES)[number], number])[] = [
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
  ['Parcel postage', 'Other', 4.2],
]
const NOTES = ['bookout', 'split with section mates', 'reimbursable', 'promo code applied']

function reg<T>(v: T, s: Stamp, r: 0 | 1 | 2): Reg<T> {
  return { v, s, r }
}

/** A doc of `n` owner-shaped records plus mappings, budgets and a few hundred tombstones. */
export function ownerDoc(n: number, seed: number): Doc {
  const rng = makeRng(seed)
  const expenses = new Map<string, ExpenseRec>()
  const noExtras = extrasOf({})
  for (let i = 0; i < n; i++) {
    const [name, category, base] = rng.pick(ITEMS)
    const dayIndex = Math.floor((i / n) * 406)
    const C = START + dayIndex * DAY + rng.int(14 * 3_600_000)
    const id = newId(rng.next)
    const amount = Math.round(base * (0.8 + rng.next() * 0.4) * 100) / 100
    const notes = rng.chance(0.2) ? rng.pick(NOTES) : null
    const dayDate = new Date(START + dayIndex * DAY)
    const day = `${dayDate.getUTCFullYear()}-${String(dayDate.getUTCMonth() + 1).padStart(2, '0')}-${String(dayDate.getUTCDate()).padStart(2, '0')}`
    if (i < n / 3) {
      // migrated legacy row: whole-record stamp, rank 1, no day
      const U = rng.chance(0.1) ? C + rng.int(5 * DAY) : C
      expenses.set(id, {
        id,
        createdAt: iso(C),
        C,
        n: reg(name, U, 1),
        a: reg(amount, U, 1),
        c: reg<string>(category, U, 1),
        d: reg({ date: iso(C) }, U, 1),
        o: reg(notes, U, 1),
        x: reg(noExtras, U, 1),
      })
    } else {
      const edited = rng.chance(0.15) ? C + 1 + rng.int(3 * DAY) : C
      expenses.set(id, {
        id,
        createdAt: iso(C),
        C,
        n: reg(name, C, 2),
        a: reg(amount, edited, 2),
        c: reg<string>(category, C, 2),
        d: reg({ date: localNoonIso(day), day }, C, 2),
        o: reg(notes, C, 2),
        x: reg(noExtras, C, 2),
      })
    }
  }
  const mappings = new Map<string, MapReg>()
  for (let i = 0; i < Math.min(300, n); i++) {
    const [name, category] = rng.pick(ITEMS)
    mappings.set(`${name.toLowerCase()} ${i}`, {
      v: category,
      s: i % 2 === 0 ? 0 : START + i * 1000,
    })
  }
  const budgets = new Map<string, BudgetReg>()
  for (const c of OWNER_CATEGORIES.slice(0, 8))
    budgets.set(c, { value: 100 + rng.int(400), set: START + rng.int(30) * DAY, del: 0 })
  const tombs = new Map<string, Stamp>()
  for (let i = 0; i < Math.min(200, n); i++)
    tombs.set(newId(rng.next), i % 4 === 0 ? 0 : START + rng.int(400) * DAY)
  return {
    expenses,
    tombs,
    categories: [...OWNER_CATEGORIES],
    renames: new Map(),
    mappings,
    budgets,
    prefs: new Map([['currency', { v: 'SGD', s: START }]]),
    devices: new Map(),
  }
}
