import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SECRET_KEY_PATTERN,
  buildRescueFile,
  collectRawStorage,
  downloadRescueFile,
  type RawStorage,
} from './rescue'
import { downloadJSON } from './download'

vi.mock('./download', () => ({ downloadJSON: vi.fn(), downloadCSV: vi.fn() }))

class MapStorage implements RawStorage {
  constructor(private readonly entries: [string, string][] = []) {}
  get length(): number {
    return this.entries.length
  }
  key(index: number): string | null {
    return this.entries[index]?.[0] ?? null
  }
  getItem(key: string): string | null {
    return this.entries.find(([k]) => k === key)?.[1] ?? null
  }
}

// Invented, deliberately broken values: the rescue path must never parse or "fix" them.
const CORRUPT_EXPENSES =
  '[{"id":"e1","amount":4.5,"item":"Kopi O","date":"2026-10-19T12:00:00"},{"id":'
const ODD_VALUES: [string, string][] = [
  ['expenses', CORRUPT_EXPENSES],
  ['categories', 'undefined'],
  ['categoryMappings', '{"kopi":"Food",}'],
  ['spendtrack:theme', 'light'],
  ['spendtrack:currency', 'SGD'],
  ['blank', ''],
  ['unicode', 'Chicken rice 鸡饭 \u{1F35A} \u0000 tab\tnewline\n"quoted" \\ back'],
  ['__proto__', 'not a prototype'],
]

afterEach(() => {
  vi.mocked(downloadJSON).mockClear()
  localStorage.clear()
})

describe('SECRET_KEY_PATTERN', () => {
  it.each([
    'syncId',
    'SYNCID',
    'sb-vpjshiazdygzvunwefmb-auth-token',
    'spendtrack:secret',
    'sync-passphrase',
    'spendtrack:syncKey',
    'cryptoKey',
    'encryptionKey',
  ])('matches the secret-like key %s', (key) => {
    expect(SECRET_KEY_PATTERN.test(key)).toBe(true)
  })

  it.each(['expenses', 'categories', 'spendtrack:theme', 'syncIdHistory', 'deletedExpenseIds'])(
    'leaves the data key %s alone',
    (key) => {
      expect(SECRET_KEY_PATTERN.test(key)).toBe(false)
    },
  )
})

describe('collectRawStorage', () => {
  it('copies every value as its raw string, byte for byte, without parsing', () => {
    const raw = collectRawStorage(new MapStorage(ODD_VALUES))
    expect(Object.keys(raw).sort()).toEqual(ODD_VALUES.map(([k]) => k).sort())
    for (const [key, value] of ODD_VALUES) {
      expect(Object.getOwnPropertyDescriptor(raw, key)?.value).toBe(value)
    }
  })

  // Valid JSON that a parse-and-stringify round trip would rewrite: spacing, a trailing newline,
  // a duplicate key (the last one wins), an integer past 2^53 and the number spelling 1.10.
  it('keeps valid JSON byte for byte too, never re-serialising it', () => {
    const values: [string, string][] = [
      ['expenses', '[ {"id": "e1", "amount": 1.10, "n": 12345678901234567890, "id": "e2"} ]\n'],
      ['categories', '[ ]'],
      ['budgets', '{\n  "Food": 300.0\n}'],
      ['spendtrack:number', '1e2'],
    ]
    const raw = collectRawStorage(new MapStorage(values))
    for (const [key, value] of values) {
      expect(raw[key]).toBe(value)
      expect(JSON.stringify(JSON.parse(value))).not.toBe(value)
    }
  })

  it('copies a 5,000-expense value unchanged', () => {
    const value = JSON.stringify(
      Array.from({ length: 5000 }, (_, i) => ({
        id: `e-${String(i)}`,
        amount: 4.5,
        itemName: `Invented item ${String(i)}`,
        date: '2026-10-19T12:00:00',
      })),
      null,
      1,
    )
    const raw = collectRawStorage(new MapStorage([['expenses', value]]))
    expect(raw.expenses).toBe(value)
    expect(raw.expenses?.length).toBeGreaterThan(400_000)
  })

  it('leaves out syncId and secret-like keys', () => {
    const raw = collectRawStorage(
      new MapStorage([
        ['expenses', '[]'],
        ['syncId', 'abcd-efgh-ijkl'],
        ['sb-project-auth-token', '{"access_token":"x"}'],
        ['spendtrack:syncKey', 'k'],
      ]),
    )
    expect(Object.keys(raw)).toEqual(['expenses'])
  })

  it('returns keys in a stable, sorted order', () => {
    const raw = collectRawStorage(
      new MapStorage([
        ['spendtrack:theme', 'dark'],
        ['categories', '[]'],
        ['expenses', '[]'],
      ]),
    )
    expect(Object.keys(raw)).toEqual(['categories', 'expenses', 'spendtrack:theme'])
  })
})

describe('buildRescueFile', () => {
  it('names the file from the local date and time', () => {
    // 23:59 local on New Year's Eve: a UTC-based name would roll to another day or hour
    // under Asia/Singapore, Pacific/Honolulu and Pacific/Kiritimati.
    const file = buildRescueFile({ expenses: '[]' }, new Date(2026, 11, 31, 23, 59, 30))
    expect(file.filename).toBe('spendtrack-backup-raw-2026-12-31-2359.json')
  })

  it('pads single-digit months, days, hours and minutes', () => {
    const file = buildRescueFile({ expenses: '[]' }, new Date(2027, 0, 2, 3, 4, 5))
    expect(file.filename).toBe('spendtrack-backup-raw-2027-01-02-0304.json')
  })

  it('wraps the raw keys with a self-describing header', () => {
    const now = new Date(2026, 9, 19, 12, 0, 0)
    const { note, ...header } = buildRescueFile({ expenses: CORRUPT_EXPENSES }, now).payload
    expect(note).toMatch(/exactly as/)
    expect(header).toEqual({
      app: 'SpendTrack',
      kind: 'raw-browser-backup',
      version: 1,
      exportedAt: now.toISOString(),
      keys: { expenses: CORRUPT_EXPENSES },
    })
  })

  it('round-trips a 5,000-expense value byte-exact through JSON', () => {
    const expenses = Array.from({ length: 5000 }, (_, i) => ({
      id: `e-${String(i)}`,
      amount: Math.round((i % 97) * 1.37 * 100) / 100,
      item: `Invented item ${String(i)} "quoted", comma`,
      category: ['Food', 'Transport', 'Shopping', 'Bills'][i % 4],
      date: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T12:00:00`,
      notes: i % 10 === 0 ? 'line one\nline two' : '',
    }))
    const value = JSON.stringify(expenses)
    expect(value.length).toBeGreaterThan(500_000)
    const file = buildRescueFile({ expenses: value }, new Date(2026, 9, 19, 9, 30))
    const reparsed: unknown = JSON.parse(JSON.stringify(file.payload, null, 2))
    expect(reparsed).toMatchObject({ keys: { expenses: value } })
  })
})

describe('downloadRescueFile', () => {
  const now = () => new Date(2026, 11, 31, 23, 59)
  const saver = () => vi.fn<(filename: string, data: unknown) => void>()

  it('saves the raw dump and reports the filename', () => {
    const save = saver()
    const outcome = downloadRescueFile({ getStorage: () => new MapStorage(ODD_VALUES), now, save })
    expect(outcome).toEqual({
      kind: 'downloaded',
      filename: 'spendtrack-backup-raw-2026-12-31-2359.json',
    })
    expect(save).toHaveBeenCalledTimes(1)
    const [filename, payload] = save.mock.calls[0] ?? []
    expect(filename).toBe('spendtrack-backup-raw-2026-12-31-2359.json')
    expect(payload).toMatchObject({
      kind: 'raw-browser-backup',
      keys: { expenses: CORRUPT_EXPENSES },
    })
  })

  it('reports empty storage without creating a file', () => {
    const save = saver()
    expect(downloadRescueFile({ getStorage: () => new MapStorage(), now, save })).toEqual({
      kind: 'empty',
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('treats storage holding only secrets as empty', () => {
    const save = saver()
    const storage = new MapStorage([['syncId', 'abcd']])
    expect(downloadRescueFile({ getStorage: () => storage, now, save })).toEqual({ kind: 'empty' })
    expect(save).not.toHaveBeenCalled()
  })

  it('reports blocked storage', () => {
    const save = saver()
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    expect(downloadRescueFile({ getStorage: blocked, now, save })).toEqual({ kind: 'unavailable' })

    const throwsOnRead: RawStorage = {
      length: 1,
      key: () => 'expenses',
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    }
    expect(downloadRescueFile({ getStorage: () => throwsOnRead, now, save })).toEqual({
      kind: 'unavailable',
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('reports a download that could not start', () => {
    const save = saver().mockImplementation(() => {
      throw new Error('Blob URLs are disabled')
    })
    expect(downloadRescueFile({ getStorage: () => new MapStorage(ODD_VALUES), now, save })).toEqual(
      { kind: 'failed' },
    )
  })

  it('reads localStorage and downloads through downloadJSON by default', () => {
    localStorage.setItem('expenses', CORRUPT_EXPENSES)
    localStorage.setItem('syncId', 'abcd-efgh')
    const outcome = downloadRescueFile()
    expect(outcome.kind).toBe('downloaded')
    expect(downloadJSON).toHaveBeenCalledTimes(1)
    const [filename, payload] = vi.mocked(downloadJSON).mock.calls[0] ?? []
    expect(filename).toMatch(/^spendtrack-backup-raw-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)
    expect(payload).toMatchObject({ keys: { expenses: CORRUPT_EXPENSES } })
    expect(JSON.stringify(payload)).not.toContain('abcd-efgh')
  })

  it('gives two identical files on a double tap', () => {
    const save = saver()
    const deps = { getStorage: () => new MapStorage(ODD_VALUES), now, save }
    downloadRescueFile(deps)
    downloadRescueFile(deps)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0]).toEqual(save.mock.calls[1])
  })
})
