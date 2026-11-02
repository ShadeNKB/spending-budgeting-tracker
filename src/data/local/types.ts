// Types the local engine shares with its facade (track spec §6.1, §6.2). Type-only module: the
// facade in the entry chunk re-exports these without pulling the engine in.
import type {
  BackupFileV5,
  Doc,
  ExpensePatch,
  ImportCounts,
  MemoState,
  NewExpenseInput,
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
  restoreJournal(entryId: string): Promise<UndoOutcome>
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
  readonly legacySeen: { readonly v084?: number; readonly v085?: number }
  /** P2-8: the last repair push of an invalid relay copy. */
  readonly repairAt: number
}

export interface RemoteApplied {
  readonly changedLocal: boolean
  readonly removed: number
  /** The mass-removal guard tripped (§11.9). */
  readonly mass: { readonly entryId: string; readonly count: number } | null
  /** New needs-attention entries from this payload. */
  readonly quarantined: number
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
