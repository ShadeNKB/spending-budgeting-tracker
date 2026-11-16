// Mutation suites of the v5 data engine (DATA-ENGINE-SPEC §16.6, track spec P-28; PR-3 §7).
//
//   node scripts/mutate-core.mjs           the core's suite (default, unchanged since PR-2)
//   node scripts/mutate-core.mjs --sync    the sync engine's suite (PR-3)
//
// Proves the src/data test suite has teeth: a control run with no mutation must be green, then
// each known-bad change below must turn it red. Every mutation is applied IN MEMORY by a Vite
// transform hook (Vitest Node API); no file is ever written, copied or restored. Each one names a
// file and an exact `find` anchor that must occur there exactly once, so a refactor can never
// silently disable a mutation: a missing or duplicated anchor, or a target module that no test
// loaded, fails the runner. M1 (snapshot before the await) is the in-suite negative control
// (src/data/__tests__/sim/negative-control.test.ts); M12 belongs to PR-2's persistence layer
// (src/data/local, not in this script). M13–M16 cover PR-2's core changes (P2-2…P2-4, P2-10);
// M17 proves the golden vectors of the frozen 0.9.2 model (legacy/v085.golden.test.ts) have teeth.
// The default suite is the core's: src/data/core and src/data/__tests__.
//
// --sync re-injects the sync engine's known-bad changes (PR-3 track spec §7) against the tests of
// the stores, the local engine, src/data/sync and src/services: S1 the pushed copy read before
// the pull, S2 the head short-circuit blind to a non-empty outbox, S3 the memo committed before
// the push lands, S4 a joined device treated as established (it creates the relay copy), S5 a CAS
// conflict taken for a landed push, S6 every foreign row event taken for our own echo, S7 a storm
// breaker that never trips, S8 the registry comparing `seen`, S9 a HEAD trusting an etag from
// before the setup, S10 a tab's name pushing, S11 a carried entry taken for a registration, S12
// a forced write for a missing row, S13 a registration judged by the clocks alone (a slow peer
// read as 0.10.0), S14 a copy judged again by the time passed (a stamp pushed ahead), S15 an
// older writer stamped at every judgment of the same copy (a misread renewed at every start); the
// private sync's (PR-6): P1 a private row force-written, P2 an inner revision that is not the envelope's
// merged, P3 what does not open passed to the merge, P4 one IV for every seal, P5 a cycle writing
// over a copy marked newer, P6 a private sync on the upsert transport, P7 a fence that is not
// saved, P8 a setup changed in another tab not followed, P9 a newer copy pulled again by every
// poll, P10 a write sent after the setup changed mid-cycle; release 2's move (PRIVATE-SYNC 7b):
// R1 the record kept in st5:sync, R2 the move without the lock, R3 the key written without the
// re-read, R4 the lockdown check skipped, R5 a second absorb, R6 the marker after the private
// cycle, R7 the marker never forced, R8 forced before three conflicts, R9 the post-absorb cycle
// answered by a HEAD, R10 a record of another bucket acted on, R11 a merge in the keeping check,
// R12 the keeping check counting every registry entry, R13 the keeping check stopping for good
// once a second device appears, R14 the foreign-marker branch dropping the key; after its
// second review, R15 a forged registry entry taken for a joined device, R16 the old row touched
// without the lock, R17 the absorb merged before it is recorded, R18 a refused move answering
// every request of its turn, R19 a sweep without the switch's grace, R20 a lost record shown as
// "keeps trying"; and PR-2's
// two survivors by name, M23 (absorb's raw copy of a damaged envelope ignored) and M34 (outbox
// written with sync off).
// A mutation may need more than one edit (`edits`); each anchor must occur exactly once.
// Exit code 0 only when the control is green and every mutation is killed. A mutation run that
// bail stops with no failure on record is run again without bail, never scored as a survivor.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startVitest } from 'vitest/node'

const ROOT = resolve(import.meta.dirname, '..')
process.env.ST5_SIM_SEEDS ??= '10'
const SYNC = process.argv.includes('--sync')

/** @typedef {{ find: string, replace: string }} Edit */
/** @typedef {{ id: string, name: string, file: string, find?: string, replace?: string, edits?: Edit[], expect: string }} Mutation */

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
    expect: 'sim/pr3-protocol T-002-3: a dropped push of news is retried',
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
  {
    id: 'M13',
    name: "v0.8.5's top-level mapping stamps ignored on decode (P2-3)",
    file: 'src/data/core/wire.ts',
    find: "    if (typeof v === 'string') stamps.set(k, Math.max(stamps.get(k) ?? 0, ps(v)))\n",
    replace: "    if (typeof v === 'string') stamps.set(k, stamps.get(k) ?? 0)\n",
    expect: 'wire P2-3, item picks LWW beside 0.9.2',
  },
  {
    id: 'M14',
    name: 'Old-writer news blind to the writer: 0.9.2 judged by the v0.8.4 rule (P2-4)',
    file: 'src/data/core/wire.ts',
    find:
      "  return relay.writer === 'v085' && relay.v085 !== undefined\n" +
      '    ? adoptable085(m, relay.v085, relay.legacyTs)\n' +
      '    : adoptable084(m, relay)\n',
    replace: '  return adoptable084(m, relay)\n',
    expect: 'props/adoptable vs the frozen 0.9.2 merge',
  },
  {
    id: 'M15',
    name: 'Day dates stored as the UTC instant of local noon again (P2-2)',
    file: 'src/data/core/dates.ts',
    find: 'export const localNoonIso = (day: string): string => `${day}T12:00:00`\n',
    replace:
      'export const localNoonIso = (day: string): string =>\n' +
      '  new Date(`${day}T12:00:00`).toISOString()\n',
    expect: 'dates / ops T-096-1 in every zone',
  },
  {
    id: 'M16',
    name: 'The bridge drops news payloads (PR-0 crossing-push residual, P2-10)',
    file: 'src/data/__tests__/sim/v5device.ts',
    find: '      this.news.push(e.payload)\n',
    replace: '',
    expect: 'sim/pr2-crossing',
  },
  {
    id: 'M17',
    name: "The frozen 0.9.2 model's budget tie-break inverted (P2-5 goldens)",
    file: 'src/data/__tests__/legacy/v085.ts',
    find: '          side.value > winner.value ||\n',
    replace: '          side.value < winner.value ||\n',
    expect: 'legacy/v085.golden, v085 budgets',
  },
]

/** @type {Mutation[]} */
const SYNC_MUTATIONS = [
  {
    id: 'S1',
    name: 'The pushed copy is the doc read before the pull (F-001 shape)',
    file: 'src/stores/syncEngine.ts',
    edits: [
      {
        find: '    const pulled = await t.pull(b.rowId)\n',
        replace:
          '    globalThis.__st5Stale = port.doc()\n    const pulled = await t.pull(b.rowId)\n',
      },
      {
        find: '    wire: encodeWire(port.doc(), opts),\n',
        replace: '    wire: encodeWire(globalThis.__st5Stale ?? port.doc(), opts),\n',
      },
    ],
    expect: 'T-001-1 / T-001-2: a write during the pull reaches the relay',
  },
  {
    id: 'S2',
    name: 'The head short-circuit ignores unsent changes (a non-empty outbox, a commit since)',
    file: 'src/stores/syncEngine.ts',
    edits: [
      { find: '    held.rev === port.localRev() &&\n', replace: '' },
      { find: '    port.outbox().size === 0 &&\n', replace: '' },
    ],
    expect: 'T-018-1: a non-empty outbox, or a change committed since, skips the HEAD',
  },
  {
    id: 'S3',
    name: 'Memo committed before the push lands',
    file: 'src/stores/syncEngine.ts',
    find: '      res = await t.push(b.rowId, payload, {\n',
    replace:
      '      port.setMeta({ memo: commitPush(port.meta().memo, step.decision, Date.now()) })\n' +
      '      res = await t.push(b.rowId, payload, {\n',
    expect: 'T-002-3: a lost push is retried (memo only after landing)',
  },
  {
    id: 'S4',
    name: 'A joined device is treated as established (it creates the relay copy)',
    file: 'src/stores/syncEngine.ts',
    find: "  if (missing && !established) return done(pause('not-found', syncMessage('not-found')))\n",
    replace: '',
    expect: 'AC-E5: a join never creates',
  },
  {
    id: 'S5',
    name: 'A CAS conflict is taken for a landed push',
    file: 'src/stores/syncEngine.ts',
    find: '    if (!res.ok) {\n',
    replace: "    if (!res.ok && res.reason !== 'conflict') {\n",
    expect: 'AC-T2 / T-001-1 with CAS on: re-pull and re-merge',
  },
  {
    id: 'S6',
    name: 'Every foreign row event is taken for our own echo',
    file: 'src/stores/syncEngine.ts',
    find: 'function isOwnEcho(payload: Record<string, unknown>): boolean {\n',
    replace: 'function isOwnEcho(payload: Record<string, unknown>): boolean {\n  return true\n',
    expect: 'AC-E17: any other event starts one coalesced cycle',
  },
  {
    id: 'S7',
    name: 'The storm breaker never trips',
    file: 'src/stores/syncEngine.ts',
    find: '  if (remoteCycles.length < STORM_CYCLES) {\n',
    replace: '  if (true) {\n',
    expect: 'T-002-4: the 21st remote cycle does not run',
  },
  {
    id: 'S8',
    name: 'The registry compares `seen` (sameEntry)',
    file: 'src/data/sync/registry.ts',
    find: '    a.rpcSince === b.rpcSince\n',
    replace: '    a.rpcSince === b.rpcSince &&\n    a.seen === b.seen\n',
    expect: 'AC-E18 / T-018-1: seen alone never pushes, idle polls are HEADs',
  },
  {
    id: 'S9',
    name: 'The head short-circuit trusts an etag from before this setup (a Disconnect keeps it)',
    file: 'src/stores/syncEngine.ts',
    edits: [
      {
        find: '  if (held === null || held.gen !== setupGen || held.port !== port) return false\n',
        replace: '',
      },
      { find: '    held.rev === port.localRev() &&\n', replace: '' },
    ],
    expect: 'T-018-1: changes made while disconnected reach the relay after a Reconnect',
  },
  {
    id: 'S10',
    name: "A tab's own name (its user agent) makes it register and push before deciding",
    file: 'src/data/sync/registry.ts',
    find: '  return !sameEntry({ ...prev, name: next.name }, next)\n',
    replace: '  return !sameEntry(prev, next)\n',
    expect: 'registerFirst: a name alone never pushes (two tabs would push in turn)',
  },
  {
    id: 'S11',
    name: 'A v5 writer that only carried its entry counts as registering (a rollback hidden)',
    file: 'src/data/sync/registry.ts',
    find: '  return wroteAt === null || wroteAt - entry.seen <= CARRIED_AFTER_MS\n',
    replace: '  return true\n',
    expect: 'P3-8: a device rolled back to 0.10.0 is a 0.10.0 writer',
  },
  {
    id: 'S12',
    name: 'A forced write is sent for a row that is missing (it never creates: busy)',
    file: 'src/stores/syncEngine.ts',
    find: "        force: b.kind === 'plain' && conflicts >= CAS_FORCE_AFTER && step.base !== null,\n",
    replace: "        force: b.kind === 'plain' && conflicts >= CAS_FORCE_AFTER,\n",
    expect: 'AC-T2: a row gone under a forced write is inserted in the same cycle',
  },
  {
    id: 'S13',
    name: "A registration is judged by the clocks alone, never by the writer's entry moving",
    file: 'src/data/sync/registry.ts',
    find: '  if (known !== undefined && entry.seen > known.seen) return true\n',
    replace: '',
    expect: 'P3-8: a 0.11.0 peer whose clock runs 7 hours slow is itself once seen writing again',
  },
  {
    id: 'S14',
    name: 'A copy already judged is judged again by the time passed since',
    file: 'src/stores/syncEngine.ts',
    find: '  const registered = judged ?? wroteItself(dec.doc.devices.get(writer), known, wroteAt)\n',
    replace: '  const registered = wroteItself(dec.doc.devices.get(writer), known, wroteAt)\n',
    expect: 'P3-8: a write stamped days ahead never makes a current 0.11.0 peer a 0.10.0 writer',
  },
  {
    id: 'S15',
    name: 'An older writer is stamped at every judgment of the same copy, not once per copy',
    file: 'src/stores/syncEngine.ts',
    find: '    judged === null,\n',
    replace: '    true,\n',
    expect: 'P3-8 / 0.22.2: a peer misread as 0.10.0 is not seen again at each start',
  },
  {
    id: 'P1',
    name: 'A private row is force-written after three conflicts',
    file: 'src/stores/syncEngine.ts',
    find: "        force: b.kind === 'plain' && conflicts >= CAS_FORCE_AFTER && step.base !== null,\n",
    replace: '        force: conflicts >= CAS_FORCE_AFTER && step.base !== null,\n',
    expect: 'AC-P7: a private row is never force-written',
  },
  {
    id: 'P2',
    name: 'An envelope whose inner revision is not its own is merged',
    file: 'src/stores/syncEngine.ts',
    find: "  if (!isRecord(x5) || typeof x5.rev !== 'string' || x5.rev !== r) return unreadable\n",
    replace: '',
    expect: 'AC-P4: an authentic envelope with another inner revision is not merged',
  },
  {
    id: 'P3',
    name: 'What does not open in a private row is passed to the merge as it is',
    file: 'src/stores/syncEngine.ts',
    find: "  if (!res.ok) return res.kind === 'newer' ? { kind: 'newer' } : unreadable\n",
    replace:
      "  if (!res.ok) return res.kind === 'newer' ? { kind: 'newer' } : { kind: 'ok', pulled }\n",
    expect: 'AC-P4 / AC-P5: a plaintext payload or marker in a private row is never merged',
  },
  {
    id: 'P4',
    name: 'Every seal uses the same IV',
    file: 'src/stores/syncEngine.ts',
    find: '  const iv = crypto.getRandomValues(new Uint8Array(12))\n',
    replace: '  const iv = new Uint8Array(12)\n',
    expect: 'AC-P8: every seal draws a fresh IV',
  },
  {
    id: 'P5',
    name: 'A cycle writes over a copy marked newer',
    file: 'src/stores/syncEngine.ts',
    find: '      if (!ownerReplace() || pulled === null) {\n',
    replace: '      if (pulled === null) {\n',
    expect: 'AC-P6: a newer envelope pauses and is never written over (only the owner may, 3.9)',
  },
  {
    id: 'P6',
    name: 'A private sync writes through the upsert transport',
    file: 'src/stores/syncEngine.ts',
    find: "  if (b.kind === 'e2e' && t.mode === 'table' && !CAS_ON) {\n",
    replace: '  if (false) {\n',
    expect: 'AC-P16: on the upsert transport a private bucket pauses and writes nothing',
  },
  {
    id: 'P7',
    name: 'The fence is not saved: a marker that goes un-fences the device',
    file: 'src/stores/syncEngine.ts',
    find: '    storage.setFenced(b.code, why, now)\n',
    replace: '',
    expect: 'AC-P14: a fenced device never touches the row again once the marker is replaced',
  },
  {
    id: 'P8',
    name: 'A cycle does not follow a setup changed in another tab',
    file: 'src/stores/syncEngine.ts',
    find: '  if (changedElsewhere(code)) return followSaved()\n',
    replace: '',
    expect: '3.2 / AC-P3: a tab on the old code asks its row nothing once the setup changed',
  },
  {
    id: 'P9',
    name: 'A copy marked newer is not remembered: every poll pulls and opens it again',
    file: 'src/stores/syncEngine.ts',
    find: '        if (pulled !== null) setEtag(port, b.rowId, pulled.etag, null)\n',
    replace: '',
    expect: 'AC-P6: after the pause the polls are HEADs',
  },
  {
    id: 'P10',
    name: 'A setup changed while the copy was sealed still gets the write',
    file: 'src/stores/syncEngine.ts',
    find: '    if (changedElsewhere(b.code)) {\n      forgetSent(step.sent)\n      return followSaved()\n    }\n',
    replace: '',
    expect: 'AC-P3: a setup changed elsewhere while a copy is being sealed gets no write',
  },
  {
    id: 'R1',
    name: 'The move keeps its record in st5:sync, which every setup rewrites',
    file: 'src/data/sync/move.ts',
    find: "export const MOVE_KEY = 'st5:synckey:move'\n",
    replace: "export const MOVE_KEY = 'st5:sync'\n",
    expect: 'AC-M2: the record survives a 0.21.0 writer, a reload and a setup of the same code',
  },
  {
    id: 'R2',
    name: 'The move runs without the sync lock',
    file: 'src/stores/syncEngine.ts',
    find: '    return moveUnderLock(moveAsk, code, gen)\n',
    replace: '    return moveSteps(moveAsk, code, gen)\n',
    expect: 'AC-M8: a tab not granted the lock is refused and writes nothing',
  },
  {
    id: 'R3',
    name: 'The key is written without the re-read of step 4',
    file: 'src/stores/syncEngine.ts',
    find:
      '  if (\n' +
      "    saved?.kind !== 'plain' ||\n" +
      '    saved.code !== code ||\n' +
      '    saved.fenced !== undefined ||\n' +
      '    readMove() !== null ||\n' +
      '    changedElsewhere(code)\n' +
      '  ) {\n' +
      '    return stop(MOVE_CHANGED_MESSAGE, plain)\n' +
      '  }\n',
    replace: '  void saved\n',
    expect: 'AC-M8: a tab whose re-read at step 4 finds a changed setup stops, and follows it',
  },
  {
    id: 'R4',
    name: 'The lockdown check is skipped',
    file: 'src/stores/syncEngine.ts',
    find: "  if ((await probeLockdown()) !== 'locked') return stop(MOVE_LOCKDOWN_MESSAGE)\n",
    replace: '',
    expect: 'AC-M12: a relay that still answers the table stops the move before any write',
  },
  {
    id: 'R5',
    name: 'A second plain payload is absorbed',
    file: 'src/stores/syncEngine.ts',
    find: '  if (!keeping && rec.absorbed === null && mergeable(dec.writer)) {\n',
    replace: '  if (!keeping && mergeable(dec.writer)) {\n',
    expect: 'AC-M9 / AC-M4: one plain payload is merged, a second is not',
  },
  {
    id: 'R6',
    name: 'The marker is written after the private cycle that carries the absorb, not before it',
    file: 'src/stores/syncEngine.ts',
    find: '    await closeOldRow(absorbed, pulled.etag, b, gen, t, port)\n',
    replace: '',
    expect: 'AC-M4: the marker went on at once, before the private row was sent what was absorbed',
  },
  {
    id: 'R7',
    name: 'The marker is never forced',
    file: 'src/stores/syncEngine.ts',
    find: '  const force = base !== null && rec.conflicts >= MARKER_FORCE_AFTER\n',
    replace: '  const force = false\n',
    expect: 'AC-M9: the marker lands by force after three conflicts',
  },
  {
    id: 'R8',
    name: 'The marker is forced before three conflicts',
    file: 'src/stores/syncEngine.ts',
    find: '  const force = base !== null && rec.conflicts >= MARKER_FORCE_AFTER\n',
    replace: '  const force = base !== null && rec.conflicts >= MARKER_FORCE_AFTER - 1\n',
    expect: 'AC-M9: three compare-and-sets, then one forced write',
  },
  {
    id: 'R9',
    name: 'The cycle after an absorb may be answered by a HEAD',
    file: 'src/stores/syncEngine.ts',
    edits: [
      {
        find: '    held = null // the cycle that carries it to the private row is a full one\n',
        replace: '',
      },
      {
        find: "      nextReason = strongest(nextReason, 'again')\n",
        replace: "      nextReason = strongest(nextReason, 'poll')\n",
      },
    ],
    expect: 'AC-M5: what was absorbed by a resumed move reaches the private row',
  },
  {
    id: 'R10',
    name: 'A record whose `for` is not this bucket is acted on',
    file: 'src/stores/syncEngine.ts',
    find: '  const stored = dropVoidMove(b.rowId)\n',
    replace: '  const stored = readMove()\n',
    expect: 'AC-M2: a record for another bucket is never acted on',
  },
  {
    id: 'R11',
    name: 'The keeping check merges what it finds on the old row',
    file: 'src/stores/syncEngine.ts',
    find: '  if (keeping) straggler = true\n',
    replace:
      '  if (keeping) {\n' +
      '    straggler = true\n' +
      '    if (mergeable(dec.writer)) absorb(dec, port)\n' +
      '  }\n',
    expect: 'AC-M4 / AC-M13: plaintext over the marker is neither merged nor kept',
  },
  {
    id: 'R12',
    name: 'The keeping check counts every writer as a joined device, this one included',
    file: 'src/stores/syncEngine.ts',
    find: "  if (b.kind !== 'e2e' || writer === null || writer === port.deviceId()) return\n",
    replace: "  if (b.kind !== 'e2e' || writer === null) return\n",
    expect: 'AC-M13: a HEAD after every cycle while no other private device has joined',
  },
  {
    id: 'R13',
    name: 'The keeping check stops for good once a second private device appears',
    file: 'src/stores/syncEngine.ts',
    find: '  const close = alone && now - kept.at < CLOSE_WATCH_MS\n',
    replace: '  if (!alone) return\n  const close = alone && now - kept.at < CLOSE_WATCH_MS\n',
    expect: 'AC-M13: once another private device joined, daily pulls, never stopping',
  },
  {
    id: 'R14',
    name: "Another device's marker makes the mover drop its private key",
    file: 'src/stores/syncEngine.ts',
    find: '    const contested = rec.contested || (by !== null && by !== port.deviceId())\n',
    replace:
      '    const contested = rec.contested || (by !== null && by !== port.deviceId())\n' +
      '    if (by !== port.deviceId()) storage.saveSyncId(null)\n',
    expect: 'AC-M7 / AC-M6: the private key is kept whoever the marker names',
  },
  {
    id: 'R15',
    name: 'A device listed as private in the registry counts as joined (a forged `e: 1`)',
    file: 'src/stores/syncEngine.ts',
    find: '  if (rec !== null) return rec.joined === true\n',
    replace: '  if (rec !== null && rec.joined === true) return true\n',
    expect: 'AC-M13b: a forged entry leaves the device alone, watching, and contested',
  },
  {
    id: 'R16',
    name: 'A cycle that ran without the lock touches the old row',
    file: 'src/stores/syncEngine.ts',
    find: "  if (!locked || !result.ok || b.kind !== 'e2e' || reason === 'hide' || gen !== setupGen) {\n",
    replace: "  if (!result.ok || b.kind !== 'e2e' || reason === 'hide' || gen !== setupGen) {\n",
    expect: 'C-F1: a cycle run without the lock neither absorbs nor writes a marker',
  },
  {
    id: 'R17',
    name: 'The absorb is merged before it is recorded (a failed record write merges it again)',
    file: 'src/stores/syncEngine.ts',
    edits: [
      { find: '    const absorbed = saveMove({ ...rec, absorbed: pulled.etag })\n', replace: '' },
      {
        find: '    absorb(dec, port)\n',
        replace:
          '    absorb(dec, port)\n' +
          '    const absorbed = saveMove({ ...rec, absorbed: pulled.etag })\n',
      },
    ],
    expect: 'S-F2: a record that cannot be written at that moment merges nothing',
  },
  {
    id: 'R18',
    name: "A refused move's answer goes to every request that came in with it",
    file: 'src/stores/syncEngine.ts',
    find: '      if (moved) {\n',
    replace: '      if (moved && current.length < 0) {\n',
    expect: 'C-F2: an edit and Sync now in the same turn get a real cycle',
  },
  {
    id: 'R19',
    name: 'A sweep removes a young record another tab is switching with (no grace)',
    file: 'src/data/sync/move.ts',
    find: "    young === 'spare' &&\n",
    replace: '    false &&\n',
    expect: 'C-F3: B does not remove the record A is switching with',
  },
  {
    id: 'R20',
    name: 'A record lost after the switch is shown as "keeps trying"',
    file: 'src/stores/syncEngine.ts',
    find: '  moveUnsaved = unsaved\n',
    replace: '  void unsaved\n',
    expect: 'S-F4: a record that cannot be kept after the switch is said plainly',
  },
  {
    id: 'M23',
    name: "absorb ignores the raw copy of another tab's damaged envelope",
    file: 'src/data/local/engine.ts',
    find: '      if (r.q?.addRaw(DB_KEY, raw.value, wall, RAW_COPIES_PER_KEY) !== true) {\n',
    replace: '      if (false) {\n',
    expect: 'syncSeams: the damaged envelope is copied to st5:q before it is written over',
  },
  {
    id: 'M34',
    name: 'The outbox is written with sync off',
    file: 'src/data/local/engine.ts',
    find: '    if (touched.length > 0 && syncOn()) r.outbox = addTouched(r.outbox, touched)\n',
    replace: '    if (touched.length > 0) r.outbox = addTouched(r.outbox, touched)\n',
    expect: 'syncSeams: changes made with sync off leave the outbox empty',
  },
]

const SUITES = {
  core: {
    mutations: MUTATIONS,
    dirs: ['src/data/core', 'src/data/__tests__'],
  },
  sync: {
    mutations: SYNC_MUTATIONS,
    dirs: ['src/stores/__tests__', 'src/data/local/__tests__', 'src/data/sync', 'src/services'],
  },
}
const SUITE = SYNC ? SUITES.sync : SUITES.core

const norm = (p) => p.split('\\').join('/').toLowerCase()
const lf = (s) => s.split('\r\n').join('\n')
const occurrences = (text, find) => text.split(find).length - 1
/** @param {Mutation} m @returns {Edit[]} */
const editsOf = (m) => m.edits ?? [{ find: m.find ?? '', replace: m.replace ?? '' }]

/** Up front, from the source on disk (read only): every anchor occurs exactly once. */
function checkAnchors() {
  const bad = []
  for (const m of SUITE.mutations) {
    const text = lf(readFileSync(resolve(ROOT, m.file), 'utf8'))
    for (const [i, e] of editsOf(m).entries()) {
      const n = e.find === '' ? 0 : occurrences(text, e.find)
      if (n !== 1) bad.push(`${m.id}: anchor ${i + 1} occurs ${n} times in ${m.file}`)
    }
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
      let out = code
      for (const [i, e] of editsOf(m).entries()) {
        const find = crlf ? e.find.split('\n').join('\r\n') : e.find
        const replace = crlf ? e.replace.split('\n').join('\r\n') : e.replace
        const n = occurrences(out, find)
        if (n !== 1) throw new Error(`${m.id}: anchor ${i + 1} occurs ${n} times in ${m.file}`)
        out = out.replace(find, () => replace)
      }
      hits.count++
      return { code: out, map: null }
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

/** One run of the suite (benchmarks excluded: timing is not behaviour). */
async function run(plugins, bail) {
  const vitest = await startVitest(
    'test',
    SUITE.dirs,
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
  for (const m of SUITE.mutations) {
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
    `\n${SYNC ? 'sync' : 'core'} suite control: green, ${counts(control, control)} (ST5_SIM_SEEDS=${process.env.ST5_SIM_SEEDS})`,
  )
  for (const row of rows) console.log(row)
  console.log(bad === 0 ? `ALL ${SUITE.mutations.length} MUTATIONS KILLED` : `${bad} NOT KILLED`)
  process.exit(bad === 0 ? 0 : 1)
}

await main()
