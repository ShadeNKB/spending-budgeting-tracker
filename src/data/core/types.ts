// Shared types of the v5 data core (DATA-ENGINE-SPEC §3.1, track spec P-2). Type-only module.

/** Epoch ms inside the fixed window [MIN_T, MAX_T), or 0 = unknown / legacy (§4.1). */
export type Stamp = number

/** Tie-break strength of a field value at equal stamps (§5.1). */
export type Rank = 0 | 1 | 2

/** The six per-field registers of an expense: name, amount, category, date+day, notes, extras. */
export type FieldKey = 'n' | 'a' | 'c' | 'd' | 'o' | 'x'

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [k: string]: Json }

/** Unknown per-record wire fields, preserved verbatim. Always a null-prototype object. */
export type Extras = Readonly<Record<string, Json>>

export interface Reg<T> {
  readonly v: T
  readonly s: Stamp
  readonly r: Rank
}

/** `day` is the owner's calendar day ('yyyy-MM-dd'); `date` the v4 instant. They move together. */
export interface DateValue {
  readonly date: string
  readonly day?: string
}

export interface ExpenseRec {
  readonly id: string
  /** Raw string as first written; never rewritten. */
  readonly createdAt: string
  /** vs(createdAt) after sanitising. */
  readonly C: Stamp
  readonly n: Reg<string>
  readonly a: Reg<number>
  /** Raw category; materialised through the rename table at merge time. */
  readonly c: Reg<string>
  readonly d: Reg<DateValue>
  readonly o: Reg<string | null>
  readonly x: Reg<Extras>
}

/** `to: null` = the name is live. */
export interface RenameReg {
  readonly to: string | null
  readonly s: Stamp
}

/** Learned item → category (raw target). */
export interface MapReg {
  readonly v: string
  readonly s: Stamp
}

/** v4 budget semantics with both halves kept (§6.7). */
export interface BudgetReg {
  /** Last set value; null = never set. */
  readonly value: number | null
  /** budgetUpdatedAt */
  readonly set: Stamp
  /** budgetDeletedAt (0 = never deleted) */
  readonly del: Stamp
}

export interface PrefReg {
  readonly v: Json
  readonly s: Stamp
}

export interface DeviceInfo {
  readonly name: string
  readonly app: string
  readonly mode: 'table' | 'rpc'
  readonly rpcSince?: Stamp
  readonly e2e: boolean
  /** Last push by that device; excluded from the digest. */
  readonly seen: Stamp
}

export interface Doc {
  /** Live records only (I-doc-1). */
  readonly expenses: ReadonlyMap<string, ExpenseRec>
  /** Deleted ids → deletion stamp (0 = unknown). Grow-only, never capped. */
  readonly tombs: ReadonlyMap<string, Stamp>
  /** Listed names: grow-only set, local order (cosmetic). */
  readonly categories: readonly string[]
  readonly renames: ReadonlyMap<string, RenameReg>
  /** key = itemName.trim().toLowerCase() */
  readonly mappings: ReadonlyMap<string, MapReg>
  readonly budgets: ReadonlyMap<string, BudgetReg>
  readonly prefs: ReadonlyMap<string, PrefReg>
  readonly devices: ReadonlyMap<string, DeviceInfo>
}

/** Hybrid logical clock state; mutable, persisted in the envelope meta (§4.2). */
export interface Hlc {
  last: Stamp
}

/** Everything impure, injected (§3.1 + P-9). */
export interface OpCtx {
  /** Date.now() at the call site. */
  readonly wall: number
  readonly clock: Hlc
  /** Device id. */
  readonly dev: string
  /** Crypto-backed in production, seeded in tests. */
  readonly rng: () => number
  /** Demo build: `demo-*` rows are local-only and hard-deleted (§7.11). */
  readonly demoBuild?: boolean
}

export type OutboxKey =
  | `ex:${string}`
  | `del:${string}`
  | `cat:${string}`
  | `ren:${string}`
  | `map:${string}`
  | `bud:${string}`
  | `pref:${string}`

/** Keys a guarded `reg` undo item can restore. */
export type RegKey = `bud:${string}` | `pref:${string}`

export type UndoItem =
  /** Guard: live and every field stamp ≤ C (C = max field stamp when written). Forward write: tombstone. */
  | { readonly k: 'add'; readonly id: string; readonly C: Stamp }
  /** Guard per field: current stamp === wrote. Forward write: prev.v at tick(base = wrote). */
  | {
      readonly k: 'edit'
      readonly id: string
      readonly fields: readonly UndoField[]
    }
  /** Guard: reviveId(prev) exists and is not already live with the same content. Forward write: revive. */
  | { readonly k: 'delete'; readonly prev: ExpenseRec }
  /** Guard: current stamp === wrote. Forward write: prev at a fresh tick. */
  | {
      readonly k: 'reg'
      readonly key: RegKey
      readonly prev: BudgetReg | PrefReg | null
      readonly wrote: Stamp
    }
  /** Guard per id: c still equals cWas. Forward write: renames[from] := live, then c := from. */
  | {
      readonly k: 'recat'
      readonly from: string
      readonly into: string
      readonly ids: readonly string[]
      readonly cWas: readonly Reg<string>[]
      /**
       * A rename onto a name that had been renamed away re-adds it first: `into` is sent back to
       * that target, guarded by its register still being the live one the rename wrote.
       */
      readonly intoWas?: { readonly to: string; readonly wrote: Stamp }
    }
  /** Undo of a rename to a NEW name: renames[from] := live, renames[to] := from (§7.4 step 5). */
  | { readonly k: 'unrename'; readonly from: string; readonly to: string; readonly wrote: Stamp }

export type UndoField =
  | { readonly f: 'n'; readonly prev: Reg<string>; readonly wrote: Stamp }
  | { readonly f: 'a'; readonly prev: Reg<number>; readonly wrote: Stamp }
  | { readonly f: 'c'; readonly prev: Reg<string>; readonly wrote: Stamp }
  | { readonly f: 'd'; readonly prev: Reg<DateValue>; readonly wrote: Stamp }
  | { readonly f: 'o'; readonly prev: Reg<string | null>; readonly wrote: Stamp }
  | { readonly f: 'x'; readonly prev: Reg<Extras>; readonly wrote: Stamp }

export interface UndoEntry {
  readonly id: string
  /** English copy as shipped today (P-19). */
  readonly label: string
  readonly expiresAt: number
  readonly items: readonly UndoItem[]
}

export interface OpReport {
  readonly applied: number
  readonly skipped: number
}

export interface OpResult {
  readonly doc: Doc
  readonly touched: readonly (readonly [OutboxKey, Stamp])[]
  readonly undo?: UndoEntry
  readonly report?: OpReport
  /** The record an add created (adapters return it as the new view). */
  readonly created?: ExpenseRec
}

export interface NewExpenseInput {
  readonly itemName: string
  readonly amount: number
  readonly category?: string
  /** 'yyyy-MM-dd'; defaults to today's local day. */
  readonly day?: string
  readonly notes?: string
}

/** `notes: ''` clears the notes. */
export type ExpensePatch = Partial<
  Pick<NewExpenseInput, 'itemName' | 'amount' | 'category' | 'day' | 'notes'>
>

export type Origin = 'local-envelope' | 'local-v4' | 'remote' | 'file' | 'snapshot'

export type WriterClass = 'v5' | 'v085' | 'v084' | 'moved' | 'newer' | 'e2e' | 'invalid'

export interface QEntry {
  readonly at: number
  readonly origin: Origin
  readonly reason: string
  /** JSON of the raw value, ≤ 64 KB. */
  readonly raw: string
}

export interface SanitizeReport {
  /** Records that are not live (unreadable or over the cap): raw kept, shown as "needs attention". */
  readonly quarantined: readonly QEntry[]
  readonly repaired: number
  /**
   * The ORIGINAL raw value of everything the sanitiser changed or dropped while the rest stayed live
   * (§8.1: "the original raw value goes to the quarantine log"; R1 keep and report): one entry per
   * repaired record (`repaired:<fields>`, the whole raw record) and per dropped collection piece
   * (`dropped:<label>`, with its key). Live records + quarantined + repairs account for every input.
   */
  readonly repairs: readonly QEntry[]
  readonly deduped: number
  /**
   * Ids the source lists both live and deleted. Migrating local data: revived under reviveId (v0.8
   * shows them). A fold of v4 keys: left out, neither row nor tombstone. Elsewhere: the tombstone
   * wins. Each one that does not stay live keeps its original in `repairs` ('live-and-deleted').
   */
  readonly liveAndDeleted: number
  readonly droppedKeys: readonly string[]
}

export interface SanitizeResult {
  /** Always a valid Doc (possibly empty). */
  readonly doc: Doc
  readonly writer: WriterClass
  readonly report: SanitizeReport
  /** v0.8's ts(updatedAt ?? createdAt) of each raw record of an old-writer payload (P-11). */
  readonly legacyTs: ReadonlyMap<string, number>
  /** x5.rev of a v5 payload (echo filter, lost-response detection). */
  readonly rev: string | null
}

export interface MergeReplaced {
  readonly before: ExpenseRec
  readonly after: ExpenseRec
  readonly fields: readonly FieldKey[]
}

export interface MergeResult {
  readonly doc: Doc
  readonly removed: readonly ExpenseRec[]
  readonly replaced: readonly MergeReplaced[]
  readonly editAfterDelete: readonly ExpenseRec[]
}

export type CycleReason =
  | 'boot'
  | 'resume'
  | 'local-change'
  | 'remote'
  | 'poll'
  | 'online'
  | 'manual'
  | 'resubscribe'
  | 'hide'
  | 'again'

export type PushWhy =
  | 'create'
  | 'repair'
  | 'v5-diff'
  | 'adoptable'
  | 'ext-refresh'
  | 'equal'
  | 'memo'
  | 'old-quiet'
  | 'moved'
  | 'newer'
  | 'e2e-unopened'

export interface PushDecision {
  readonly kind: 'push' | 'none' | 'suppressed'
  readonly why: PushWhy
  /** digest(dec.doc) for an `adoptable` push: committed to the memo only after the push lands. */
  readonly memoKey: string | null
}

export interface MemoState {
  readonly memo: readonly (readonly [string, number])[]
  readonly extRefreshAt: number
}

/** What the transport returned for the row (null = row missing). */
export interface PulledRow {
  readonly etag: string
}

export interface ImportCounts {
  /** Readable rows in the file. */
  readonly inFile: number
  readonly added: number
  readonly restored: number
  readonly updated: number
  readonly alreadyHere: number
  /** Rows that will not be applied: unreadable in the file, or deleted here with no free revive id. */
  readonly unreadable: number
  /**
   * Rows the file itself lists both live and deleted (a v0.8 export taken while two tabs were open,
   * or after a v0.8.4 undo re-used the id). The file's tombstone wins (§8.2), as v0.8 restores it, so
   * they are not applied; their originals stay in the decode report for the preview.
   */
  readonly deletedInFile: number
}

export interface ImportPlan {
  /** The sanitised file. */
  readonly file: Doc
  readonly counts: ImportCounts
  /** Live ids that a 'replace' would tombstone (not in the file). */
  readonly replaceDeletes: number
}

/** The seven v4 storage keys (§9.2). */
export type V4Key =
  | 'expenses'
  | 'categories'
  | 'categoryMappings'
  | 'categoryBudgets'
  | 'categoryBudgetUpdatedAt'
  | 'categoryBudgetDeletedAt'
  | 'deletedExpenseIds'

export type SizeClass = 'ok' | 'warn' | 'too-large'

/** A record on the wire (§5.2): a v0.8 record plus optional day/fs/h and preserved extras. */
export type WireRecord = Readonly<Record<string, unknown>>

export interface WireDevice {
  readonly n: string
  readonly app: string
  readonly m: 'table' | 'rpc'
  readonly e: 0 | 1
  readonly rs: Stamp
  readonly at: Stamp
}

/** The v5 block of a payload (§10.1). v0.8 clients drop it when they rebuild their push. */
export interface X5Block {
  readonly schema: number
  readonly minor: number
  readonly min: number
  readonly dev?: string
  readonly rev?: string
  readonly dig: string
  readonly dts: readonly Stamp[]
  readonly ren: Readonly<Record<string, readonly [Stamp, string | null]>>
  readonly mts: Readonly<Record<string, Stamp>>
  readonly pref: Readonly<Record<string, readonly [Stamp, Json]>>
  readonly devs?: Readonly<Record<string, WireDevice>>
}

/** The plaintext relay payload: a valid v0.8 payload plus `x5` (§10.1). */
export interface WireDocV5 {
  readonly version: string
  readonly exportDate: string
  readonly expenses: readonly WireRecord[]
  readonly categories: readonly string[]
  readonly categoryMappings: Readonly<Record<string, string>>
  readonly budgets: Readonly<Record<string, number>>
  readonly budgetUpdatedAt: Readonly<Record<string, string>>
  readonly budgetDeletedAt: Readonly<Record<string, string>>
  readonly deletedIds: readonly string[]
  readonly x5: X5Block
}

/** The v5 backup file (§10.6): the payload shape, marked, without dev/rev/devs. */
export type BackupFileV5 = { readonly spendtrack: 'backup' } & WireDocV5

/** The retired/moved marker of a plaintext row (§10.5). */
export interface MovedMarker {
  readonly version: '4.0'
  readonly expenses: 'moved'
  readonly categories: readonly []
  readonly categoryMappings: Readonly<Record<string, never>>
  readonly x5: {
    readonly schema: number
    readonly minor: number
    readonly min: number
    readonly moved: { readonly at: string; readonly why: 'private' | 'rotated' | 'stopped' }
  }
}
