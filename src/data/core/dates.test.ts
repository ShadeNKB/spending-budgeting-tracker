// @vitest-environment node
import { isValid, parseISO } from 'date-fns'
import { describe, expect, it } from 'vitest'
import { extrasOf } from '../__tests__/support/gen'
import { HEAVY, envVar, makeRng } from '../__tests__/support/rng'
import {
  dayOf,
  isDateText,
  localDay,
  localNoonIso,
  parseDateLike,
  todayDay,
  validDay,
} from './dates'
import type { DateValue, ExpenseRec, Reg } from './types'

/** Independent oracle: the local calendar day of an instant via Intl (not via Date getters). */
function intlDay(instant: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '??'
  return `${get('year')}-${get('month')}-${get('day')}`
}

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

function rec(d: DateValue): ExpenseRec {
  const reg = <T>(v: T): Reg<T> => ({ v, s: 0, r: 1 })
  return {
    id: 'e1',
    createdAt: '2026-10-18T04:00:00.000Z',
    C: 0,
    n: reg('kopi'),
    a: reg(1.8),
    c: reg('Food'),
    d: reg(d),
    o: reg(null),
    x: reg(extrasOf({})),
  }
}

describe('the process time zone is the one requested (catches the Git Bash TZ trap)', HEAVY, () => {
  it('Intl resolves process.env.TZ when it is set', () => {
    const want = envVar('TZ')
    if (want === undefined || want === '') return
    expect(zone).toBe(want)
  })
})

describe('validDay', HEAVY, () => {
  it('accepts real calendar days 1970–2099 only', () => {
    for (const ok of ['1970-01-01', '2099-12-31', '2028-02-29', '2000-02-29', '2026-10-18']) {
      expect(validDay(ok), ok).toBe(true)
    }
    for (const bad of [
      '1969-12-31',
      '2100-01-01',
      '2027-02-29',
      '1900-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-1-01',
      '2026-10-18T12:00:00',
      ' 2026-10-18',
      '',
      18,
      null,
      undefined,
    ]) {
      expect(validDay(bad), String(bad)).toBe(false)
    }
  })
})

describe('parseDateLike', HEAVY, () => {
  it('accepts ISO strings with a literal year 1970–2099', () => {
    expect(parseDateLike('2026-10-18')).not.toBeNull()
    expect(parseDateLike('2026-10-18T12:00:00')).not.toBeNull()
    expect(parseDateLike('2026-10-18T04:00:00.000Z')).not.toBeNull()
    expect(parseDateLike('2026-10-18T12:00:00+08:00')).not.toBeNull()
    expect(parseDateLike('1970-01-01T00:00:00.000Z')).not.toBeNull()
  })

  it('rejects free text, other formats and out-of-range years in every time zone', () => {
    for (const bad of [
      'last tuesday',
      '18/10/2026',
      'not-a-date',
      '',
      '9999-12-31T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
      '1969-12-31T23:59:59.999Z',
      '2026-02-30',
    ]) {
      expect(parseDateLike(bad), bad).toBeNull()
    }
  })
})

describe('localDay / localNoonIso / todayDay (§7.10, T-096-1 core half)', HEAVY, () => {
  it('returns a bare day as-is and never reads it as UTC midnight', () => {
    expect(localDay('2026-10-18')).toBe('2026-10-18')
    expect(localDay('2028-02-29')).toBe('2028-02-29')
    expect(localDay('2026-10-18T00:30:00')).toBe('2026-10-18')
    expect(localDay('garbage')).toBeNull()
  })

  it('TZ-keyed expectation table for one instant', () => {
    const table: Readonly<Record<string, string>> = {
      'Pacific/Honolulu': '2026-10-17',
      'Asia/Singapore': '2026-10-18',
      'Pacific/Kiritimati': '2026-10-18',
      'America/New_York': '2026-10-18',
      'Europe/London': '2026-10-18',
    }
    const got = localDay('2026-10-18T04:00:00.000Z')
    expect(got).toBe(intlDay(Date.parse('2026-10-18T04:00:00.000Z')))
    const want = table[zone]
    if (want !== undefined) expect(got).toBe(want)
  })

  it('localNoonIso is byte-identical to the shipped `new Date(day + "T12:00:00").toISOString()`', () => {
    for (const day of ['2026-10-18', '2026-03-08', '2026-11-01', '2026-03-29', '2026-10-25']) {
      expect(localNoonIso(day)).toBe(new Date(day + 'T12:00:00').toISOString())
    }
    if (zone === 'Asia/Singapore') {
      expect(localNoonIso('2026-10-18')).toBe('2026-10-18T04:00:00.000Z')
    }
  })

  it('round-trips every sampled day 1970–2099, incl. month/year ends, leap and DST days', () => {
    const days: string[] = []
    for (let y = 1970; y <= 2099; y++) {
      for (const [m, d] of [
        [1, 1],
        [2, 28],
        [3, 1],
        [3, 8],
        [3, 29],
        [6, 30],
        [10, 25],
        [11, 1],
        [12, 31],
      ] as const) {
        days.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
      }
      if ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) days.push(`${y}-02-29`)
    }
    const missing: string[] = []
    for (const day of days) {
      const [y, m, d] = day.split('-').map(Number)
      if (y === undefined || m === undefined || d === undefined) throw new Error(day)
      // A calendar day that does not exist in this zone (Kiritimati skipped 1994-12-31).
      if (new Date(y, m - 1, d, 12).getDate() !== d) {
        missing.push(day)
        continue
      }
      const noon = localNoonIso(day)
      expect(localDay(noon), day).toBe(day)
      expect(intlDay(Date.parse(noon)), day).toBe(day)
    }
    expect(missing).toEqual(zone === 'Pacific/Kiritimati' ? ['1994-12-31'] : [])
  })

  it('todayDay flips exactly at local midnight, across month and year ends', () => {
    const cases: readonly (readonly [number, number, number, string, string])[] = [
      [2026, 9, 18, '2026-10-18', '2026-10-19'],
      [2026, 11, 31, '2026-12-31', '2027-01-01'],
      [2028, 1, 28, '2028-02-28', '2028-02-29'],
      [2027, 1, 28, '2027-02-28', '2027-03-01'],
      [2026, 2, 7, '2026-03-07', '2026-03-08'],
    ]
    for (const [y, m, d, before, after] of cases) {
      const lastMs = new Date(y, m, d, 23, 59, 59, 999).getTime()
      expect(todayDay(lastMs)).toBe(before)
      expect(todayDay(lastMs + 1)).toBe(after)
      expect(todayDay(new Date(y, m, d, 0, 0, 0, 0).getTime())).toBe(before)
    }
  })
})

describe('fast paths are exactly date-fns parseISO (boot budget, §9.12)', HEAVY, () => {
  /** The reference the fast paths must reproduce: literal year 1970–2099, then parseISO. */
  const refDate = (s: string): Date | null => {
    const year = /^(\d{4})-/.exec(s)
    const y = year === null ? NaN : Number(year[1])
    if (!(y >= 1970 && y <= 2099)) return null
    const d = parseISO(s)
    return isValid(d) ? d : null
  }
  const refDay = (s: string): string | null => {
    if (validDay(s)) return s
    const d = parseISO(s)
    if (!isValid(d)) return null
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${String(d.getFullYear()).padStart(4, '0')}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function nearIso(rng: ReturnType<typeof makeRng>): string {
    const y = rng.pick([
      '1969',
      '1970',
      '2000',
      '2026',
      '2028',
      '2027',
      '2099',
      '2100',
      '0050',
      '9999',
    ])
    const mo = rng.pick(['00', '01', '02', '03', '10', '12', '13'])
    const d = rng.pick(['00', '01', '28', '29', '30', '31', '32'])
    const h = rng.pick(['00', '04', '12', '23', '24', '25'])
    const mi = rng.pick(['00', '30', '59', '60'])
    const sec = rng.pick(['00', '07', '59', '60'])
    const frac = rng.pick(['', '.0', '.1', '.12', '.123', '.999', '.1234', '.123456', ',5'])
    const zone = rng.pick(['Z', 'Z', 'Z', '', '+08:00', '-10:00', 'z', ' Z'])
    let s = `${y}-${mo}-${d}${rng.pick(['T', 'T', 'T', ' '])}${h}:${mi}:${sec}${frac}${zone}`
    if (rng.chance(0.1)) {
      const at = rng.int(s.length)
      s = s.slice(0, at) + s.slice(at + 1)
    }
    return s
  }

  it('parseDateLike, isDateText and localDay agree with the reference on 20,000 near-ISO texts', () => {
    const rng = makeRng(96)
    let fast = 0
    for (let i = 0; i < 20_000; i++) {
      const s = nearIso(rng)
      const want = refDate(s)
      const got = parseDateLike(s)
      expect(got?.getTime() ?? null, s).toBe(want?.getTime() ?? null)
      expect(isDateText(s), s).toBe(want !== null)
      expect(localDay(s), s).toBe(refDay(s))
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s) && want !== null) fast++
    }
    // the canonical form (what toISOString writes, i.e. nearly every stored date) is well covered
    expect(fast).toBeGreaterThan(200)
  })

  it('canonical toISOString texts of random instants 1970–2099 match exactly (ms included)', () => {
    const rng = makeRng(97)
    const lo = Date.UTC(1970, 0, 1)
    const hi = Date.UTC(2100, 0, 1) - 1
    for (let i = 0; i < 20_000; i++) {
      const t = lo + Math.floor(rng.next() * (hi - lo))
      const s = new Date(t).toISOString()
      expect(parseDateLike(s)?.getTime(), s).toBe(t)
      expect(localDay(s), s).toBe(refDay(s))
    }
  })
})

describe('dayOf', HEAVY, () => {
  it('prefers the stored day, then the local day of the date, then the raw prefix', () => {
    expect(dayOf(rec({ date: '2026-10-18T04:00:00.000Z', day: '2026-10-17' }))).toBe('2026-10-17')
    expect(dayOf(rec({ date: '2026-10-18' }))).toBe('2026-10-18')
    expect(dayOf(rec({ date: '2026-10-18T04:00:00.000Z' }))).toBe(
      intlDay(Date.parse('2026-10-18T04:00:00.000Z')),
    )
    // unreachable for sanitised records; kept total
    expect(dayOf(rec({ date: 'garbage-xyz' }))).toBe('garbage-xy')
  })
})
