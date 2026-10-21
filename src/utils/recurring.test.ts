import { describe, expect, it } from 'vitest'
import { detectRecurring, forecastDailyFromRecurring, upcomingDue } from './recurring'
import { getLedgerIndex } from '../lib/ledgerIndex'
import type { Expense } from '../types'

const expense = (
  id: string,
  itemName: string,
  date: string,
  amount = 15,
  time = '12:00:00',
): Expense => ({
  id,
  itemName,
  amount,
  category: 'Subscriptions',
  date: `${date}T${time}`,
  createdAt: `${date}T${time}`,
})

const detect = (rows: Expense[]) => detectRecurring(getLedgerIndex(rows))
const sum = (bins: readonly number[]) => bins.reduce((s, v) => s + v, 0)

describe('detectRecurring', () => {
  it('detects consistent monthly charges', () => {
    const groups = detect([
      expense('1', 'Netflix', '2026-01-01'),
      expense('2', 'Netflix', '2026-02-01'),
      expense('3', 'Netflix', '2026-03-01'),
      expense('4', 'Coffee', '2026-03-02', 4.5),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      key: 'netflix',
      displayName: 'Netflix',
      periodicity: 'monthly',
      avgAmount: 15,
      nextDue: '2026-04-01',
    })
  })

  it('does not flag an irregularly repeated expense as recurring', () => {
    // Three repairs with consistent-ish gaps (~88 days) but only 3 data points.
    const groups = detect([
      expense('1', 'laptop repair', '2025-01-10', 180),
      expense('2', 'laptop repair', '2025-04-06', 200),
      expense('3', 'laptop repair', '2025-07-05', 190),
    ])
    expect(groups).toHaveLength(0)
  })

  it('measures gaps in calendar days, whatever the time of day', () => {
    const [g] = detect([
      expense('1', 'Gym', '2026-01-01', 30, '23:30:00'),
      expense('2', 'Gym', '2026-01-08', 30, '00:15:00'),
      expense('3', 'Gym', '2026-01-15', 30, '18:00:00'),
    ])
    expect(g).toMatchObject({ periodicity: 'weekly', avgGapDays: 7, nextDue: '2026-01-22' })
  })

  it('anchors monthly charges to their usual day, clamped to short months', () => {
    const [g] = detect([
      expense('1', 'Rent', '2026-01-31', 900),
      expense('2', 'Rent', '2026-02-28', 900),
      expense('3', 'Rent', '2026-03-31', 900),
    ])
    expect(g?.nextDue).toBe('2026-04-30')
    const [leap] = detect([
      expense('1', 'Rent', '2027-11-30', 900),
      expense('2', 'Rent', '2027-12-30', 900),
      expense('3', 'Rent', '2028-01-30', 900),
    ])
    expect(leap?.nextDue).toBe('2028-02-29')
  })

  it('breaks a tie between usual days of the month in favour of the latest', () => {
    const [g] = detect([
      expense('1', 'Gym', '2026-01-05', 80),
      expense('2', 'Gym', '2026-02-05', 80),
      expense('3', 'Gym', '2026-03-07', 80),
      expense('4', 'Gym', '2026-04-07', 80),
    ])
    expect(g).toMatchObject({ periodicity: 'monthly', anchorDay: 7, nextDue: '2026-05-07' })
  })

  it('ignores a same-day duplicate when measuring the spacing', () => {
    const [g] = detect([
      expense('1', 'Phone bill', '2026-01-01', 30),
      expense('2', 'Phone bill', '2026-02-01', 30),
      expense('3', 'Phone bill', '2026-02-01', 30),
      expense('4', 'Phone bill', '2026-03-01', 30),
    ])
    expect(g).toMatchObject({ periodicity: 'monthly', avgGapDays: 29.5, nextDue: '2026-04-01' })
    expect(g?.occurrences).toHaveLength(4)
  })

  it('merges near-identical names that share a first word', () => {
    const groups = detect([
      expense('1', 'Spotify', '2026-01-01', 12),
      expense('2', 'spotify premium', '2026-02-01', 12),
      expense('3', 'Spotify', '2026-03-01', 12),
      expense('4', 'Grab', '2026-03-02', 9),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.occurrences).toHaveLength(3)
  })

  it('ignores rows whose date cannot be read and is memoised per index', () => {
    const rows = [
      expense('1', 'Netflix', '2026-01-01'),
      { ...expense('x', 'Netflix', '2026-01-15'), date: 'garbage' },
      expense('2', 'Netflix', '2026-02-01'),
      expense('3', 'Netflix', '2026-03-01'),
    ]
    const index = getLedgerIndex(rows)
    const groups = detectRecurring(index)
    expect(groups[0]?.occurrences.map((e) => e.id)).toEqual(['1', '2', '3'])
    expect(detectRecurring(index)).toBe(groups)
  })
})

describe('forecastDailyFromRecurring', () => {
  it('F-063: from Apr 1, a 35-day window holds the Apr 1 and May 1 charges (24, not 12)', () => {
    const groups = detect([
      expense('1', 'Spotify', '2026-01-01', 12),
      expense('2', 'Spotify', '2026-02-01', 12),
      expense('3', 'Spotify', '2026-03-01', 12),
    ])
    const forecast = forecastDailyFromRecurring(groups, '2026-04-01', 35)
    expect(sum(forecast)).toBe(24)
    expect(forecast[0]).toBe(12)
    expect(forecast[30]).toBe(12)
  })

  it('F-048: a monthly charge billed today is in bin 0 (Spotify on the 1st, today Nov 1)', () => {
    const rows = Array.from({ length: 12 }, (_, i) => {
      const y = i < 2 ? 2025 : 2026
      const m = ((10 + i) % 12) + 1
      return expense(String(i), 'Spotify', `${String(y)}-${String(m).padStart(2, '0')}-01`, 9.99)
    })
    const forecast = forecastDailyFromRecurring(detect(rows), '2026-11-01', 14)
    expect(forecast[0]).toBeCloseTo(9.99, 10)
  })

  it('counts a charge 1-3 days overdue as due today and skips older ones', () => {
    const groups = detect([
      expense('1', 'Netflix', '2026-01-01'),
      expense('2', 'Netflix', '2026-02-01'),
      expense('3', 'Netflix', '2026-03-01'),
    ])
    expect(forecastDailyFromRecurring(groups, '2026-04-03', 14)[0]).toBe(15)
    expect(forecastDailyFromRecurring(groups, '2026-04-04', 14)[0]).toBe(15)
    expect(sum(forecastDailyFromRecurring(groups, '2026-04-05', 14))).toBe(0)
    expect(forecastDailyFromRecurring(groups, '2026-04-20', 14)[11]).toBe(15)
  })

  it('counts at most one missed charge per group, so a daily habit is one charge today', () => {
    const kopi = Array.from({ length: 10 }, (_, i) =>
      expense(`k${String(i)}`, 'kopi', `2026-10-${String(i + 1).padStart(2, '0')}`, 2),
    )
    const daily = forecastDailyFromRecurring(detect(kopi), '2026-10-15', 14)
    expect(daily[0]).toBe(2)
    expect(sum(daily)).toBe(28)

    const tea = ['2026-09-20', '2026-09-22', '2026-09-24', '2026-09-26', '2026-09-28', '2026-09-30']
    const everyOtherDay = forecastDailyFromRecurring(
      detect(tea.map((d, i) => expense(`t${String(i)}`, 'bubble tea', d, 6.5))),
      '2026-10-05', // Oct 2 and Oct 4 were missed; Oct 6 is next
      14,
    )
    expect(everyOtherDay.slice(0, 4)).toEqual([6.5, 6.5, 0, 6.5])
  })

  it('steps through 28-, 30- and 31-day months on the anchor day', () => {
    const groups = detect([
      expense('1', 'Rent', '2026-01-31', 900),
      expense('2', 'Rent', '2026-02-28', 900),
      expense('3', 'Rent', '2026-03-31', 900),
    ])
    const forecast = forecastDailyFromRecurring(groups, '2026-04-30', 62)
    expect(forecast[0]).toBe(900) // Apr 30
    expect(forecast[31]).toBe(900) // May 31
    expect(forecast[61]).toBe(900) // Jun 30
    expect(sum(forecast)).toBe(2700)
  })

  it('returns an empty forecast instead of hanging on an invalid due date', () => {
    const [group] = detect([
      expense('1', 'Spotify', '2026-01-01', 12),
      expense('2', 'Spotify', '2026-02-01', 12),
      expense('3', 'Spotify', '2026-03-01', 12),
    ])
    if (!group) throw new Error('expected a recurring group')
    const forecast = forecastDailyFromRecurring(
      [{ ...group, nextDue: 'garbage' }],
      '2026-04-01',
      35,
    )
    expect(forecast).toHaveLength(35)
    expect(forecast.every((value) => value === 0)).toBe(true)
  })
})

describe('upcomingDue', () => {
  const weekly = () =>
    detect([
      expense('1', 'Laksa', '2026-09-26', 6),
      expense('2', 'Laksa', '2026-10-03', 6),
      expense('3', 'Laksa', '2026-10-10', 6),
    ])

  it('is never in the past: a charge missed 1-3 days ago is due today, like the forecast', () => {
    const [group] = weekly() // next due Oct 17
    if (!group) throw new Error('expected a recurring group')
    expect(upcomingDue(group, '2026-10-15')).toBe('2026-10-17')
    expect(upcomingDue(group, '2026-10-17')).toBe('2026-10-17')
    expect(upcomingDue(group, '2026-10-19')).toBe('2026-10-19')
    expect(forecastDailyFromRecurring([group], '2026-10-19', 14)[0]).toBe(6)
    expect(upcomingDue(group, '2026-10-21')).toBe('2026-10-24') // 4 days late: the next one
  })

  it('returns null for an unreadable due date', () => {
    const [group] = weekly()
    if (!group) throw new Error('expected a recurring group')
    expect(upcomingDue({ ...group, nextDue: 'garbage' }, '2026-10-19')).toBeNull()
  })
})

describe('detectRecurring performance', () => {
  it('handles 5,000 rows and 2,000 names well under the guard, and is free when warm', () => {
    const words = [
      'grab',
      'kopi',
      'ntuc',
      'shopee',
      'netflix',
      'gym',
      'mala',
      'bus',
      'taxi',
      'cafe',
    ]
    const rows: Expense[] = []
    for (let i = 0; i < 5000; i++) {
      const name = `${words[i % words.length] ?? 'x'} ${String(i % 2000)}`
      const day = new Date(2024, 0, 1 + ((i * 7919) % 1000), 12)
      rows.push({
        id: String(i),
        itemName: name,
        amount: 1 + (i % 50),
        category: 'Other',
        date: day.toISOString(),
        createdAt: day.toISOString(),
      })
    }
    detectRecurring(getLedgerIndex([...rows])) // warm the JIT on a different index
    // Timed against building the index for the same rows, interleaved in the same process, so a
    // loaded machine slows both sides alike (an absolute bound failed at 204 ms when three suites
    // ran at once). Best of five: a GC pause must not fail it; a regression slows every run.
    // Locally cold ≈ 2× the build; the unblocked fuzzy merge this replaced was ≈ 35×.
    let build = Number.POSITIVE_INFINITY
    let cold = Number.POSITIVE_INFINITY
    let warm = Number.POSITIVE_INFINITY
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now()
      const index = getLedgerIndex([...rows]) // fresh identity: nothing cached yet
      build = Math.min(build, performance.now() - t0)
      const t1 = performance.now()
      detectRecurring(index)
      cold = Math.min(cold, performance.now() - t1)
      const t2 = performance.now()
      detectRecurring(index)
      warm = Math.min(warm, performance.now() - t2)
    }
    expect(cold).toBeLessThan(8 * build)
    // Warm is a cache hit (microseconds). Relative, so a loaded CI box cannot fail it.
    expect(warm * 20).toBeLessThan(cold)
  })
})
