// Mutation suite of the v5 data core (DATA-ENGINE-SPEC §16.6, track spec P-28).
//
//   node scripts/mutate-core.mjs
//
// Proves the src/data test suite has teeth: a control run with no mutation must be green, then
// each known-bad change below must turn it red. Every mutation is applied IN MEMORY by a Vite
// transform hook (Vitest Node API); no file is ever written, copied or restored. Each one names a
// file and an exact `find` anchor that must occur there exactly once, so a refactor can never
// silently disable a mutation: a missing or duplicated anchor, or a target module that no test
// loaded, fails the runner. M1 (snapshot before the await) is the in-suite negative control
// (src/data/__tests__/sim/negative-control.test.ts); M12 needs PR-2's persistence layer.
// Exit code 0 only when the control is green and every mutation is killed. A mutation run that
// bail stops with no failure on record is run again without bail, never scored as a survivor.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startVitest } from 'vitest/node'

const ROOT = resolve(import.meta.dirname, '..')
process.env.ST5_SIM_SEEDS ??= '10'

/** @typedef {{ id: string, name: string, file: string, find: string, replace: string, expect: string }} Mutation */

/** @type {Mutation[]} */
const MUTATIONS = [
  {
    id: 'M2',
    name: 'Unconditional push',
    file: 'src/data/core/push.ts',
    find: "  if (pulled === null) return decision('push', 'create')\n",
    replace: "  return decision('push', 'create')\n",
    expect: 'I5 / push bounds',
  },
  {
    id: 'M3',
    name: 'Old-writer rule removed (an old relay is treated as v5)',
    file: 'src/data/core/push.ts',
    find: "    case 'v084':\n    case 'v085':\n      break\n",
    replace:
      "    case 'v084':\n    case 'v085':\n" +
      "      return digestDoc(m) === digestDoc(dec.doc) ? decision('none', 'equal') : decision('push', 'v5-diff')\n",
    expect: 'v0.8.4 chatter bound',
  },
  {
    id: 'M4',
    name: 'Memo committed before the push lands',
    file: 'src/data/__tests__/sim/v5device.ts',
    find: '      const res = await this.relay.push(\n',
    replace:
      '      this.memo = commitPush(this.memo, decision, this.wall())\n' +
      '      const res = await this.relay.push(\n',
    expect: 'lost-push retry test',
  },
  {
    id: 'M5',
    name: 'Rename re-stamps rows',
    file: 'src/data/core/ops.ts',
    find: '  const expenses = materializeAll(cur.expenses, renames)\n',
    replace:
      '  const expenses = deriveExpenses(cur.expenses, [...cur.expenses.values()]' +
      '.filter((r) => resolver(renames)(r.c.v) !== r.c.v)' +
      '.map((r) => materialize(reviveRecord(r, r.id, ctx), resolver(renames))))\n',
    expect: 'judge probe 45',
  },
  {
    id: 'M6',
    name: 'Record-level LWW instead of per-field',
    file: 'src/data/core/record.ts',
    find: 'export function mergeRecord(a: ExpenseRec, b: ExpenseRec): ExpenseRec {\n  if (a === b) return a\n',
    replace:
      'export function mergeRecord(a: ExpenseRec, b: ExpenseRec): ExpenseRec {\n  if (a === b) return a\n' +
      '  if (maxStampRec(a) !== maxStampRec(b)) return maxStampRec(a) > maxStampRec(b) ? a : b\n' +
      '  return recordString(a) >= recordString(b) ? a : b\n',
    expect: "[21, 'to camp'], laws, oracle",
  },
  {
    id: 'M7',
    name: 'Causal floor removed',
    file: 'src/data/core/stamp.ts',
    find: 'Math.max(now, c.last + 1, base + 1)',
    replace: 'Math.max(now, c.last + 1)',
    expect: '−1 day skew probe',
  },
  {
    id: 'M7a',
    name: 'Causal floor dropped by the rename op',
    file: 'src/data/core/ops.ts',
    find: '  const t = tick(ctx.clock, ctx.wall, Math.max(renameStamp(cur, from), renameStamp(cur, to)))\n',
    replace: '  const t = tick(ctx.clock, ctx.wall)\n',
    expect: 'ops.causal: rename',
  },
  {
    id: 'M7b',
    name: 'Causal floor dropped by setBudget',
    file: 'src/data/core/ops.ts',
    find: '  const t = tick(ctx.clock, ctx.wall, budgetStamp(old))\n  const budgets = new Map(doc.budgets).set(category',
    replace:
      '  const t = tick(ctx.clock, ctx.wall)\n  const budgets = new Map(doc.budgets).set(category',
    expect: 'ops.causal: budget set',
  },
  {
    id: 'M7c',
    name: 'Causal floor dropped by the undo of an edit',
    file: 'src/data/core/ops.ts',
    find: '      const t = tick(ctx.clock, ctx.wall, Math.max(...ok.map((u) => u.wrote)))\n',
    replace: '      const t = tick(ctx.clock, ctx.wall)\n',
    expect: 'ops.causal: undo of an edit',
  },
  {
    id: 'M8',
    name: 'Wall-clock-dependent stamp validity',
    file: 'src/data/core/stamp.ts',
    find: 't < MAX_T ? Math.floor(t) : 0',
    replace: 't < Math.min(MAX_T, Date.now() + 86_400_000) ? Math.floor(t) : 0',
    expect: 'laws / convergence (fixed window)',
  },
  {
    id: 'M9',
    name: 'Tombstone cap reintroduced',
    file: 'src/data/core/wire.ts',
    find: '    const order = [...t].sort(([a, s], [b, u]) => s - u || cmpText(a, b))\n',
    replace:
      '    const order = [...t].sort(([a, s], [b, u]) => s - u || cmpText(a, b)).slice(-1000)\n',
    expect: 'T-013-1/2',
  },
  {
    id: 'M10',
    name: 'Absence treated as deletion',
    file: 'src/data/core/doc.ts',
    find: '    const b = R.expenses.get(id)\n',
    replace:
      '    const b = R.expenses.get(id)\n' +
      '    if (b === undefined) {\n      removed.push(a)\n      drop.push(id)\n      continue\n    }\n',
    expect: 'G1 / I1',
  },
  {
    id: 'M11',
    name: 'Unstamped mutation ranked authentic',
    file: 'src/data/core/record.ts',
    find: '    (f) => fsStamp(fs[f], C),\n    () => 0,\n  )\n',
    replace: '    (f) => fsStamp(fs[f], C),\n    () => 2,\n  )\n',
    expect: 'W5, W6, T-015-2',
  },
]

const norm = (p) => p.split('\\').join('/').toLowerCase()
const lf = (s) => s.split('\r\n').join('\n')
const occurrences = (text, find) => text.split(find).length - 1

/** Up front, from the source on disk (read only): every anchor occurs exactly once. */
function checkAnchors() {
  const bad = []
  for (const m of MUTATIONS) {
    const n = occurrences(lf(readFileSync(resolve(ROOT, m.file), 'utf8')), m.find)
    if (n !== 1) bad.push(`${m.id}: anchor occurs ${n} times in ${m.file}`)
  }
  return bad
}

/** Applies one mutation to its module as Vite serves it to the test workers. */
function mutationPlugin(m, hits) {
  const target = norm(resolve(ROOT, m.file))
  return {
    name: `st5-mutation-${m.id}`,
    enforce: 'pre',
    transform(code, id) {
      // the module itself only: `?raw` text imports (purity.test.ts) keep the source on disk
      if (id.includes('?') || norm(id) !== target) return null
      const crlf = code.includes('\r\n')
      const find = crlf ? m.find.split('\n').join('\r\n') : m.find
      const replace = crlf ? m.replace.split('\n').join('\r\n') : m.replace
      const n = occurrences(code, find)
      if (n !== 1) throw new Error(`${m.id}: anchor occurs ${n} times in ${m.file}`)
      hits.count++
      return { code: code.replace(find, () => replace), map: null }
    },
  }
}

/**
 * What a run finished: every failing test (or file that failed to load), and how many files and
 * tests reached a result (pass or fail) out of those collected. A run that bail stopped early can
 * lose the failure that stopped it, so "nothing failed" only counts when the run also completed.
 */
function tally(vitest) {
  const t = { failed: [], files: 0, filesDone: 0, tests: 0, testsDone: 0 }
  const walk = (task) => {
    if (task.type === 'test') {
      t.tests++
      const state = task.result?.state
      if (state === 'pass' || state === 'fail') t.testsDone++
      if (state === 'fail') t.failed.push(task.name)
    }
    for (const child of task.tasks ?? []) walk(child)
  }
  for (const file of vitest.state.getFiles()) {
    t.files++
    const state = file.result?.state
    if (state === 'pass' || state === 'fail') t.filesDone++
    if (state === 'fail' && (file.tasks ?? []).length === 0) t.failed.push(file.name)
    walk(file)
  }
  return t
}

/** One run of the src/data suite (benchmarks excluded: timing is not behaviour). */
async function run(plugins, bail) {
  const vitest = await startVitest(
    'test',
    ['src/data'],
    { watch: false, bail, reporters: ['dot'], cliExclude: ['**/__tests__/bench/**'] },
    { plugins },
  )
  const t = tally(vitest)
  const errors = vitest.state.getUnhandledErrors().length
  await vitest.close()
  process.exitCode = 0
  return { ...t, errors }
}

const counts = (r, control) =>
  `files ${r.filesDone}/${control.filesDone} · tests ${r.testsDone}/${control.testsDone}`

/**
 * killed: something failed. SURVIVED: the run completed (as many tests reached a result as in the
 * control) and nothing failed. Otherwise the run stopped early with no recorded failure: unknown.
 */
function verdict(r, hits, control) {
  if (hits.count === 0) return 'NOT LOADED'
  if (r.failed.length > 0 || r.errors > 0) return 'killed'
  return r.testsDone >= control.testsDone ? 'SURVIVED' : 'UNKNOWN'
}

async function main() {
  const anchors = checkAnchors()
  if (anchors.length > 0) {
    for (const line of anchors) console.error(line)
    process.exit(2)
  }
  // no bail: the control's counts are the reference for a complete run
  const control = await run([], 0)
  if (control.failed.length > 0 || control.errors > 0 || control.filesDone < control.files) {
    console.error(
      `control run is red or incomplete (${counts(control, control)} of ${control.files} files): ` +
        control.failed.join(' | '),
    )
    process.exit(1)
  }
  const rows = []
  let bad = 0
  for (const m of MUTATIONS) {
    let hits = { count: 0 }
    let r = await run([mutationPlugin(m, hits)], 1)
    let v = verdict(r, hits, control)
    let note = ''
    if (v === 'UNKNOWN') {
      // bail stopped the run with no failure on record: run this mutation again to the end
      note = ` [bail run stopped at ${counts(r, control)}; re-run without bail]`
      hits = { count: 0 }
      r = await run([mutationPlugin(m, hits)], 0)
      v = verdict(r, hits, control)
    }
    if (v !== 'killed') bad++
    rows.push(
      `${m.id.padEnd(4)} ${v.padEnd(10)} ${m.name} (expected red: ${m.expect}) · ${counts(r, control)}` +
        `${note} → ${r.failed.slice(0, 3).join(' | ') || 'no failing test'}`,
    )
  }
  console.log(
    `\ncontrol: green, ${counts(control, control)} (ST5_SIM_SEEDS=${process.env.ST5_SIM_SEEDS})`,
  )
  for (const row of rows) console.log(row)
  console.log(bad === 0 ? `ALL ${MUTATIONS.length} MUTATIONS KILLED` : `${bad} NOT KILLED`)
  process.exit(bad === 0 ? 0 : 1)
}

await main()
