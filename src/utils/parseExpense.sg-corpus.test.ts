import { describe, expect, it } from 'vitest'
import { format } from 'date-fns'
import { DEFAULT_CATEGORIES } from '../constants'
import { parseExpense } from './parseExpense'

// Singapore quick-add corpus: place and brand names, local amount styles and date phrases, typed the
// way they are typed on a phone. Clocks are built from local components so they mean the same wall
// time in every CI time zone (Asia/Singapore, Pacific/Honolulu, Pacific/Kiritimati).
const SUN_18_OCT_2026 = new Date(2026, 9, 18, 9, 30)
const SAT_2_JAN_2027 = new Date(2027, 0, 2, 20, 15)

interface Row {
  input: string
  item: string
  amount: number | null
  /** yyyy-MM-dd; omitted = no date in the text (the entry is for today). */
  date?: string
  category?: string
}

// No date in the text: the result is the same on any day.
const UNDATED: Row[] = [
  // Place and brand names that contain (or start like) month and weekday words.
  { input: 'junction 8 dinner 15', item: 'junction 8 dinner', amount: 15 },
  { input: 'grab novena 12', item: 'grab novena', amount: 12 },
  { input: 'decathlon 25', item: 'decathlon', amount: 25 },
  { input: 'sephora 30', item: 'sephora', amount: 30 },
  { input: 'grab to marina 12', item: 'grab to marina', amount: 12 },
  { input: 'wet market 5', item: 'wet market', amount: 5 },
  { input: 'kopi 2 novena', item: 'kopi novena', amount: 2 },
  { input: 'novena 5', item: 'novena', amount: 5 },
  { input: 'grab 18 junction 8', item: 'grab junction 8', amount: 18 },
  { input: 'grab 12 marine parade', item: 'grab marine parade', amount: 12 },
  { input: 'marine parade laksa 6', item: 'marine parade laksa', amount: 6 },
  { input: 'jurong point lunch 9.80', item: 'jurong point lunch', amount: 9.8 },
  { input: 'Marina Bay Sands 45', item: 'Marina Bay Sands', amount: 45 },
  { input: 'ang mo kio hawker 4.5', item: 'ang mo kio hawker', amount: 4.5 },
  { input: 'paya lebar grab 11.20', item: 'paya lebar grab', amount: 11.2 },
  { input: 'junction 10 movie 13.50', item: 'junction 10 movie', amount: 13.5 },
  { input: 'Tampines 1 uniqlo 39.90', item: 'Tampines 1 uniqlo', amount: 39.9 },
  { input: 'grab to tampines 15', item: 'grab to tampines', amount: 15 },
  { input: 'NEX food court 6', item: 'NEX food court', amount: 6 },
  { input: 'Bugis+ arcade 20', item: 'Bugis+ arcade', amount: 20 },
  { input: 'kopitiam 5.20', item: 'kopitiam', amount: 5.2 },
  { input: 'sun plaza dinner 12', item: 'sun plaza dinner', amount: 12 },
  { input: 'maybank atm fee 2', item: 'maybank atm fee', amount: 2 },
  { input: 'octopus card 10', item: 'octopus card', amount: 10 },
  { input: 'mayo sandwich 6', item: 'mayo sandwich', amount: 6 },
  { input: 'Junes cafe 14', item: 'Junes cafe', amount: 14 },
  { input: '313@somerset 25', item: '313@somerset', amount: 25 },
  { input: '7-Eleven 3.20', item: '7-Eleven', amount: 3.2 },
  { input: 'blk 123 chicken rice 4.5', item: 'blk 123 chicken rice', amount: 4.5 },
  { input: 'bus 190 1.80', item: 'bus 190', amount: 1.8 },
  { input: 'bus 190', item: 'bus 190', amount: null },
  // A place or count number is never guessed to be the amount, even alone (a wrong amount
  // saved silently is worse than one more word); a marked or decimal fare always counts.
  { input: 'bus 2', item: 'bus 2', amount: null },
  { input: 'kopi 2 cups', item: 'kopi 2 cups', amount: null },
  { input: 'bus $2', item: 'bus', amount: 2 },
  { input: 'bus 2.00', item: 'bus', amount: 2 },
  { input: 'level 3 food court 7', item: 'level 3 food court', amount: 7 },
  { input: 'gate 5 duty free 60', item: 'gate 5 duty free', amount: 60 },
  { input: 'terminal 3 coffee 7.20', item: 'terminal 3 coffee', amount: 7.2 },
  { input: 'stall 12 fishball noodles 4', item: 'stall 12 fishball noodles', amount: 4 },
  { input: 'amk ave 3 prata 4', item: 'amk ave 3 prata', amount: 4 },
  { input: 'kopi 3 sets 6.40', item: 'kopi 3 sets', amount: 6.4 },
  // A month word without an adjacent day is just a word; a day phrase never eats the only amount.
  { input: 'march 12', item: 'march', amount: 12 },
  { input: 'dec 25', item: 'dec', amount: 25 },
  { input: 'grab 2 days ago', item: 'grab days ago', amount: 2 },
  { input: 'apr 31 lunch 10', item: 'apr 31 lunch', amount: 10 },
  // A weekday is a date only as the last word (never the only word) or after "on": brand names
  // that start with one stay names.
  { input: 'sat 5', item: 'sat', amount: 5 },
  { input: 'Sunday Folks 8', item: 'Sunday Folks', amount: 8 },
  { input: 'sunday folks 8.50', item: 'sunday folks', amount: 8.5 },
  { input: 'Monday Blues bar 20', item: 'Monday Blues bar', amount: 20 },
  // A 19xx/20xx year written after a month is part of the date, never the amount; a written
  // date after today is not a date and stays in the name.
  { input: 'rent oct 2026 1500', item: 'rent oct 2026', amount: 1500 },
  { input: 'spotify dec 2025', item: 'spotify dec 2025', amount: null },
  { input: '18 oct 2027 x 5', item: '18 oct 2027 x 5', amount: null },
  { input: 'flight 450 25 dec 2027', item: 'flight 25 dec 2027', amount: 450 },
  // Quantities are not money.
  { input: 'mala 2 pax 18', item: 'mala 2 pax', amount: 18 },
  { input: 'mala 2 pax', item: 'mala 2 pax', amount: null },
  { input: '2 kopi 3.40', item: '2 kopi', amount: 3.4 },
  { input: '2 kopi 3', item: '2 kopi', amount: 3 },
  { input: 'mcd 2 pc meal 8.90', item: 'mcd 2 pc meal', amount: 8.9 },
  { input: 'kopi x2 3.60', item: 'kopi x2', amount: 3.6 },
  { input: '2x kopi 3.60', item: '2x kopi', amount: 3.6 },
  { input: 'kopi 3.60 x 2', item: 'kopi x 2', amount: 3.6 },
  { input: '2 set lunch 13', item: '2 set lunch', amount: 13 },
  // Currency marks, thousands and decimal commas.
  { input: 'S$12 grab', item: 'grab', amount: 12 },
  { input: 's$ 12 grab', item: 'grab', amount: 12 },
  { input: 'chicken rice S$5', item: 'chicken rice', amount: 5 },
  { input: '$4.50 coffee', item: 'coffee', amount: 4.5 },
  { input: 'coffee 4.5 sgd', item: 'coffee', amount: 4.5 },
  { input: 'SGD 15 lunch', item: 'lunch', amount: 15 },
  { input: 'lunch sgd15', item: 'lunch', amount: 15 },
  { input: 'lunch 15SGD', item: 'lunch', amount: 15 },
  { input: '3 kopi S$4.20', item: '3 kopi', amount: 4.2 },
  // A separate currency word marks one number only: "$"/"S$" the next, "sgd" the one before
  // (or the next when none comes before), so a count after "45 sgd" is still a count.
  { input: 'dinner 45 sgd 2 pax', item: 'dinner 2 pax', amount: 45 },
  { input: 'movie 25 sgd 2 tickets', item: 'movie 2 tickets', amount: 25 },
  { input: 'hotpot S$ 80 4 pax', item: 'hotpot 4 pax', amount: 80 },
  { input: '$ 5 kopi 2 cups', item: 'kopi 2 cups', amount: 5 },
  { input: 'coffee 4.50 $', item: 'coffee', amount: 4.5 },
  // A currency mark beats decimals.
  { input: 'S$12 lunch 2.50', item: 'lunch 2.50', amount: 12 },
  { input: 'grab 1,200', item: 'grab', amount: 1200 },
  { input: 'laptop 1,899.00', item: 'laptop', amount: 1899 },
  { input: 'tickets 12,500.50', item: 'tickets', amount: 12500.5 },
  { input: 'shopee 12,50', item: 'shopee', amount: 12.5 },
  { input: 'grab 12.555', item: 'grab 12.555', amount: null },
  { input: 'coffee .80', item: 'coffee', amount: 0.8 },
  // Recurrence words are dropped from the item when they trail it.
  { input: 'netflix 15 monthly', item: 'netflix', amount: 15 },
  { input: 'gym 120 yearly', item: 'gym', amount: 120 },
  { input: 'monthly pass 128', item: 'monthly pass', amount: 128 },
  // A trailing category word after the amount sets the category.
  { input: 'lunch 8.5 food', item: 'lunch', amount: 8.5, category: 'Food & Dining' },
  { input: 'grab 15 transport', item: 'grab', amount: 15, category: 'Transportation' },
  { input: 'panadol 8 health', item: 'panadol', amount: 8, category: 'Healthcare' },
  {
    input: 'spotify 10.98 subs monthly',
    item: 'spotify',
    amount: 10.98,
    category: 'Subscriptions',
  },
  { input: 'fairprice 45 groceries', item: 'fairprice', amount: 45, category: 'Food & Dining' },
  { input: 'bowling 18 social', item: 'bowling', amount: 18, category: 'Social & Leisure' },
  { input: 'shirt 25 Shopping', item: 'shirt', amount: 25, category: 'Shopping' },
  { input: 'syfe 500 invest', item: 'syfe', amount: 500, category: 'Investment' },
  { input: 'steam 15 gaming', item: 'steam', amount: 15, category: 'Gaming' },
  { input: 'food 8', item: 'food', amount: 8 },
  { input: 'gaming 20', item: 'gaming', amount: 20 },
  { input: '8 food', item: 'food', amount: 8 },
]

// Date phrases on Sun 18 Oct 2026.
const ON_SUN_18_OCT_2026: Row[] = [
  { input: 'lunch 8.90 2026-05-01', item: 'lunch', amount: 8.9, date: '2026-05-01' },
  { input: 'coffee 4.50 31 dec', item: 'coffee', amount: 4.5, date: '2025-12-31' },
  { input: 'bubble tea 6.5 sat', item: 'bubble tea', amount: 6.5, date: '2026-10-17' },
  { input: 'bubble tea sat 6.5', item: 'bubble tea', amount: 6.5, date: '2026-10-17' },
  { input: 'grab last fri 14', item: 'grab', amount: 14, date: '2026-10-16' },
  { input: 'grab 12 yesterday', item: 'grab', amount: 12, date: '2026-10-17' },
  { input: 'taxi 22 yday', item: 'taxi', amount: 22, date: '2026-10-17' },
  { input: 'kopi 1.80 today', item: 'kopi', amount: 1.8, date: '2026-10-18' },
  { input: 'chicken rice 5 3 days ago', item: 'chicken rice', amount: 5, date: '2026-10-15' },
  { input: 'grab 9 2 days ago', item: 'grab', amount: 9, date: '2026-10-16' },
  { input: 'hotpot 60 last week', item: 'hotpot', amount: 60, date: '2026-10-11' },
  { input: 'movie 13 saturday', item: 'movie', amount: 13, date: '2026-10-17' },
  { input: 'brunch 25 sunday', item: 'brunch', amount: 25, date: '2026-10-18' },
  { input: 'brunch 25 last sun', item: 'brunch', amount: 25, date: '2026-10-11' },
  { input: 'Mar 3 lunch 12', item: 'lunch', amount: 12, date: '2026-03-03' },
  { input: 'lunch 12 3 mar', item: 'lunch', amount: 12, date: '2026-03-03' },
  { input: 'xmas dinner 25 dec 80', item: 'xmas dinner', amount: 80, date: '2025-12-25' },
  { input: 'kaya toast 2.80 1st oct', item: 'kaya toast', amount: 2.8, date: '2026-10-01' },
  { input: 'sushi 30.50 Oct. 2', item: 'sushi', amount: 30.5, date: '2026-10-02' },
  { input: 'dinner 12 30 sep', item: 'dinner', amount: 12, date: '2026-09-30' },
  { input: 'jan 5 haircut 15', item: 'haircut', amount: 15, date: '2026-01-05' },
  { input: 'haircut 15 3/10', item: 'haircut', amount: 15, date: '2026-10-03' },
  { input: 'haircut 15 3/10/26', item: 'haircut', amount: 15, date: '2026-10-03' },
  { input: 'gift 30 25/12', item: 'gift', amount: 30, date: '2025-12-25' },
  { input: 'flight 450 25/12/2026', item: 'flight 25/12/2026', amount: 450 },
  { input: 'concert 88 2026-12-01', item: 'concert 2026-12-01', amount: 88 },
  { input: 'novena dinner 30 2 oct', item: 'novena dinner', amount: 30, date: '2026-10-02' },
  // The day after "<amount> sgd" is a day, not a second currency-marked amount.
  { input: 'lunch 12.50 sgd 3 oct', item: 'lunch', amount: 12.5, date: '2026-10-03' },
  { input: 'grab 12 SGD 16 oct', item: 'grab', amount: 12, date: '2026-10-16' },
  { input: 'dinner 25 sgd 2 days ago', item: 'dinner', amount: 25, date: '2026-10-16' },
  { input: 'taxi 15 sgd yesterday', item: 'taxi', amount: 15, date: '2026-10-17' },
  { input: 'S$ 9 3 oct kopi', item: 'kopi', amount: 9, date: '2026-10-03' },
  {
    input: 'lunch 8.5 yesterday food',
    item: 'lunch',
    amount: 8.5,
    date: '2026-10-17',
    category: 'Food & Dining',
  },
  // Day, month and year (the usual Singapore way of writing a date): the year never wins the
  // amount, and the whole phrase leaves the name.
  { input: 'taxi 15 18 oct 2026', item: 'taxi', amount: 15, date: '2026-10-18' },
  { input: 'grab 12 on 12 oct 2026', item: 'grab', amount: 12, date: '2026-10-12' },
  { input: 'lunch 17 oct 2026', item: 'lunch', amount: null, date: '2026-10-17' },
  { input: 'grab 16 oct 2026 12', item: 'grab', amount: 12, date: '2026-10-16' },
  { input: 'taxi 15 oct 16 2026', item: 'taxi', amount: 15, date: '2026-10-16' },
  { input: 'hotel 180 Oct. 3, 2026', item: 'hotel', amount: 180, date: '2026-10-03' },
  { input: 'dinner 12 30 sep 2025', item: 'dinner', amount: 12, date: '2025-09-30' },
  // Far from today, a 19xx number is a price.
  { input: 'laptop 1 oct 1999', item: 'laptop', amount: 1999, date: '2026-10-01' },
  // "on" before a date is part of the date phrase.
  { input: 'lunch on monday 12', item: 'lunch', amount: 12, date: '2026-10-12' },
  { input: 'kopi 2 on sat', item: 'kopi', amount: 2, date: '2026-10-17' },
  // Trailing category and recurrence words do not stop a weekday from being the last word.
  {
    input: 'lunch 8.5 saturday food',
    item: 'lunch',
    amount: 8.5,
    date: '2026-10-17',
    category: 'Food & Dining',
  },
  { input: 'gym 30 monday weekly', item: 'gym', amount: 30, date: '2026-10-12' },
  // A day and month in the coming month is a plan or a typo, not last year's receipt: it stays
  // in the name and the entry is for today. Its day number is not the amount.
  { input: 'flight oct 20 450', item: 'flight oct 20', amount: 450 },
  { input: 'kopi 19 oct 3', item: 'kopi 19 oct', amount: 3 },
  { input: 'grab 20/10 12', item: 'grab 20/10', amount: 12 },
  { input: 'lunch 29 feb 5', item: 'lunch 29 feb', amount: 5 },
]

// Date phrases on Sat 2 Jan 2027: a day-month without a year never lands in the future.
const ON_SAT_2_JAN_2027: Row[] = [
  { input: 'nye dinner 31 dec 85', item: 'nye dinner', amount: 85, date: '2026-12-31' },
  { input: 'coffee 4.50 31 dec', item: 'coffee', amount: 4.5, date: '2026-12-31' },
  {
    input: 'countdown drinks 40 yesterday',
    item: 'countdown drinks',
    amount: 40,
    date: '2027-01-01',
  },
  { input: 'grab last fri 14', item: 'grab', amount: 14, date: '2027-01-01' },
  { input: 'lunch 8 fri', item: 'lunch', amount: 8, date: '2027-01-01' },
  { input: 'brunch 20 sat', item: 'brunch', amount: 20, date: '2027-01-02' },
  { input: 'brunch 20 last sat', item: 'brunch', amount: 20, date: '2026-12-26' },
  { input: 'gift 30 25/12', item: 'gift', amount: 30, date: '2026-12-25' },
  { input: 'concert 60 3/3', item: 'concert', amount: 60, date: '2026-03-03' },
  // Tomorrow is not last year: 3 Jan typed on 2 Jan stays in the name.
  { input: 'concert 60 3/1', item: 'concert 3/1', amount: 60 },
  { input: 'Mar 3 lunch 12', item: 'lunch', amount: 12, date: '2026-03-03' },
  { input: 'hotpot 60 last week', item: 'hotpot', amount: 60, date: '2026-12-26' },
  { input: 'cake 10 28 feb', item: 'cake', amount: 10, date: '2026-02-28' },
  // No 29 Feb in the last year: not a date (the row would otherwise land in 2024).
  { input: 'cake 10 29 feb', item: 'cake 29 feb', amount: 10 },
  { input: 'party 40 31 dec 2026', item: 'party', amount: 40, date: '2026-12-31' },
  { input: 'gift 30 25/12 2026', item: 'gift', amount: 30, date: '2026-12-25' },
  { input: 'gift 30 25/12 2027', item: 'gift 25/12 2027', amount: 30 },
  { input: 'flight 300 2027-01-05', item: 'flight 2027-01-05', amount: 300 },
  { input: 'grab 12 2026-12-31', item: 'grab', amount: 12, date: '2026-12-31' },
]

function check(row: Row, now: Date) {
  const parsed = parseExpense(row.input, {}, { categories: DEFAULT_CATEGORIES, now })
  expect({
    item: parsed.itemName,
    amount: parsed.amount,
    date: parsed.parsedDate,
    category: parsed.suggestedCategory,
  }).toEqual({ item: row.item, amount: row.amount, date: row.date, category: row.category })
  if (parsed.parsedDate) {
    expect(parsed.parsedDate <= format(now, 'yyyy-MM-dd')).toBe(true)
  }
}

describe('parseExpense — Singapore quick-add corpus', () => {
  it('has at least 60 distinct phrases', () => {
    const inputs = [...UNDATED, ...ON_SUN_18_OCT_2026, ...ON_SAT_2_JAN_2027].map((r) => r.input)
    expect(new Set(inputs).size).toBeGreaterThanOrEqual(60)
  })

  describe.each([
    ['Sun 18 Oct 2026', SUN_18_OCT_2026],
    ['Sat 2 Jan 2027', SAT_2_JAN_2027],
  ])('undated phrases on %s', (_label, now) => {
    it.each(UNDATED.map((row) => [row.input, row] as const))('%s', (_input, row) => {
      check(row, now)
    })
  })

  describe('date phrases on Sun 18 Oct 2026', () => {
    it.each(ON_SUN_18_OCT_2026.map((row) => [row.input, row] as const))('%s', (_input, row) => {
      check(row, SUN_18_OCT_2026)
    })
  })

  describe('date phrases on Sat 2 Jan 2027', () => {
    it.each(ON_SAT_2_JAN_2027.map((row) => [row.input, row] as const))('%s', (_input, row) => {
      check(row, SAT_2_JAN_2027)
    })
  })
})
