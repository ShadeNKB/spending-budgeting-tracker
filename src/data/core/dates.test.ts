// @vitest-environment node
import { isValid, parseISO } from 'date-fns'
import { describe, expect, it } from 'vitest'
import { readStored } from '../../lib/dates'
import { extrasOf } from '../__tests__/support/gen'
import { must } from '../__tests__/support/must'
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

  it('localNoonIso is the floating local noon `${day}T12:00:00`: no zone, no Z (P2-2)', () => {
    for (const day of [
      '2026-10-18',
      '2026-03-08',
      '2026-11-01',
      '2026-03-29',
      '2026-10-25',
      '1970-01-01',
      '2099-12-31',
      '2028-02-29',
    ]) {
      const noon = localNoonIso(day)
      expect(noon).toBe(`${day}T12:00:00`)
      expect(noon).not.toMatch(/Z$|[+-]\d{2}:?\d{2}$/)
      // every reader agrees on its day in every zone: the text is the day, and Date, parseISO
      // and the screens' readStored all read a zone-less date-time as local wall time
      expect(noon.slice(0, 10)).toBe(day)
      expect(localDay(noon)).toBe(day)
      expect(readStored(noon).key).toBe(day)
      expect(intlDay(Date.parse(noon))).toBe(day)
      expect(must(parseDateLike(noon)).getHours()).toBe(12)
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
      expect(todayDay(new Date(y, m, d, 0, 30).getTime())).toBe(before)
      expect(todayDay(new Date(y, m, d, 23, 59).getTime())).toBe(before)
    }
  })

  it('a quick add at 00:30 in Kiritimati and at 23:59 on 31 Dec in Honolulu files under that local day', () => {
    // instants, so the expectation is zone-keyed: each is the edge case of its own zone
    const kiritimati0030 = Date.parse('2026-10-17T10:30:00.000Z') // 00:30 on 18 Oct at UTC+14
    const honolulu2359 = Date.parse('2027-01-01T09:59:00.000Z') // 23:59 on 31 Dec at UTC−10
    const table: Readonly<Record<string, readonly [string, string]>> = {
      'Pacific/Kiritimati': ['2026-10-18', '2027-01-01'],
      'Pacific/Honolulu': ['2026-10-17', '2026-12-31'],
      'Asia/Singapore': ['2026-10-17', '2027-01-01'],
      'America/New_York': ['2026-10-17', '2027-01-01'],
    }
    const got = [todayDay(kiritimati0030), todayDay(honolulu2359)]
    expect(got).toEqual([intlDay(kiritimati0030), intlDay(honolulu2359)])
    const want = table[zone]
    if (want !== undefined) expect(got).toEqual(want)
    // and the stored date of that day is its floating noon, which reads back as the same day
    for (const day of got) expect(localDay(localNoonIso(day))).toBe(day)
  })
})

describe('the zone-less fast path is exactly date-fns parseISO (P2-2, boot budget)', HEAVY, () => {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const refDate = (s: string): Date | null => {
    const d = parseISO(s)
    return isValid(d) ? d : null
  }
  const refDay = (s: string): string | null => {
    const d = refDate(s)
    return d === null
      ? null
      : `${String(d.getFullYear()).padStart(4, '0')}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  }

  /** A zone-less wall time, biased to the days and hours where zones jump. */
  function wallText(rng: ReturnType<typeof makeRng>): string {
    const y = rng.chance(0.3)
      ? rng.pick([1970, 1994, 1995, 2011, 2026, 2027, 2099])
      : rng.between(1970, 2099)
    const mo = rng.chance(0.4) ? rng.pick([1, 3, 10, 11, 12]) : rng.between(1, 12)
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    const d = rng.chance(0.3) ? rng.pick([1, 8, 25, 29, 30, 31, last]) : rng.between(1, last)
    const h = rng.chance(0.4) ? rng.pick([0, 1, 2, 3, 12, 23]) : rng.int(24)
    return `${y}-${p2(mo)}-${p2(Math.min(d, last))}T${p2(h)}:${p2(rng.int(60))}:${p2(rng.int(60))}`
  }

  it('parseDateLike, isDateText and localDay agree with parseISO on 20,000 zone-less wall times', () => {
    const rng = makeRng(98)
    for (let i = 0; i < 20_000; i++) {
      const s = wallText(rng)
      const want = refDate(s)
      expect(parseDateLike(s)?.getTime() ?? null, s).toBe(want?.getTime() ?? null)
      expect(isDateText(s), s).toBe(want !== null)
      expect(localDay(s), s).toBe(refDay(s))
    }
  })

  it('pins the zone jumps: a DST gap and overlap in New York, the skipped day in Kiritimati', () => {
    for (const s of [
      '2026-03-08T02:30:00',
      '2026-11-01T01:30:00',
      '1994-12-31T12:00:00',
      '1995-01-01T00:00:00',
      '2011-12-30T12:00:00',
      '2026-10-18T24:00:00',
      '2026-02-30T12:00:00',
      '2026-10-18T12:60:00',
    ]) {
      expect(parseDateLike(s)?.getTime() ?? null, s).toBe(refDate(s)?.getTime() ?? null)
      expect(localDay(s), s).toBe(refDay(s))
    }
  })
})

describe(
  'the core and the screens agree on the day of every stored date form (P2-2)',
  HEAVY,
  () => {
    it('localDay equals lib/dates readStored on 20,000 Z, floating, bare and offset texts', () => {
      const rng = makeRng(99)
      const p2 = (n: number): string => String(n).padStart(2, '0')
      for (let i = 0; i < 20_000; i++) {
        const t =
          Date.UTC(1970, 0, 2) +
          Math.floor(rng.next() * (Date.UTC(2099, 11, 30) - Date.UTC(1970, 0, 2)))
        const z = new Date(t).toISOString()
        const local = new Date(t)
        const floating = `${local.getFullYear()}-${p2(local.getMonth() + 1)}-${p2(local.getDate())}T${p2(local.getHours())}:${p2(local.getMinutes())}:${p2(local.getSeconds())}`
        const form = rng.pick(['z', 'floating', 'bare', 'offset', 'noon'] as const)
        const s =
          form === 'z'
            ? z
            : form === 'floating'
              ? floating
              : form === 'bare'
                ? floating.slice(0, 10)
                : form === 'noon'
                  ? localNoonIso(floating.slice(0, 10))
                  : `${z.slice(0, 19)}${rng.pick(['+08:00', '-10:00', '+14:00', '+05:30'])}`
        expect(localDay(s), s).toBe(readStored(s).key)
      }
    })
  },
)

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
