import Fuse from 'fuse.js'
import { format } from 'date-fns'

export interface ParsedExpense {
  itemName: string
  amount: number | null
  suggestedCategory?: string
  confidence?: number
  parsedDate?: string // local calendar day yyyy-MM-dd, undefined = no date in the text (today)
  raw: string
}

export interface ParseContext {
  /** The user's categories. Enables a trailing category word after the amount ("lunch 8.5 food"). */
  readonly categories?: readonly string[]
  /** The clock "today" is read from. Defaults to the current time. */
  readonly now?: Date
}

/*
 * Quick-add parser. Token based, with these invariants:
 *
 * 1. Never a future date. A day and month without a year resolve to the latest such day on or
 *    before today ("31 dec" typed on 2 Jan is last year), looking back at most a year (29 Feb).
 *    A day and month in the coming month (up to 31 days ahead) is a plan or a typo, not last
 *    year's receipt: it is not a date. An explicit date after today (ISO, d/m/yyyy or
 *    "18 oct 2027") is not read as a date and stays in the item text.
 * 2. Never lose the only amount. A date phrase that would use up the only number that can be an
 *    amount is not a date ("dec 25" is item "dec", amount 25).
 * 3. Exact month and weekday tokens only, next to a day number. Marina, Novena, Decathlon, Sephora,
 *    Maybank, Junction, Sun Plaza are names, not dates. A weekday ("sat", "sunday") is a date only
 *    as the last word or after "on", so "Sunday Folks 8" is a name.
 * 4. The amount is the currency-marked number (S$12, $4.50, 12 sgd), else the last number with
 *    decimals, else the last number. A separate currency word marks one number only ("45 sgd 2
 *    pax" is 45). Quantities ("2 pax", "2 pc", "x2"), numbers that belong to
 *    a place ("blk 123", "bus 190", "junction 8") and a year after a month word ("18 oct 2026",
 *    "dec 2025"; 19xx/20xx within ten years of today) are never the amount. The day of a day-month phrase that is not
 *    a date is the amount only when no other number can be.
 * 5. Learned mappings are read through own keys only, so "constructor" or "__proto__" never match.
 */

interface Token {
  readonly text: string
  /** Lower case without trailing punctuation ("Dec." → "dec", "4.50," → "4.50"). */
  readonly core: string
}

interface MoneyToken {
  readonly index: number
  readonly value: number
  readonly decimals: boolean
  /** Written with a currency mark, attached or as the neighbouring word. */
  readonly marked: boolean
  /** Can be the amount: not a quantity and not part of a place name. */
  readonly capable: boolean
  /** Indices of the separate currency words that mark this number ("S$ 12", "12 sgd"). */
  readonly currencyWords: readonly number[]
}

interface Day {
  readonly y: number
  readonly m: number // 0-11
  readonly d: number
}

interface DateHit {
  readonly key: string
  readonly indices: readonly number[]
}

interface DateScan {
  readonly hit: DateHit | null
  /** Numbers written as part of a date (a year and the day before it): never the amount. */
  readonly dateParts: ReadonlySet<number>
  /** The day of a day-month phrase that is not a date: the amount only if nothing else can be. */
  readonly dayLike: ReadonlySet<number>
}

/** A written date with a year: "18 oct 2026" or "Oct 18, 2026". `day` is null if it does not exist. */
interface WrittenDate {
  readonly day: Day | null
  readonly indices: readonly number[]
}

const MONEY_RE =
  /^(s\$|\$|sgd)?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+,\d{1,2}|\d*\.\d{1,2}|\d+)(sgd|\$)?$/
const DECIMAL_COMMA_RE = /^\d+,\d{1,2}$/
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MONTH_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?$/
const DAY_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/
const COUNT_RE = /^\d{1,3}$/
const COUNT_DAYS_RE = /^(\d{1,3})(?:d|days?)$/
const YEAR_RE = /^(?:19|20)\d{2}$/
const PUNCTUATION_RE = /^[-–—:,;|=.]*$/

/** A day and month up to this many days after today is a plan or a typo, not last year's date. */
const NEAR_FUTURE_DAYS = 31
/** A 19xx/20xx number after a month word is a year when it is within this many years of today. */
const YEAR_WINDOW = 10

const MONTHS = new Map<string, number>([
  ['jan', 0],
  ['january', 0],
  ['feb', 1],
  ['february', 1],
  ['mar', 2],
  ['march', 2],
  ['apr', 3],
  ['april', 3],
  ['may', 4],
  ['jun', 5],
  ['june', 5],
  ['jul', 6],
  ['july', 6],
  ['aug', 7],
  ['august', 7],
  ['sep', 8],
  ['sept', 8],
  ['september', 8],
  ['oct', 9],
  ['october', 9],
  ['nov', 10],
  ['november', 10],
  ['dec', 11],
  ['december', 11],
])

const WEEKDAYS = new Map<string, number>([
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
])

const SHORT_WEEKDAYS = new Map<string, number>([
  ['sun', 0],
  ['mon', 1],
  ['tue', 2],
  ['tues', 2],
  ['wed', 3],
  ['thu', 4],
  ['thur', 4],
  ['thurs', 4],
  ['fri', 5],
  ['sat', 6],
])

const CURRENCY_WORDS = new Set(['$', 's$', 'sgd'])
const RECURRENCE_WORDS = new Set(['monthly', 'weekly', 'yearly'])

// "2 pax", "3 pcs", "2 x", "x 2": a count of things, not money.
const UNIT_WORDS = new Set([
  'pax',
  'pc',
  'pcs',
  'piece',
  'pieces',
  'x',
  '×',
  'cup',
  'cups',
  'set',
  'sets',
  'pack',
  'packs',
  'box',
  'boxes',
  'bottle',
  'bottles',
  'ticket',
  'tickets',
  'pair',
  'pairs',
  'bowl',
  'bowls',
  'plate',
  'plates',
  'slice',
  'slices',
])

// A whole number right after one of these is part of an address or a route ("blk 123", "bus 190").
const PLACE_WORDS = new Set([
  'blk',
  'block',
  'bus',
  'level',
  'lvl',
  'unit',
  'gate',
  'terminal',
  'ave',
  'avenue',
  'st',
  'street',
  'lorong',
  'lor',
  'jalan',
  'jln',
  'stall',
  'platform',
])

// Places whose name ends in a number; only that number belongs to the name ("grab to tampines 15").
const NUMBERED_PLACES = new Map<string, readonly number[]>([
  ['junction', [8, 10]],
  ['tampines', [1]],
  ['bedok', [85]],
])

// Category aliases: the first target the user has wins.
const CATEGORY_ALIASES = new Map<string, readonly string[]>([
  ['transport', ['transport', 'transportation']],
  ['health', ['health', 'healthcare']],
  ['sub', ['subscriptions', 'subscription']],
  ['subs', ['subscriptions', 'subscription']],
  ['subscription', ['subscriptions', 'subscription']],
  ['invest', ['investment', 'investments']],
  ['grocery', ['groceries', 'food & dining']],
  ['groceries', ['groceries', 'food & dining']],
])

// ─── calendar (time-zone free arithmetic on Y-M-D) ──────────────────────────────

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
}

function shiftDays(day: Day, days: number): Day {
  const t = new Date(Date.UTC(day.y, day.m, day.d + days))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() }
}

function weekdayOf(day: Day): number {
  return new Date(Date.UTC(day.y, day.m, day.d)).getUTCDay()
}

/** Whole days from `a` to `b` (positive when `b` is later). */
function daysBetween(a: Day, b: Day): number {
  return Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86_400_000)
}

function keyOf(day: Day): string {
  return `${String(day.y)}-${String(day.m + 1).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`
}

/** An explicit calendar date, or null when it does not exist (31 Apr) or is out of range. */
function explicitDay(y: number, m: number, d: number): Day | null {
  if (y < 1900 || m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m)) return null
  return { y, m, d }
}

/**
 * The latest date with this day and month on or before today, within the last year. Null when
 * there is none (29 Feb with no leap day in the last year, 31 Apr) or when this year's date is
 * in the coming month: "oct 20" typed on Oct 18 is a plan or a typo, not a year ago.
 */
function latestDayMonth(today: Day, m: number, d: number): Day | null {
  const thisYear = explicitDay(today.y, m, d)
  if (thisYear) {
    const ahead = daysBetween(today, thisYear)
    if (ahead <= 0) return thisYear
    if (ahead <= NEAR_FUTURE_DAYS) return null
  }
  return explicitDay(today.y - 1, m, d)
}

// ─── tokens ──────────────────────────────────────────────────────────────────

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ({ text: t, core: t.toLowerCase().replace(/[.,;:!?]+$/, '') }))
}

function coreAt(tokens: readonly Token[], i: number): string {
  return tokens[i]?.core ?? ''
}

/**
 * The number each separate currency word marks, as number index → word indices. "$" and "S$" are
 * written before the amount ("S$ 12"), "sgd" after it ("12 sgd") or before it when no number
 * comes first ("SGD 15 lunch"); each falls back to the other side ("coffee 4.50 $"). A word marks
 * one number only, so the count or the day after "45 sgd" ("45 sgd 2 pax", "12 sgd 3 oct") stays
 * a plain number.
 */
function currencyMarks(tokens: readonly Token[]): Map<number, number[]> {
  const isNumber = (i: number) => MONEY_RE.exec(coreAt(tokens, i))?.[2] !== undefined
  const marks = new Map<number, number[]>()
  tokens.forEach((token, i) => {
    if (!CURRENCY_WORDS.has(token.core)) return
    const sides = token.core === 'sgd' ? [i - 1, i + 1] : [i + 1, i - 1]
    const target = sides.find(isNumber)
    if (target === undefined) return
    marks.set(target, [...(marks.get(target) ?? []), i])
  })
  return marks
}

function readMoney(tokens: readonly Token[]): MoneyToken[] {
  const out: MoneyToken[] = []
  const marks = currencyMarks(tokens)
  tokens.forEach((token, index) => {
    const match = MONEY_RE.exec(token.core)
    const digits = match?.[2]
    if (!match || digits === undefined) return
    const value = DECIMAL_COMMA_RE.test(digits)
      ? Number(digits.replace(',', '.'))
      : Number(digits.replace(/,/g, ''))
    if (!Number.isFinite(value)) return

    const prev = coreAt(tokens, index - 1)
    const next = coreAt(tokens, index + 1)
    const currencyWords = marks.get(index) ?? []
    const decimals = digits.includes('.') || DECIMAL_COMMA_RE.test(digits)
    const marked = match[1] !== undefined || match[3] !== undefined || currencyWords.length > 0
    const plain = !decimals && !marked
    const quantity = plain && (UNIT_WORDS.has(next) || prev === 'x' || prev === '×')
    const place =
      plain && (PLACE_WORDS.has(prev) || (NUMBERED_PLACES.get(prev)?.includes(value) ?? false))
    out.push({ index, value, decimals, marked, capable: !quantity && !place, currencyWords })
  })
  return out
}

// ─── dates ───────────────────────────────────────────────────────────────────

/**
 * Dates written with a separate year ("18 oct 2026", "Oct 18, 2026", "25/12 2026") and years after
 * a month ("dec 2025"). Their numbers are never the amount.
 */
function writtenDates(
  tokens: readonly Token[],
  isYear: (i: number) => boolean,
  dayNumber: (i: number) => number | null,
): { dates: WrittenDate[]; parts: Set<number> } {
  const dates: WrittenDate[] = []
  const parts = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    const dm = DAY_MONTH_RE.exec(coreAt(tokens, i))
    if (dm && dm[3] === undefined && isYear(i + 1)) {
      parts.add(i + 1)
      const day = explicitDay(Number(coreAt(tokens, i + 1)), Number(dm[2]) - 1, Number(dm[1]))
      dates.push({ day, indices: [i, i + 1] })
      continue
    }
    const m = MONTHS.get(coreAt(tokens, i))
    if (m === undefined) continue
    if (isYear(i + 1)) {
      const y = Number(coreAt(tokens, i + 1))
      const d = parts.has(i - 1) ? null : dayNumber(i - 1)
      parts.add(i + 1)
      if (d === null) continue // "dec 2025": a month and year, not a day
      parts.add(i - 1)
      dates.push({ day: explicitDay(y, m, d), indices: [i - 1, i, i + 1] })
      continue
    }
    const d = dayNumber(i + 1)
    if (d !== null && isYear(i + 2)) {
      parts.add(i + 1)
      parts.add(i + 2)
      dates.push({
        day: explicitDay(Number(coreAt(tokens, i + 2)), m, d),
        indices: [i, i + 1, i + 2],
      })
    }
  }
  return { dates, parts }
}

function scanDates(
  tokens: readonly Token[],
  money: readonly MoneyToken[],
  today: Day,
  isTrailingWord: (core: string) => boolean,
): DateScan {
  const todayKey = keyOf(today)
  const moneyAt = new Map(money.map((m) => [m.index, m]))
  const dayNumber = (i: number): number | null => {
    if (moneyAt.get(i)?.marked) return null
    const match = DAY_RE.exec(coreAt(tokens, i))
    return match?.[1] ? Number(match[1]) : null
  }
  // A year near today; further away a number like 1999 is more likely a price ("laptop 1 oct 1999").
  const isYear = (i: number) => {
    const m = moneyAt.get(i)
    return (
      m !== undefined &&
      !m.marked &&
      !m.decimals &&
      YEAR_RE.test(coreAt(tokens, i)) &&
      Math.abs(m.value - today.y) <= YEAR_WINDOW
    )
  }

  const written = writtenDates(tokens, isYear, dayNumber)
  const dateParts = written.parts
  const inWritten = new Set(written.dates.flatMap((w) => w.indices))
  const dayLike = new Set<number>()
  const capable = money.filter((m) => m.capable && !dateParts.has(m.index)).map((m) => m.index)

  // Invariant 2: a phrase that uses up the only possible amount is not a date.
  const keepsAmount = (indices: readonly number[]) => {
    const used = new Set(indices)
    return !capable.some((i) => used.has(i)) || capable.some((i) => !used.has(i))
  }
  // An "on" right before the phrase belongs to it ("grab 12 on 3 oct").
  const accept = (day: Day | null, indices: readonly number[]): DateHit | null => {
    if (!day) return null
    const key = keyOf(day)
    if (key > todayKey || !keepsAmount(indices)) return null
    const start = Math.min(...indices)
    return { key, indices: coreAt(tokens, start - 1) === 'on' ? [start - 1, ...indices] : indices }
  }
  const pairDay = (i: number): number | null => (dateParts.has(i) ? null : dayNumber(i))
  const onOrBefore = (weekday: number) => shiftDays(today, -((weekdayOf(today) - weekday + 7) % 7))
  const strictlyBefore = (weekday: number) =>
    shiftDays(today, -((weekdayOf(today) - weekday + 7) % 7 || 7))
  const isWord = (j: number) =>
    !moneyAt.has(j) &&
    !CURRENCY_WORDS.has(coreAt(tokens, j)) &&
    !PUNCTUATION_RE.test(coreAt(tokens, j))

  const passes: ((i: number) => DateHit | null)[] = [
    // Explicit dates: ISO and day-first d/m(/yy).
    (i) => {
      if (inWritten.has(i)) return null
      const iso = ISO_RE.exec(coreAt(tokens, i))
      if (iso) return accept(explicitDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])), [i])
      const dm = DAY_MONTH_RE.exec(coreAt(tokens, i))
      if (!dm) return null
      const d = Number(dm[1])
      const m = Number(dm[2]) - 1
      const year = dm[3]
      if (year === undefined) return accept(latestDayMonth(today, m, d), [i])
      return accept(explicitDay(year.length === 2 ? 2000 + Number(year) : Number(year), m, d), [i])
    },
    // A date written with its year: "18 oct 2026", "Oct 18, 2026", "25/12 2026".
    (i) => {
      const date = written.dates.find((w) => w.indices[0] === i)
      return date ? accept(date.day, date.indices) : null
    },
    // Relative words.
    (i) => {
      const word = coreAt(tokens, i)
      const next = coreAt(tokens, i + 1)
      if (word === 'today') return accept(today, [i])
      if (word === 'yesterday' || word === 'yday') return accept(shiftDays(today, -1), [i])
      if (word === 'last') {
        if (next === 'week') return accept(shiftDays(today, -7), [i, i + 1])
        const weekday = WEEKDAYS.get(next) ?? SHORT_WEEKDAYS.get(next)
        return weekday === undefined ? null : accept(strictlyBefore(weekday), [i, i + 1])
      }
      const attached = COUNT_DAYS_RE.exec(word)
      if (attached && next === 'ago') {
        return accept(shiftDays(today, -Number(attached[1])), [i, i + 1])
      }
      if (
        COUNT_RE.test(word) &&
        !moneyAt.get(i)?.marked &&
        (next === 'day' || next === 'days') &&
        coreAt(tokens, i + 2) === 'ago'
      ) {
        return accept(shiftDays(today, -Number(word)), [i, i + 1, i + 2])
      }
      return null
    },
    // A day and month: "31 dec" (day first, the Singapore order), else "dec 31". A month pairs
    // with one day only, so a declined "19 oct" never becomes "oct 3" in "kopi 19 oct 3".
    (i) => {
      const m = MONTHS.get(coreAt(tokens, i))
      if (m === undefined || inWritten.has(i)) return null
      const before = pairDay(i - 1)
      const dayAt = before === null ? i + 1 : i - 1
      const d = before ?? pairDay(i + 1)
      if (d === null) return null
      const hit = accept(latestDayMonth(today, m, d), dayAt < i ? [dayAt, i] : [i, dayAt])
      if (!hit) dayLike.add(dayAt)
      return hit
    },
    // A weekday name: the latest such day on or before today, only after "on" or as the last
    // word (before any trailing category or recurrence words), and never the only word, so
    // "Sun Plaza" and "Sunday Folks" are names.
    (i) => {
      const word = coreAt(tokens, i)
      const weekday = WEEKDAYS.get(word) ?? SHORT_WEEKDAYS.get(word)
      if (weekday === undefined) return null
      if (coreAt(tokens, i - 1) !== 'on') {
        const words = tokens.map((_, j) => j).filter(isWord)
        const after = words.filter((j) => j > i)
        const others = words.filter((j) => j < i).length
        if (others === 0 || !after.every((j) => isTrailingWord(coreAt(tokens, j)))) return null
      }
      return accept(onOrBefore(weekday), [i])
    },
  ]

  for (const pass of passes) {
    for (let i = 0; i < tokens.length; i++) {
      const hit = pass(i)
      if (hit) return { hit, dateParts, dayLike }
    }
  }
  return { hit: null, dateParts, dayLike }
}

// ─── amount ──────────────────────────────────────────────────────────────────

function chooseAmount(
  money: readonly MoneyToken[],
  used: ReadonlySet<number>,
  scan: DateScan,
): MoneyToken | null {
  const usable = money.filter(
    (m) => m.capable && !used.has(m.index) && !scan.dateParts.has(m.index),
  )
  const preferred = usable.filter((m) => !scan.dayLike.has(m.index))
  const candidates = preferred.length > 0 ? preferred : usable
  const last = (list: readonly MoneyToken[]) => list[list.length - 1]
  return (
    last(candidates.filter((m) => m.marked)) ??
    last(candidates.filter((m) => m.decimals)) ??
    last(candidates) ??
    null
  )
}

// ─── categories ──────────────────────────────────────────────────────────────

const categoryIndexCache = new WeakMap<readonly string[], ReadonlyMap<string, string>>()

/** word → category: full names, unique first words ("food" → "Food & Dining") and aliases. */
function categoryIndex(categories: readonly string[]): ReadonlyMap<string, string> {
  const cached = categoryIndexCache.get(categories)
  if (cached) return cached

  const byName = new Map<string, string>()
  for (const category of categories) byName.set(category.toLowerCase(), category)

  const byFirstWord = new Map<string, string | null>()
  for (const category of categories) {
    const first = /^[a-z]+/.exec(category.toLowerCase())?.[0]
    if (!first || first.length < 3) continue
    byFirstWord.set(first, byFirstWord.has(first) ? null : category)
  }

  const index = new Map<string, string>()
  for (const [alias, targets] of CATEGORY_ALIASES) {
    const target = targets.map((t) => byName.get(t)).find((c) => c !== undefined)
    if (target !== undefined) index.set(alias, target)
  }
  for (const [word, category] of byFirstWord) if (category !== null) index.set(word, category)
  for (const [name, category] of byName) index.set(name, category)

  categoryIndexCache.set(categories, index)
  return index
}

// ─── learned mappings ────────────────────────────────────────────────────────

/*
 * The fuzzy fallback returns exactly the top hit of `new Fuse(Object.keys(mappings), { threshold:
 * 0.4 }).search(item)` (same key, same score; a seeded test checks this against Fuse) without
 * running Fuse's bitap over every key on every keystroke:
 *
 * - Fuse accepts a key only when part of it is within `floor(0.4 × length)` edits of the query
 *   (score = edits / length + start / 100 ≤ 0.4). Myers' bit-vector algorithm gives the fewest
 *   edits against any part of a key in one pass, which rules most keys out and gives a floor for
 *   the rest. Queries longer than Fuse's 32-character word are not pruned.
 * - The rest are scored best-first with `Fuse.match` (the same bitap) and Fuse's field-length norm
 *   (`score ^ (1 / √words)`), stopping once no remaining key can beat the best. Ties keep the
 *   earlier key, as Fuse does.
 */

interface MappingKey {
  readonly key: string
  readonly lower: string
  readonly norm: number
}

const FUSE_THRESHOLD = 0.4
const FUSE_MAX_PATTERN = 32
const FUSE_OPTIONS = { threshold: FUSE_THRESHOLD }

const mappingKeysCache = new WeakMap<Readonly<Record<string, string>>, readonly MappingKey[]>()
// Myers' match masks: bit i is set for the query's i-th character, by UTF-16 code unit. 256 KB,
// so it is allocated on the first fuzzy lookup rather than when the app loads.
let queryMasks: Int32Array | null = null

/** Fuse's field-length norm: 1 / √(word count), words split on runs of spaces, 3 decimals. */
function fuseNorm(text: string): number {
  return Math.round(1000 / Math.sqrt(text.split(/ +/).length)) / 1000
}

function mappingKeys(mappings: Readonly<Record<string, string>>): readonly MappingKey[] {
  let keys = mappingKeysCache.get(mappings)
  if (!keys) {
    keys = Object.keys(mappings).map((key) => {
      const lower = key.toLowerCase()
      return { key, lower, norm: fuseNorm(lower) }
    })
    mappingKeysCache.set(mappings, keys)
  }
  return keys
}

/** Fewest edits between the query loaded in `masks` (length 1-32) and any part of `text`. */
function fewestEdits(masks: Int32Array, text: string, length: number): number {
  const last = 1 << (length - 1)
  let pv = -1
  let mv = 0
  let edits = length
  let fewest = length
  for (let j = 0; j < text.length; j++) {
    const eq = masks[text.charCodeAt(j)] ?? 0
    const xv = eq | mv
    const xh = (((eq & pv) + pv) ^ pv) | eq
    let ph = mv | ~(xh | pv)
    let mh = pv & xh
    if (ph & last) edits++
    else if (mh & last) edits--
    fewest = Math.min(fewest, edits)
    ph <<= 1
    mh <<= 1
    pv = mh | ~(xv | ph)
    mv = ph & xv
  }
  return fewest
}

/** The lowest final score Fuse could give this key, or null when Fuse cannot match it. */
function scoreFloor(
  masks: Int32Array,
  entry: MappingKey,
  query: string,
  maxEdits: number,
): number | null {
  if (entry.lower === query || query.length > FUSE_MAX_PATTERN) return 0
  const edits = fewestEdits(masks, entry.lower, query.length)
  if (edits > maxEdits) return null
  if (maxEdits > 0) return Math.pow(Math.max(0.001, edits / query.length), entry.norm)
  // One or two characters allow no edits: Fuse scores the first exact occurrence by its start.
  const start = entry.lower.indexOf(query) / 100
  return start > FUSE_THRESHOLD ? null : Math.pow(Math.max(0.001, start), entry.norm)
}

function closestMappingKey(
  keys: readonly MappingKey[],
  query: string,
): { key: string; score: number } | null {
  const maxEdits = Math.floor(query.length * FUSE_THRESHOLD)
  const candidates: { entry: MappingKey; order: number; floor: number }[] = []
  const loaded = query.length <= FUSE_MAX_PATTERN
  const masks = (queryMasks ??= new Int32Array(65536))
  try {
    if (loaded) {
      for (let i = 0; i < query.length; i++) {
        const c = query.charCodeAt(i)
        masks[c] = (masks[c] ?? 0) | (1 << i)
      }
    }
    keys.forEach((entry, order) => {
      const floor = scoreFloor(masks, entry, query, maxEdits)
      if (floor !== null) candidates.push({ entry, order, floor })
    })
  } finally {
    if (loaded) for (let i = 0; i < query.length; i++) masks[query.charCodeAt(i)] = 0
  }

  candidates.sort((a, b) => a.floor - b.floor || a.order - b.order)
  let best: { key: string; score: number; order: number } | null = null
  for (const { entry, order, floor } of candidates) {
    if (best && (floor > best.score || (floor === best.score && order > best.order))) break
    const match = Fuse.match(query, entry.key, FUSE_OPTIONS)
    if (!match.isMatch) continue
    const score = Math.pow(match.score, entry.norm)
    if (!best || score < best.score || (score === best.score && order < best.order)) {
      best = { key: entry.key, score, order }
    }
  }
  return best
}

function learnedCategory(
  item: string,
  mappings: Readonly<Record<string, string>>,
): { category: string; confidence: number } | null {
  const lower = item.toLowerCase()
  if (Object.hasOwn(mappings, lower)) {
    const exact = mappings[lower]
    if (typeof exact === 'string') return { category: exact, confidence: 1 }
  }

  const hit = closestMappingKey(mappingKeys(mappings), lower)
  const category = hit ? mappings[hit.key] : undefined
  return hit && typeof category === 'string' ? { category, confidence: 1 - hit.score } : null
}

// ─── parse ───────────────────────────────────────────────────────────────────

export function parseExpense(
  raw: string,
  mappings: Readonly<Record<string, string>>,
  ctx: ParseContext = {},
): ParsedExpense {
  const text = raw.trim()
  const result: ParsedExpense = { itemName: '', amount: null, raw: text }
  if (!text) return result

  const now = ctx.now ?? new Date()
  const today: Day = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() }
  const tokens = tokenize(text)
  const money = readMoney(tokens)

  const categories = ctx.categories ? categoryIndex(ctx.categories) : null
  const isTrailingWord = (core: string) =>
    RECURRENCE_WORDS.has(core) || (categories?.has(core) ?? false)

  const used = new Set<number>()
  const scan = scanDates(tokens, money, today, isTrailingWord)
  if (scan.hit) {
    result.parsedDate = scan.hit.key
    for (const i of scan.hit.indices) used.add(i)
  }

  const amount = chooseAmount(money, used, scan)
  if (amount) {
    result.amount = amount.value
    used.add(amount.index)
    for (const i of amount.currencyWords) used.add(i)
  }

  const item = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => !used.has(index) && !PUNCTUATION_RE.test(token.core))

  // Trailing words: recurrence hints are dropped; one category word after the amount sets the
  // category. The item always keeps at least one word.
  while (item.length > 1) {
    const last = item.at(-1)
    if (!last) break
    if (RECURRENCE_WORDS.has(last.token.core)) {
      item.pop()
      continue
    }
    const category =
      categories && amount && last.index > amount.index && result.suggestedCategory === undefined
        ? categories.get(last.token.core)
        : undefined
    if (category === undefined) break
    result.suggestedCategory = category
    result.confidence = 1
    item.pop()
  }

  result.itemName = item
    .map(({ token }) => token.text)
    .join(' ')
    .replace(/[,;:]+$/, '')
  if (!result.itemName || result.suggestedCategory !== undefined) return result

  const learned = learnedCategory(result.itemName, mappings)
  if (learned) {
    result.suggestedCategory = learned.category
    result.confidence = learned.confidence
  }
  return result
}

// ─── quick-add dates ─────────────────────────────────────────────────────────

function todayKeyOf(now: Date): string {
  return keyOf({ y: now.getFullYear(), m: now.getMonth(), d: now.getDate() })
}

/** The stored date of a quick add: its parsed day, or today, at local noon (as the entry sheets store it). */
export function quickAddStoredDate(parsedDate: string | undefined, now: Date = new Date()): string {
  return new Date(`${parsedDate ?? todayKeyOf(now)}T12:00:00`).toISOString()
}

/** "Oct 17" for another day this year, "Dec 31, 2025" for another year, null for today. */
export function quickAddDateLabel(
  parsedDate: string | undefined,
  now: Date = new Date(),
): string | null {
  const today = todayKeyOf(now)
  if (parsedDate === undefined || parsedDate === today) return null
  const pattern = parsedDate.slice(0, 4) === today.slice(0, 4) ? 'MMM d' : 'MMM d, yyyy'
  return format(new Date(`${parsedDate}T12:00:00`), pattern)
}
