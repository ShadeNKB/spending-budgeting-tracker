// The auditors' poison payloads, verbatim (invented data). Random ids were replaced by fixed
// literals so results are deterministic. Sources: agents/security/import_*.json (t2),
// agents/security/t3_merge_poison.cjs (t3), agents/data-integrity/b3-import.cjs + import-*.json (b3),
// and the duplicate-id delete flow of b3b.log (b3b).

const t2Base = (
  expense: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  expenses: [expense],
  categories: ['Food', 'Transport', 'Other'],
  categoryMappings: {},
  budgets: {},
  exportDate: '2026-10-18T04:00:00.000Z',
  version: '4.0',
  ...extra,
})
const t2Row = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  itemName: 'Lunch',
  amount: 5.5,
  category: 'Food',
  date: '2026-10-18T12:00:00',
  createdAt: '2026-10-18T04:00:00.000Z',
  ...over,
})

/** security/t2_import_poison.cjs inputs (import_*.json). */
export const T2: Readonly<Record<string, unknown>> = {
  baseline: t2Base(t2Row('id-9lw4sc798j5')),
  budget_string: t2Base(t2Row('id-r4o7j2jhjao'), { budgets: { Food: 'abc' } }),
  category_list_object: { ...t2Base(t2Row('id-tr8o8opeyxe')), categories: ['Food', { evil: 1 }] },
  date_garbage: t2Base(t2Row('id-faglwyplqjw', { date: 'not-a-date' })),
  dup_ids: {
    ...t2Base(t2Row('same')),
    expenses: [t2Row('same'), t2Row('same', { amount: 9 })],
  },
  empty_itemname: t2Base(t2Row('id-trpvb8i42ol', { itemName: '' })),
  mappings_proto: JSON.parse(
    '{"expenses":[{"id":"p1","itemName":"Lunch","amount":5,"category":"Food","date":"2026-10-18T12:00:00","createdAt":"2026-10-18T04:00:00.000Z"}],"categories":["Food"],"categoryMappings":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}},"exportDate":"2026-10-18T04:00:00.000Z","version":"4.0"}',
  ),
  notes_object: t2Base(t2Row('id-d2og8hbhd6', { notes: { x: 1 } })),
}

const t3Exp = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  itemName: 'Item ' + id,
  amount: 10,
  category: 'Food',
  date: '2026-10-1' + String(id.length % 9) + 'T12:00:00',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

/** security/t3_merge_poison.cjs: a 500-row local state and the remote payloads it was fed. */
export const T3_LOCAL: Readonly<Record<string, unknown>> = {
  expenses: Array.from({ length: 500 }, (_, i) => t3Exp('L' + String(i))),
  categories: ['Food', 'Transport'],
  categoryMappings: { kopi: 'Food' },
  budgets: { Food: 400 },
  budgetUpdatedAt: { Food: '2026-10-01T00:00:00.000Z' },
  budgetDeletedAt: {},
  deletedIds: [],
  exportDate: '2026-10-18T00:00:00.000Z',
  version: '4.0',
}
export const T3: Readonly<Record<string, unknown>> = {
  tombstoneInjection: {
    ...T3_LOCAL,
    expenses: [],
    deletedIds: Array.from({ length: 500 }, (_, i) => 'L' + String(i)),
    budgets: {},
    budgetUpdatedAt: {},
    budgetDeletedAt: { Food: '2099-01-01T00:00:00.000Z' },
  },
  futureTimestamp: {
    ...T3_LOCAL,
    expenses: [t3Exp('L0', { amount: 99999, updatedAt: '9999-12-31T00:00:00.000Z' })],
    deletedIds: [],
  },
  poison: {
    ...T3_LOCAL,
    expenses: [
      t3Exp('P1', { date: 'not-a-date' }),
      t3Exp('P2', { notes: { x: 1 } }),
      t3Exp('P3', { amount: 'abc' }),
      t3Exp('P4', { amount: -1e9 }),
    ],
    categories: [{ evil: 1 }],
    deletedIds: [],
  },
  expensesNull: { ...T3_LOCAL, expenses: null },
  categoriesNumber: { ...T3_LOCAL, categories: 5 },
  payloadArray: [],
}

const b3Ok = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  itemName: 'Chicken rice',
  amount: 4.5,
  category: 'Food & Dining',
  date: '2026-10-15T04:00:00.000Z',
  createdAt: '2026-10-15T04:00:00.000Z',
  ...over,
})
const b3Backup = (
  expenses: readonly unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  expenses,
  categories: ['Food & Dining', 'Transportation', 'Other'],
  categoryMappings: {},
  budgets: {},
  exportDate: '2026-10-16T00:00:00.000Z',
  version: '4.0',
  ...extra,
})

/** data-integrity/b3-import.cjs cases (import-*.json). */
export const B3: Readonly<Record<string, unknown>> = {
  'amount-1e9-typo': b3Backup([b3Ok('iwkz7sk', { amount: 1e9 })]),
  'budget-as-string': b3Backup(
    [b3Ok('iqi1leb'), b3Ok('iaw1dnn', { itemName: 'MRT', amount: 2, category: 'Transportation' })],
    { budgets: { 'Food & Dining': '300', Transportation: 100 } },
  ),
  'category-number': b3Backup([b3Ok('izlyc0m'), b3Ok('iw2nz5r', { itemName: 'n', category: '' })]),
  'category-object-in-list': {
    ...b3Backup([
      b3Ok('i5jn3sn'),
      b3Ok('i1fkueu', { itemName: 'MRT', amount: 2, category: 'Transportation' }),
    ]),
    categories: ['Food & Dining', { name: 'Hacked' }, 'Other'],
  },
  'date-not-a-date': b3Backup([b3Ok('ibu59qg', { date: 'last tuesday' }), b3Ok('i3trojq')]),
  'duplicate-ids': b3Backup([
    b3Ok('dup', { itemName: 'Lunch A' }),
    b3Ok('dup', { itemName: 'Lunch B', amount: 9 }),
  ]),
  'notes-object': b3Backup([b3Ok('i89ilb1', { notes: { a: 1 } })]),
}

/** b3b: import two rows sharing an id, then delete only one of them. */
export const B3B = B3['duplicate-ids']
