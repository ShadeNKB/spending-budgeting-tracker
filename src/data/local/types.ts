// Types the local engine shares with its facade (track spec §6.1, §6.2). Type-only module: the
// facade in the entry chunk re-exports these without pulling the engine in.
import type {
  BackupFileV5,
  DeviceInfo,
  Doc,
  ExpensePatch,
  ImportCounts,
  MemoState,
  NewExpenseInput,
  Origin,
  OutboxKey,
  PushDecision,
  QEntry,
  SanitizeResult,
  Stamp,
} from '../core/types'
import type { ExpenseView } from '../../types'

export type LocalStatus = 'saved' | 'error-quota' | 'error-storage' | 'memory-only'

export interface Attention {
  /** Everything set aside that the owner should look at: unreadable entries plus `copies`. */
  readonly quarantined: number
  /** Of those, whole stored copies kept as found (a damaged envelope, a v4 key): not entries. */
  readonly copies: number
  readonly unseen: number
  readonly full: boolean
}

export interface StorageFacts {
  readonly persisted: boolean | null
  readonly lastBackupAt: number | null
  readonly mirror: 'on' | 'off'
  /** ≥ 80 % of LS_BUDGET. */
  readonly nearlyFull: boolean
}

/** One-shot; null when nothing to say. */
export interface BootReport {
  readonly kind: 'upgraded' | 'recovered'
  readonly entries: number
  readonly needsAttention: number
  readonly repaired: number
  readonly deduped: number
  readonly revived: number
}

/** Opaque plan inside (held by the engine); never serialised. */
export interface ImportPreview {
  readonly fileName: string
  readonly counts: ImportCounts
  readonly replaceDeletes: number
}

export interface UndoOutcome {
  readonly applied: number
  readonly skipped: number
}

// ── the Recovery centre (DATA-ENGINE-SPEC §15.5, PR-4 track spec §3.1) ──────────────────────

export type SnapshotReason = 'daily' | 'pre-v5' | 'delete-all' | 'import' | 'replace' | 'mass'

export interface SnapshotInfo {
  readonly id: string
  readonly at: number
  readonly reason: SnapshotReason
  readonly rows: number
  /**
   * False for a removal's copy that no longer says which entries that removal took (an older
   * index, its journal entry gone): it can be downloaded, never restored.
   */
  readonly restorable: boolean
}

/** What a snapshot restore leaves alone, as it stands now (every restore plans again). */
export interface SnapshotSkips {
  /** Restored before and still here (maybe edited since). */
  readonly back: number
  /** Restored before and deleted again since, here or on the other device: they stay deleted. */
  readonly deletedSince: number
}

/** A journaled record as the owner reads it (from the stored wire record, every field guarded). */
export interface RecordSummary {
  readonly itemName: string
  readonly amount: number | null
  readonly day: string | null
  readonly category: string | null
  readonly notes: string | null
}

export interface ChangeItem {
  readonly id: string
  readonly at: number
  readonly seen: boolean
  /** Kept until seen, and counted as new: a conflict or a mass removal. */
  readonly pinned: boolean
  readonly kind: 'conflict' | 'replaced' | 'removed' | 'edit-after-delete' | 'mass'
  readonly before: RecordSummary | null
  readonly after: RecordSummary | null
  /** mass: the entries the removal took; else 1. */
  readonly count: number
}

export interface AttentionItem {
  /** `${origin}|${fnv36(raw)}` for an entry; the storage key for a whole copy. */
  readonly id: string
  readonly at: number
  readonly origin: Origin
  /** The quarantine reason code ('bad-amount', 'cap', …; 'copy' for a whole stored copy). */
  readonly reason: string
  readonly kind: 'entry' | 'copy'
  /** What a Fix can prefill; null when the row has neither a readable name nor an amount. */
  readonly salvage: {
    readonly itemName?: string
    readonly amount?: number
    readonly day?: string
    readonly category?: string
    readonly notes?: string
  } | null
}

export type RestoreResult = UndoOutcome & {
  /** The undo entry of an applied restore (30 s), else null. */
  readonly undoId: string | null
  readonly why: null | 'already' | 'changed-since' | 'deleted-since' | 'gone'
}

export interface RecoveryApi {
  summary(): { readonly snapshots: number; readonly newChanges: number; readonly canWrite: boolean }
  /** Newest first, from the index alone (no body is read). */
  snapshots(): readonly SnapshotInfo[]
  /**
   * Applied with applyImport(preview, 'restore'), which plans it again against the entries then.
   * Throws when the copy no longer reads, or can only be downloaded.
   */
  previewSnapshot(id: string): Promise<ImportPreview>
  /** What that snapshot preview leaves alone now; zeros for any other preview. */
  snapshotSkips(preview: ImportPreview): SnapshotSkips
  /** A v5 backup file of that snapshot; null when it no longer reads. Records no backup. */
  snapshotFile(id: string): Promise<BackupFileV5 | null>
  /** Pinned unseen first, then newest first. */
  changes(): readonly ChangeItem[]
  restoreChange(id: string): Promise<RestoreResult>
  markAllSeen(): void
  /** Needs-attention rows, then the raw copies of whole stored values (never the sync code's). */
  attention(): readonly AttentionItem[]
  /** That one item, in the needs-attention download's shape; null when it is gone. */
  attentionFile(id: string): unknown
  markFixed(id: string): void
  /** Lists a fixed item again (the entry its Fix added was undone). */
  unmarkFixed(id: string): void
  discard(id: string): void
}

export interface ImportOutcome extends UndoOutcome {
  readonly added: number
  readonly restored: number
  readonly updated: number
  /** Entries a Replace deleted everywhere (0 for a Restore). */
  readonly removed: number
}

export interface UndoToastEntry {
  readonly id: string
  readonly label: string
  readonly expiresAt: number
}

/** The store fields the engine publishes (everything but the actions). */
export interface ExpenseFields {
  hydrated: boolean
  bootError: 'engine-load' | null
  expenses: readonly ExpenseView[]
  categories: readonly string[]
  categoryMappings: Readonly<Record<string, string>>
  budgets: Readonly<Record<string, number>>
  /** Categories set aside: their entries are kept and leave every total (F-057). */
  asideCategories: readonly string[]
  /** One budget for the whole month's spending; null when none is set. */
  monthBudget: number | null
  syncStatus: 'idle' | 'saving' | 'saved' | 'error'
  lastSavedAt: number | null
  isOffline: boolean
  local: LocalStatus
  undoStack: readonly UndoToastEntry[]
  attention: Attention
  facts: StorageFacts
  report: BootReport | null
  demo: 'none' | 'sample'
}

export interface ExpenseActions {
  addExpense(input: NewExpenseInput): ExpenseView
  /** The write waiting for this task's flush, made now; the save status it leaves. */
  saveNow(): LocalStatus
  updateExpense(id: string, patch: ExpensePatch): void
  deleteExpense(id: string): void
  deleteAllEverywhere(): void
  /** Wipes every SpendTrack key on this device and reloads (the backup is the UI's own step first). */
  removeDataFromThisDevice(): Promise<void>
  /** Changes this device has not got onto the relay yet (0 with sync off). */
  unsyncedChanges(): number
  clearSampleData(): void
  addCategory(name: string): void
  renameCategory(from: string, to: string): void
  removeCategory(name: string): void
  setBudget(category: string, amount: number): void
  removeBudget(category: string): void
  /** Sets a category aside (true), or counts it as spending again. */
  setCategoryAside(category: string, aside: boolean): void
  /** The whole-month budget; null removes it. */
  setMonthBudget(amount: number | null): void
  setCurrency(code: string): void
  getSmartCategory(itemName: string): string | null
  previewImport(file: Blob): Promise<ImportPreview>
  applyImport(preview: ImportPreview, mode: 'restore' | 'replace'): ImportOutcome
  /** The backup file. Pure: the download that saves it records itself with markBackedUp(). */
  exportBackup(): BackupFileV5
  /** A backup file was handed to the browser just now (F-050's "Last backup"). */
  markBackedUp(): void
  quarantineFile(): unknown
  markAttentionSeen(): void
  restoreJournal(entryId: string): Promise<RestoreResult>
  /** The Recovery centre (its own lazy chunk, loaded on the first call). */
  recovery(): Promise<RecoveryApi>
  refreshStorageFacts(): void
  dismissReport(): void
  consumeUndo(id: string): UndoOutcome | null
  clearUndo(id: string): void
}

export interface SyncMeta {
  /** x5.rev of our last landed push. */
  readonly lastRev: string | null
  /** core push.ts; persisted in envelope meta.sync. */
  readonly memo: MemoState
  /** When an old writer's payload was last pulled (§11.10); v5pre = a 0.10.0 writer (P3-8). */
  readonly legacySeen: { readonly v084?: number; readonly v085?: number; readonly v5pre?: number }
  /** The device that wrote as 0.10.0 when `legacySeen.v5pre` was stamped (it never registers). */
  readonly v5preDev: string | null
  /** P2-8: the last repair push of an invalid relay copy. */
  readonly repairAt: number
  /** The relay row's `updated_at` as PostgREST returned it, once this device holds that copy (P3-3). */
  readonly lastEtag: string | null
  /** fnv36 of the code `lastEtag` belongs to (the code itself is never stored here). */
  readonly etagFor: string | null
  /** Detected relay mode (pin 'auto' only); null = not probed yet. */
  readonly transport: 'table' | 'rpc' | null
  readonly probedAt: number
}

export interface RemoteApplied {
  readonly changedLocal: boolean
  readonly removed: number
  /** The mass-removal guard tripped (§11.9). */
  readonly mass: { readonly entryId: string; readonly count: number } | null
  /** New needs-attention entries from this payload. */
  readonly quarantined: number
  /** Journaled conflicts of this merge (0 when the mass guard tripped: its Undo toast says it). */
  readonly conflicts: number
}

export type CommitSource = 'local' | 'tab' | 'remote' | 'boot'

export interface SyncPort {
  /** Fresh read. Call only inside the bridge's synchronous section. */
  doc(): Doc
  /** Bumped by every commit that is not a remote apply (user ops, cross-tab absorb, fold). */
  localRev(): number
  outbox(): ReadonlyMap<OutboxKey, Stamp>
  /** Synchronous: guard → snapshot → mergeDoc(current, dec.doc) → commit (flushed now) → journal → observe(clock). */
  applyRemote(dec: SanitizeResult): RemoteApplied
  /** core ackOutbox on the current outbox, persisted; returns waitingForOld. */
  ack(
    sent: readonly (readonly [OutboxKey, Stamp])[],
    dec: SanitizeResult,
    outcome: 'pushed' | PushDecision,
  ): number
  meta(): SyncMeta
  /** Persisted with the next flush (now). */
  setMeta(patch: Partial<SyncMeta>): void
  deviceId(): string
  /** Demo rows on a demo build. */
  omitIds(): ((id: string) => boolean) | undefined
  /**
   * Commits devices[id] := info: no outbox entry, no localRev bump, the same `expenses` Map (so
   * the digest reuses its record hashes); written with the next flush (P3-7).
   */
  register(id: string, info: DeviceInfo): void
  /** Returns how many were new. */
  quarantine(entries: readonly QEntry[]): number
  /**
   * Keeps an unreadable relay copy whole (not the 64 KB excerpt its quarantine entry holds), so
   * a repair push never overwrites the only copy of it. False when it could not be stored.
   */
  keepRelayCopy(raw: unknown): boolean
  onCommit(listener: (source: CommitSource) => void): () => void
  /** Crypto-backed (newRev). */
  rng(): number
}

/** What the facade hands the engine: the store's setter and the UI currency mirror. */
export interface EngineHost {
  readonly set: (patch: Partial<ExpenseFields>) => void
  /** The currency the UI shows (P2-11). */
  readonly showCurrency: (code: string) => void
  /** The device's own choice (`spendtrack:currency`) or its resolved default. */
  readonly deviceCurrency: () => string
}

export interface Engine extends ExpenseActions {
  /** P2-14: flushes pending writes, then boots from the current storage. Never throws. */
  boot(): Promise<void>
  readonly port: SyncPort
  /** Lifecycle flush: the envelope, then the mirror, synchronously. */
  flushAll(): void
  /** Lifecycle and storage listeners (idempotent). */
  install(): void
}
