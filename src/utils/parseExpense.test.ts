import { afterEach, describe, expect, it, vi } from 'vitest'
import { format } from 'date-fns'
import { DEFAULT_CATEGORIES } from '../constants'
import { parseExpense, quickAddDateLabel } from './parseExpense'

describe('parseExpense', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('extracts item, amount and yesterday date', () => {
    vi.setSystemTime(new Date('2026-05-01T12:00:00'))

    const parsed = parseExpense('coffee 4.50 yesterday')

    expect(parsed).toMatchObject({
      itemName: 'coffee',
      amount: 4.5,
      parsedDate: '2026-04-30',
    })
  })

  it('returns an incomplete result for empty input', () => {
    expect(parseExpense('   ')).toEqual({
      itemName: '',
      amount: null,
      raw: '',
    })
  })

  // What was learned from past entries is the app's to match, with the one matcher (F-044):
  // useLearnedCategory, over the engine's smartCategory.
  it('suggests no category of its own for a plain entry', () => {
    const parsed = parseExpense('spotify premium 15')

    expect(parsed.itemName).toBe('spotify premium')
    expect(parsed.amount).toBe(15)
    expect(parsed.suggestedCategory).toBeUndefined()
  })
})

// Clocks are built from local components so they mean the same wall time in every CI time zone.
const NOW = new Date(2026, 9, 18, 9, 30)
const todayKey = (now: Date) => format(now, 'yyyy-MM-dd')

describe('parseExpense — context and categories', () => {
  it('uses ctx.now instead of the system clock', () => {
    const parsed = parseExpense('grab 12 yesterday', { now: new Date(2027, 0, 1, 0, 5) })
    expect(parsed.parsedDate).toBe('2026-12-31')
  })

  it('reads a trailing category word only when categories are given', () => {
    expect(parseExpense('lunch 8.5 food', { now: NOW }).itemName).toBe('lunch food')
    const withCategories = parseExpense('lunch 8.5 food', { now: NOW, categories: ['Food'] })
    expect(withCategories).toMatchObject({
      itemName: 'lunch',
      suggestedCategory: 'Food',
    })
  })

  it('maps an alias only to a category the user has', () => {
    const ctx = { now: NOW, categories: ['Food & Dining', 'Other'] }
    expect(parseExpense('grab 15 transport', ctx)).toMatchObject({
      itemName: 'grab transport',
      amount: 15,
    })
    expect(parseExpense('grab 15 transport', ctx).suggestedCategory).toBeUndefined()
    expect(parseExpense('cold storage 30 groceries', ctx).suggestedCategory).toBe('Food & Dining')
  })

  it('prefers a Groceries category over Food & Dining for the groceries alias', () => {
    const ctx = { now: NOW, categories: ['Food & Dining', 'Groceries'] }
    expect(parseExpense('fairprice 45 groceries', ctx).suggestedCategory).toBe('Groceries')
  })

  it('ignores a first word shared by two categories', () => {
    const ctx = { now: NOW, categories: ['Food & Dining', 'Food Delivery'] }
    expect(parseExpense('lunch 8 food', ctx)).toMatchObject({ itemName: 'lunch food' })
  })

  it('takes a category word typed after the amount as the category', () => {
    const parsed = parseExpense('coffee 4 shopping', { now: NOW, categories: DEFAULT_CATEGORIES })
    expect(parsed).toMatchObject({ itemName: 'coffee', suggestedCategory: 'Shopping' })
  })
})

describe('parseExpense — day and month without a year', () => {
  const parse = (input: string, now: Date) => parseExpense(input, { now })

  it('reads a day up to a month ahead as a plan, not last year (31 days is the edge)', () => {
    const now = new Date(2026, 9, 18, 9, 30) // Sun 18 Oct 2026
    expect(parse('hotel 200 18 nov', now)).toEqual({
      itemName: 'hotel 18 nov',
      amount: 200,
      raw: 'hotel 200 18 nov',
    })
    expect(parse('hotel 200 19 nov', now).parsedDate).toBe('2025-11-19')
  })

  it('looks back at most a year for 29 Feb', () => {
    expect(parse('cake 10 29 feb', new Date(2028, 2, 5, 12)).parsedDate).toBe('2028-02-29')
    expect(parse('cake 10 29 feb', new Date(2029, 0, 10, 12)).parsedDate).toBe('2028-02-29')
    expect(parse('cake 10 29 feb', new Date(2028, 0, 10, 12))).toEqual({
      itemName: 'cake 29 feb',
      amount: 10,
      raw: 'cake 10 29 feb',
    })
  })

  it('never takes the day of a phrase that is not a date as the amount when another number exists', () => {
    const now = new Date(2026, 9, 18, 9, 30)
    expect(parse('lunch 5 31 apr', now)).toMatchObject({ amount: 5, itemName: 'lunch 31 apr' })
    expect(parse('kopi 3 19 oct', now)).toMatchObject({ amount: 3, itemName: 'kopi 19 oct' })
    expect(parse('lunch 5 29 feb', now)).toMatchObject({ amount: 5, itemName: 'lunch 29 feb' })
    // The only number is still the amount (a phrase never uses it up).
    expect(parse('lunch 31 apr', now)).toMatchObject({ amount: 31, itemName: 'lunch apr' })
  })
})

describe('quick-add dates', () => {
  const parse = (input: string, now: Date) => parseExpense(input, { now })

  // The quick add stores `parsedDate` as the entry's day (P2-2); undefined means today, which
  // the store fills in from the device clock.
  it('gives the day to store as yyyy-MM-dd, and nothing for an undated entry', () => {
    expect(parse('kopi 1.8', NOW).parsedDate).toBeUndefined()
    expect(parse('kopi 1.8 yesterday', NOW).parsedDate).toBe('2026-10-17')
    expect(parse('kopi 1.8 31 dec', NOW).parsedDate).toBe('2025-12-31')
  })

  it('reads relative days from local midnight, at the turn of the year too', () => {
    const newYear = new Date(2026, 0, 1, 0, 30)
    expect(parse('kopi 1.8 yesterday', newYear).parsedDate).toBe('2025-12-31')
    expect(parse('kopi 1.8 today', newYear).parsedDate).toBe('2026-01-01')
    const eve = new Date(2025, 11, 31, 23, 59)
    expect(parse('kopi 1.8 yesterday', eve).parsedDate).toBe('2025-12-30')
  })

  it('labels only a day other than today, with the year when it differs', () => {
    expect(quickAddDateLabel(undefined, NOW)).toBeNull()
    expect(quickAddDateLabel('2026-10-18', NOW)).toBeNull()
    expect(quickAddDateLabel('2026-10-17', NOW)).toBe('Oct 17')
    expect(quickAddDateLabel('2025-12-31', NOW)).toBe('Dec 31, 2025')
  })
})

describe('parseExpense — prototype keys', () => {
  const NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']

  it.each(NAMES)('treats "%s" as a plain item name', (name) => {
    const parsed = parseExpense(`${name} 5`, { now: NOW, categories: DEFAULT_CATEGORIES })
    expect(parsed.itemName).toBe(name)
    expect(parsed.amount).toBe(5)
    expect(parsed.suggestedCategory).toBeUndefined()
  })

  it.each(NAMES)('never reads "%s" as a trailing category', (name) => {
    const parsed = parseExpense(`lunch 5 ${name}`, { now: NOW, categories: DEFAULT_CATEGORIES })
    expect(parsed.itemName).toBe(`lunch ${name}`)
    expect(parsed.suggestedCategory).toBeUndefined()
  })
})

// ─── seeded property tests ────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)]
  if (item === undefined) throw new Error('pick from an empty list')
  return item
}

// Plain words: no month, weekday, date, unit, place-number, currency, recurrence or category words.
// Several are traps that start like a month or weekday.
const PLAIN_WORDS = [
  'coffee',
  'kopi',
  'teh',
  'chicken',
  'rice',
  'laksa',
  'prata',
  'nasi',
  'lemak',
  'bubble',
  'tea',
  'grab',
  'taxi',
  'lunch',
  'dinner',
  'supper',
  'novena',
  'marina',
  'decathlon',
  'sephora',
  'maybank',
  'octopus',
  'mayo',
  'jurong',
  'point',
  'paya',
  'lebar',
  'ang',
  'mo',
  'kio',
  'marine',
  'parade',
  'kopitiam',
  'nex',
  'bugis+',
  'plaza',
  'uniqlo',
  'haircut',
  'decaf',
  'sundae',
  'satay',
  'fries',
  'monster',
  'wedding',
  'sunset',
  'janitor',
  'augustine',
  'marching',
  '313@somerset',
  '7-eleven',
]

function randomRoundNumber(rand: () => number): string {
  const kind = rand()
  if (kind < 0.4) return String(1 + Math.floor(rand() * 99_999))
  if (kind < 0.8) return (Math.floor(rand() * 1_000_000) / 100).toFixed(2)
  return (Math.floor(rand() * 10_000) / 10).toFixed(1)
}

function randomClock(rand: () => number): Date {
  const year = 2020 + Math.floor(rand() * 10)
  const month = Math.floor(rand() * 12)
  const day = 1 + Math.floor(rand() * 31)
  return new Date(year, month, day, Math.floor(rand() * 24), Math.floor(rand() * 60))
}

describe('parseExpense — properties (seeded)', () => {
  it('keeps the only plain number as the amount (2,000 cases)', () => {
    const rand = mulberry32(0x5eed)
    for (let i = 0; i < 2000; i++) {
      const words = Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
        pick(rand, PLAIN_WORDS),
      )
      const number = randomRoundNumber(rand)
      const tokens = [...words]
      tokens.splice(Math.floor(rand() * (words.length + 1)), 0, number)
      const input = tokens.join(' ')
      const parsed = parseExpense(input, {
        now: randomClock(rand),
        categories: DEFAULT_CATEGORIES,
      })
      expect({ input, amount: parsed.amount, item: parsed.itemName }).toEqual({
        input,
        amount: Number(number),
        item: words.join(' '),
      })
      expect(parsed.parsedDate).toBeUndefined()
    }
  })

  it('keeps a currency-marked amount when a count or a date phrase follows it (2,000 cases)', () => {
    const rand = mulberry32(0xc0de)
    const units = ['pax', 'tickets', 'cups', 'pcs', 'sets']
    const monthWords = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ]
    for (let i = 0; i < 2000; i++) {
      const now = randomClock(rand)
      const words = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
        pick(rand, PLAIN_WORDS),
      )
      const number = randomRoundNumber(rand)
      // "12 sgd", "12 SGD", "S$ 12", "$ 12", "SGD 12": a separate currency word on either side.
      const money = pick(rand, [
        `${number} sgd`,
        `${number} SGD`,
        `S$ ${number}`,
        `$ ${number}`,
        `SGD ${number}`,
      ])
      // What follows: a count (kept in the name) or a day phrase within the last 300 days.
      const kind = rand()
      let tail: string
      let item = words.join(' ')
      let date: string | undefined
      if (kind < 0.35) {
        tail = `${String(1 + Math.floor(rand() * 9))} ${pick(rand, units)}`
        item = `${item} ${tail}`
      } else {
        const back = Math.floor(rand() * 300)
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12)
        date = format(day, 'yyyy-MM-dd')
        tail =
          back === 0
            ? 'today'
            : back === 1 && kind < 0.45
              ? 'yesterday'
              : kind < 0.7
                ? `${String(back)} days ago`
                : `${String(day.getDate())} ${monthWords[day.getMonth()] ?? ''}`
      }
      const input = `${words.join(' ')} ${money} ${tail}`
      const parsed = parseExpense(input, { now, categories: DEFAULT_CATEGORIES })
      expect({
        input,
        amount: parsed.amount,
        item: parsed.itemName,
        date: parsed.parsedDate,
      }).toEqual({ input, amount: Number(number), item, date })
    }
  })

  it('never returns a date after today, an invalid date or an unusable amount (2,000 cases)', () => {
    const rand = mulberry32(0xda7e)
    const months = [
      'jan',
      'Feb',
      'march',
      'APR',
      'may',
      'jun',
      'july',
      'Aug',
      'sept',
      'oct',
      'nov',
      'dec.',
    ]
    const weekdays = ['mon', 'tues', 'wed', 'thu', 'fri', 'sat', 'sun', 'Sunday', 'friday']
    const pad = (n: number) => String(n).padStart(2, '0')
    for (let i = 0; i < 2000; i++) {
      const now = randomClock(rand)
      const year = now.getFullYear() - 2 + Math.floor(rand() * 5)
      const pool = [
        pick(rand, PLAIN_WORDS),
        randomRoundNumber(rand),
        String(1 + Math.floor(rand() * 31)),
        `${String(1 + Math.floor(rand() * 31))}${pick(rand, ['st', 'nd', 'rd', 'th'])}`,
        pick(rand, months),
        pick(rand, weekdays),
        pick(rand, [
          'last',
          'today',
          'yesterday',
          'yday',
          'days',
          'day',
          'ago',
          'week',
          'S$',
          'sgd',
        ]),
        `${String(year)}-${pad(1 + Math.floor(rand() * 12))}-${pad(1 + Math.floor(rand() * 31))}`,
        `${String(1 + Math.floor(rand() * 31))}/${String(1 + Math.floor(rand() * 12))}`,
        `${String(1 + Math.floor(rand() * 31))}/${String(1 + Math.floor(rand() * 12))}/${String(year).slice(rand() < 0.5 ? 2 : 0)}`,
      ]
      const input = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => pick(rand, pool)).join(
        ' ',
      )
      const parsed = parseExpense(input, { now, categories: DEFAULT_CATEGORIES })
      if (parsed.parsedDate !== undefined) {
        const [y = 0, m = 0, d = 0] = parsed.parsedDate.split('-').map(Number)
        expect({ input, date: format(new Date(y, m - 1, d, 12), 'yyyy-MM-dd') }).toEqual({
          input,
          date: parsed.parsedDate,
        })
        expect({ input, future: parsed.parsedDate > todayKey(now) }).toEqual({
          input,
          future: false,
        })
      }
      if (parsed.amount !== null) {
        expect(Number.isFinite(parsed.amount) && parsed.amount >= 0).toBe(true)
        expect(Math.round(parsed.amount * 100) / 100).toBe(parsed.amount)
      }
    }
  })
})
