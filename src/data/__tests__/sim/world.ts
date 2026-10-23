// The simulated world: one relay, v5 devices and frozen old clients, human-paced random ops on
// virtual time, then idle chatter, in-place upgrade of the old clients and a run to quiescence.
// Collects every invariant violation (I1–I5, field oracle, I3) and a seed-reproducible trace digest.
import { displayList } from '../../core/categories'
import { FNV_A, fnvLane } from '../../core/hash'
import {
  OpError,
  addCategory,
  addExpense,
  applyImport,
  deleteAllEverywhere,
  deleteExpenses,
  planImport,
  removeBudget,
  removeCategory,
  renameCategory,
  setBudget,
  setCurrency,
  undo,
  updateExpense,
} from '../../core/ops'
import { EMPTY_DOC, digestDoc, maxStampDoc, mergeDoc } from '../../core/doc'
import { newRev } from '../../core/ids'
import { observe } from '../../core/stamp'
import type { Doc, MergeResult, OpCtx, OpResult, UndoEntry } from '../../core/types'
import { decodeWire, encodeBackupFile, wireString } from '../../core/wire'
import { V085Client } from '../legacy/v085'
import { DAY, HOUR, T0 } from '../support/gen'
import { FieldOracle } from '../support/oracle'
import { TombWatch, checkI1, checkI4 } from '../support/invariants'
import { makeRng, type Rng } from '../support/rng'
import { VirtualClock } from './clock'
import { OldDevice, type OldKind } from './oldDevices'
import { CALM, Relay, type NetOptions } from './relay'
import { V5Device, type Observer } from './v5device'

export interface DeviceSpec {
  readonly kind: 'v5' | OldKind
  readonly skew?: number
}

export interface WorldOptions {
  readonly seed: number
  readonly devices: readonly DeviceSpec[]
  readonly net?: NetOptions
  /** Negative control (M1): every v5 device snapshots before its pull await. */
  readonly readBeforeAwait?: boolean
}

const SYNC_ID = '6f1d1c1e-0000-4000-8000-00000000c0de'
const ITEMS = [
  'chicken rice',
  'kopi',
  'grab to camp',
  'mrt',
  'kitchen towel',
  'github shares',
  'sql course',
  'sp group electricity',
  'steamboat dinner',
  'constructor',
  '__proto__',
]
const CATEGORIES = [
  'Food',
  'Transport',
  'Shopping',
  'Other',
  'Meals',
  'Gym',
  'Education',
  'Bills & Utilities',
]
const DAYS = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']

export class World implements Observer {
  readonly clock = new VirtualClock(T0)
  readonly rng: Rng
  readonly relay: Relay
  readonly v5: V5Device[] = []
  readonly old: OldDevice[] = []
  readonly oracle = new FieldOracle()
  readonly violations: string[] = []
  private readonly watches = new Map<V5Device, TombWatch>()
  private readonly undos = new Map<string, UndoEntry[]>()
  private readonly backups = new Map<string, unknown>()
  private hash = FNV_A
  ops = 0
  lostWrites = 0

  constructor(readonly opts: WorldOptions) {
    this.rng = makeRng(opts.seed)
    this.relay = new Relay(this.clock, makeRng(opts.seed * 7919 + 1), opts.net ?? CALM)
  }

  // ── Observer ────────────────────────────────────────────────────────────────────────────

  onDoc(dev: V5Device, before: Doc, after: Doc): void {
    this.oracle.observe(before, after)
    const watch = this.watches.get(dev)
    if (watch !== undefined)
      this.violations.push(...watch.check(after).map((v) => `${dev.name} ${v}`))
  }

  onMerge(dev: V5Device, local: Doc, m: MergeResult): void {
    this.violations.push(...checkI1(local, m).map((v) => `${dev.name} ${v}`))
  }

  trace(line: string): void {
    this.hash = fnvLane(`${this.clock.now}|${line}`, this.hash)
  }

  get traceDigest(): string {
    return `${this.hash.toString(16)}:${this.relay.writes}:${this.clock.processed}`
  }

  // ── setup ───────────────────────────────────────────────────────────────────────────────

  private addV5(
    name: string,
    skew: number,
    established: boolean,
    doc?: Doc,
    outbox?: V5Device['outbox'],
  ): V5Device {
    const d = new V5Device(this.clock, this.relay, makeRng(this.rng.int(2 ** 31)), this, {
      name,
      skew,
      established,
      readBeforeAwait: this.opts.readBeforeAwait ?? false,
      ...(doc === undefined ? {} : { doc }),
      ...(outbox === undefined ? {} : { outbox }),
    })
    this.watches.set(d, new TombWatch())
    if (doc !== undefined) this.oracle.observe({ ...doc, expenses: new Map() }, doc)
    this.v5.push(d)
    return d
  }

  /** The first device creates the row; every other device joins it. */
  async setup(): Promise<void> {
    let i = 0
    for (const spec of this.opts.devices) {
      const name = `${spec.kind}-${String.fromCharCode(97 + i)}`
      const skew = spec.skew ?? 0
      if (spec.kind === 'v5') {
        const d = this.addV5(name, skew, i === 0)
        d.start()
        await this.settleCycle(d.triggerSync('boot'))
      } else {
        const o = new OldDevice(
          this.clock,
          this.relay,
          makeRng(this.rng.int(2 ** 31)),
          name,
          spec.kind,
          skew,
        )
        this.old.push(o)
        await this.settleCycle(o.start(SYNC_ID))
      }
      // the code is shared only once the row exists (a join never creates one, §11.6)
      for (let t = 0; t < 120 && this.relay.row === null; t++) await this.clock.run(1000)
      i++
    }
  }

  private async settleCycle(p: Promise<void>): Promise<void> {
    const state = { done: false }
    void p.then(() => {
      state.done = true
    })
    for (let i = 0; i < 400 && !state.done; i++) await this.clock.run(250)
  }

  // ── ops ─────────────────────────────────────────────────────────────────────────────────

  private randomV5Op(d: V5Device): void {
    const r = this.rng
    const ctx = (): ReturnType<V5Device['ctx']> => d.ctx()
    const ids = [...d.doc.expenses.keys()]
    const shown = displayList(d.doc)
    const roll = r.next()
    const run = (f: () => OpResult): void => {
      try {
        const res = d.apply(f())
        if (res.undo !== undefined) {
          const list = this.undos.get(d.name) ?? []
          list.push(res.undo)
          this.undos.set(d.name, list.slice(-5))
        }
      } catch (e) {
        if (!(e instanceof OpError)) throw e
      }
    }
    if (roll < 0.32 || ids.length === 0) {
      run(() =>
        addExpense(d.doc, ctx(), {
          itemName: r.pick(ITEMS),
          amount: r.pick([1.8, 4.5, 12, 21, 300]),
          ...(r.chance(0.5) ? { category: r.pick(CATEGORIES) } : {}),
          ...(r.chance(0.5) ? { day: r.pick(DAYS) } : {}),
          ...(r.chance(0.2) ? { notes: 'to camp' } : {}),
        }),
      )
    } else if (roll < 0.55) {
      const id = r.pick(ids)
      const which = r.int(5)
      run(() =>
        updateExpense(
          d.doc,
          ctx(),
          id,
          [
            { amount: r.pick([2, 45, 50, 21]) },
            { itemName: r.pick(ITEMS) },
            { category: r.pick(CATEGORIES) },
            { notes: r.pick(['', 'lunch', 'to camp']) },
            { day: r.pick(DAYS) },
          ][which] ?? {},
        ),
      )
    } else if (roll < 0.65) {
      run(() => deleteExpenses(d.doc, ctx(), [r.pick(ids)]))
    } else if (roll < 0.72) {
      const list = this.undos.get(d.name) ?? []
      const entry = list.pop()
      if (entry !== undefined) run(() => undo(d.doc, ctx(), entry))
    } else if (roll < 0.76) {
      const from = r.pick(shown)
      run(() => renameCategory(d.doc, ctx(), from, r.pick(CATEGORIES)))
    } else if (roll < 0.79) {
      run(() => removeCategory(d.doc, ctx(), r.pick(shown)))
    } else if (roll < 0.82) {
      run(() => addCategory(d.doc, ctx(), r.pick(CATEGORIES)))
    } else if (roll < 0.87) {
      run(() => setBudget(d.doc, ctx(), r.pick(shown), r.pick([100, 200, 300])))
    } else if (roll < 0.9) {
      run(() => removeBudget(d.doc, ctx(), r.pick(shown)))
    } else if (roll < 0.92) {
      run(() => setCurrency(d.doc, ctx(), r.pick(['SGD', 'EUR'])))
    } else if (roll < 0.95) {
      this.backups.set(d.name, JSON.parse(JSON.stringify(encodeBackupFile(d.doc))))
    } else if (roll < 0.985) {
      const file = this.backups.get(d.name)
      if (file !== undefined) {
        const dec = decodeWire(file, 'file')
        run(() =>
          applyImport(d.doc, ctx(), planImport(d.doc, dec), r.chance(0.8) ? 'restore' : 'replace'),
        )
      }
    } else {
      run(() => deleteAllEverywhere(d.doc, ctx()))
    }
  }

  private randomOldOp(o: OldDevice): void {
    const r = this.rng
    const c = o.client
    const ids = c.s.expenses.map((e) => e.id)
    const roll = r.next()
    try {
      if (roll < 0.35 || ids.length === 0) {
        c.addExpense({
          itemName: r.pick(ITEMS),
          amount: r.pick([1.8, 4.5, 12, 21]),
          ...(r.chance(0.5) ? { category: r.pick(CATEGORIES) } : {}),
          ...(r.chance(0.5) ? { date: new Date(`${r.pick(DAYS)}T12:00:00`).toISOString() } : {}),
        })
      } else if (roll < 0.6) {
        c.updateExpense(
          r.pick(ids),
          r.chance(0.5) ? { amount: r.pick([2, 45, 50]) } : { notes: 'old note' },
        )
      } else if (roll < 0.72) {
        c.deleteExpense(r.pick(ids))
      } else if (roll < 0.8) {
        const u = c.s.undoStack.at(-1)
        if (u !== undefined) c.consumeUndo(u.id)
      } else if (roll < 0.84) {
        c.renameCategory(r.pick(c.s.categories), r.pick(CATEGORIES))
      } else if (roll < 0.87) {
        c.removeCategory(r.pick(c.s.categories))
      } else if (roll < 0.9) {
        c.addCategory(r.pick(CATEGORIES))
      } else if (roll < 0.95) {
        c.setBudget(r.pick(CATEGORIES), r.pick([100, 250]))
      } else if (roll < 0.98) {
        c.removeBudget(r.pick(CATEGORIES))
      } else if (c instanceof V085Client || roll < 0.99) {
        c.clearAllExpenses()
      }
    } catch {
      // v0.8 throws plain Errors on bad input; nothing changed
    }
  }

  /** Human-paced ops (2–8 s apart) on random devices. */
  async runOps(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await this.clock.run(2000 + this.rng.int(6001))
      const all = this.v5.length + this.old.length
      const k = this.rng.int(all)
      const d = this.v5[k]
      if (d !== undefined) this.randomV5Op(d)
      else {
        const o = this.old[k - this.v5.length]
        if (o !== undefined) this.randomOldOp(o)
      }
      this.ops++
    }
  }

  /** v5 pushes during a window with no user activity. */
  async idle(ms: number): Promise<number> {
    const before = this.v5.reduce((n, d) => n + d.pushes, 0)
    await this.clock.run(ms)
    return this.v5.reduce((n, d) => n + d.pushes, 0) - before
  }

  /** Every old client upgrades in place to v5 and boots a cycle. */
  upgradeAll(): void {
    for (const o of this.old.splice(0)) {
      const { doc, outbox } = o.migrate()
      const d = this.addV5(o.name.replace(/^v08[45]/, 'up'), o.skew, true, doc, outbox)
      d.start()
      void d.triggerSync('boot')
    }
  }

  get quiet(): boolean {
    return this.v5.every((d) => !d.busy && d.outbox.size === 0)
  }

  /** Runs until a full poll period passes with no relay write and nothing pending. */
  async settle(maxMinutes = 60): Promise<boolean> {
    for (let i = 0; i < maxMinutes; i++) {
      const writes = this.relay.writes
      await this.clock.run(65_000)
      if (this.relay.writes === writes && this.quiet) return true
    }
    return false
  }

  /**
   * The owner opens each app again after the memo window (§11.7 resume, §19 step 6). Against a
   * relay last written by an old client, this is when v5 re-publishes its v5-only facts (§11.4
   * ext-refresh); from then on the relay is v5-written and the digest rule converges.
   */
  async resumeAll(): Promise<void> {
    await this.clock.run(11 * 60_000)
    for (const d of this.v5) {
      void d.triggerSync('resume')
      await this.clock.run(3000)
    }
  }

  /** 20 rounds of a full manual cycle on every v5 device; returns the pushes they made (I5). */
  async rounds(n = 20): Promise<number> {
    const before = this.v5.reduce((s, d) => s + d.pushes, 0)
    for (let i = 0; i < n; i++) {
      for (const d of this.v5) {
        void d.triggerSync('manual')
        await this.clock.run(2000)
      }
      await this.clock.run(2000)
    }
    return this.v5.reduce((s, d) => s + d.pushes, 0) - before
  }

  /** I2 (field oracle) and I4 (byte-equal replicas and relay) after quiescence. */
  checkConverged(): string[] {
    const docs = this.v5.map((d) => d.doc)
    const out = this.v5.flatMap((d) => d.errors.map((e) => `${d.name} threw: ${e}`))
    out.push(...checkI4(docs, this.relay.row))
    const first = docs[0]
    if (first !== undefined) out.push(...this.oracle.check(first))
    return out
  }

  stop(): void {
    for (const d of this.v5) d.stop()
    for (const o of this.old) o.client.close()
  }
}

/** Run a whole scenario for one seed; returns the world for assertions. */
export async function scenario(opts: WorldOptions, ops: number): Promise<World> {
  const w = new World(opts)
  await w.setup()
  await w.runOps(ops)
  return w
}

export const SKEWS = { slow: -DAY, fast: 2 * HOUR } as const

export interface RunReport {
  readonly seed: number
  readonly violations: readonly string[]
  /** v5 pushes in a 60 s window with no user activity (old clients may chatter). */
  readonly idlePushes: number
  readonly settled: boolean
  /** Pushes during 20 full manual rounds after quiescence (I5: must be 0). */
  readonly roundPushes: number
  /** Pushes caused by one add on one device after quiescence (I5: ≤ 2), when measured. */
  readonly addPushes: number | null
  readonly digest: string
  readonly ops: number
}

/** The standard run of §16.4 for one seed and one configuration. */
export async function standardRun(
  devices: readonly DeviceSpec[],
  seed: number,
  net: NetOptions,
  measureAdd = false,
): Promise<RunReport> {
  const w = new World({ seed, devices, net })
  await w.setup()
  await w.runOps(60 + w.rng.int(61))
  await w.clock.run(15_000)
  const idlePushes = await w.idle(60_000)
  w.upgradeAll()
  await w.settle()
  await w.resumeAll()
  const settled = await w.settle()
  const roundPushes = await w.rounds()
  let addPushes: number | null = null
  const first = w.v5[0]
  if (measureAdd && first !== undefined) {
    const before = w.v5.reduce((n, d) => n + d.pushes, 0)
    first.op((doc, ctx) => addExpense(doc, ctx, { itemName: 'one more', amount: 3 }))
    await w.settle()
    addPushes = w.v5.reduce((n, d) => n + d.pushes, 0) - before
  }
  const violations = [...w.violations, ...w.checkConverged()]
  if (!settled) violations.push('did not settle')
  w.stop()
  return {
    seed,
    violations,
    idlePushes,
    settled,
    roundPushes,
    addPushes,
    digest: w.traceDigest,
    ops: w.ops,
  }
}

/** Per-test timeout of a simulation file (virtual time is fast, but 150 seeds in CI take a while). */
export const SIM_TIMEOUT = 900_000

export interface RaceReport {
  readonly writes: number
  readonly lost: number
}

/**
 * T-001-2 shape: one device cycles continuously on a slow network while 60 adds land at random
 * points inside its pull and push awaits; counts adds that never survive.
 */
export async function raceRun(seed: number, readBeforeAwait: boolean): Promise<RaceReport> {
  const w = new World({
    seed,
    devices: [{ kind: 'v5' }, { kind: 'v5' }],
    net: { ...CALM, latency: [300, 900] },
    readBeforeAwait,
  })
  await w.setup()
  const d = w.v5[0]
  const other = w.v5[1]
  if (d === undefined || other === undefined) throw new Error('two devices expected')
  const ids: string[] = []
  for (let i = 0; i < 60; i++) {
    if (!d.busy) void d.triggerSync('manual')
    await w.clock.run(100 + w.rng.int(900))
    const r = d.op((doc, ctx) => addExpense(doc, ctx, { itemName: `race ${i}`, amount: 1 + i }))
    if (r.created !== undefined) ids.push(r.created.id)
  }
  await w.settle()
  const lost = ids.filter((id) => !d.doc.expenses.has(id) || !other.doc.expenses.has(id)).length
  w.stop()
  return { writes: ids.length, lost }
}

// ── pure, synchronous devices for scripted probes (no network model needed) ────────────────

/** A relay row holding the last pushed wire string. */
export class PureRelay {
  row: string | null = null
  writes = 0
}

/** A v5 replica driven by hand: ops on its own skewed clock, sync = pull → merge → push-if-news. */
export class PureDevice {
  doc: Doc
  readonly hlc = { last: 0 }
  readonly rng: Rng

  constructor(
    readonly name: string,
    readonly time: { now: number },
    readonly skew = 0,
    doc: Doc = EMPTY_DOC,
  ) {
    this.doc = doc
    this.rng = makeRng(name.length * 977 + name.charCodeAt(0))
  }

  wall(): number {
    return this.time.now + this.skew
  }

  ctx(): OpCtx {
    return { wall: this.wall(), clock: this.hlc, dev: this.name, rng: this.rng.next }
  }

  op(f: (doc: Doc, ctx: OpCtx) => OpResult): OpResult {
    const r = f(this.doc, this.ctx())
    this.doc = r.doc
    return r
  }

  /** One full cycle against the relay; returns the merge so probes can read its report. */
  sync(relay: PureRelay): MergeResult {
    const dec =
      relay.row === null ? null : decodeWire(JSON.parse(relay.row), 'remote', { reuse: this.doc })
    const m =
      dec === null
        ? { doc: this.doc, removed: [], replaced: [], editAfterDelete: [] }
        : mergeDoc(this.doc, dec.doc)
    this.doc = m.doc
    if (dec !== null) observe(this.hlc, this.wall(), maxStampDoc(dec.doc))
    if (dec === null || digestDoc(m.doc) !== digestDoc(dec.doc)) {
      relay.row = wireString(m.doc, { dev: this.name, rev: newRev(this.rng.next) })
      relay.writes++
    }
    return m
  }
}

/** Gossip through the relay until nothing changes (bounded). */
export function syncAll(devs: readonly PureDevice[], relay: PureRelay, rounds = 4): void {
  for (let i = 0; i < rounds; i++) for (const d of devs) d.sync(relay)
}
