import { createClient } from "@supabase/supabase-js";
import type { BackupData, Expense } from "../types";
import { DEFAULT_CATEGORIES } from "../constants";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const syncEnabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const supabase = syncEnabled
  ? createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      realtime: { params: { eventsPerSecond: 2 } },
    })
  : null;

const TABLE = "sync_buckets";

// Module-level flag: prevents circular push when applying remote data locally.
export const syncApplying = { value: false };

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

function newerTimestamp(a: string | undefined, b: string | undefined): number {
  return new Date(a ?? "1970-01-01").getTime() - new Date(b ?? "1970-01-01").getTime();
}

export function mergeBackups(local: BackupData, remote: BackupData): BackupData {
  const localMap = new Map<string, Expense>(local.expenses.map((e) => [e.id, e]));
  const remoteMap = new Map<string, Expense>(remote.expenses.map((e) => [e.id, e]));

  // Union tombstones — a deleted ID is permanently gone on all devices.
  const tombstones = new Set<string>([
    ...(local.deletedIds ?? []),
    ...(remote.deletedIds ?? []),
  ]);

  // Union of all expense IDs, keep whichever copy is newer.
  const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
  const merged: Expense[] = [];

  for (const id of allIds) {
    if (tombstones.has(id)) continue;
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    if (!l) { merged.push(r!); continue; }
    if (!r) { merged.push(l); continue; }
    const lTime = newerTimestamp(l.updatedAt ?? l.createdAt, undefined);
    const rTime = newerTimestamp(r.updatedAt ?? r.createdAt, undefined);
    merged.push(lTime >= rTime ? l : r);
  }

  // Sort descending by date so the store stays consistently ordered.
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Categories: union, deduplicated, preserve order (local first).
  const categories = [
    ...new Set([...local.categories, ...remote.categories]),
  ];
  if (!categories.length) categories.push(...DEFAULT_CATEGORIES);

  // Mappings + budgets: remote wins on key conflict (most-recently-synced device wins).
  const categoryMappings = { ...local.categoryMappings, ...remote.categoryMappings };
  const budgets = { ...local.budgets, ...remote.budgets };

  return {
    expenses: merged,
    categories,
    categoryMappings,
    budgets,
    deletedIds: [...tombstones],
    exportDate: new Date().toISOString(),
    version: "3.0",
  };
}

// ---------------------------------------------------------------------------
// Remote operations
// ---------------------------------------------------------------------------

export async function pushSync(syncId: string, data: BackupData): Promise<void> {
  if (!supabase) throw new Error("Sync not configured");
  const { error } = await supabase
    .from(TABLE)
    .upsert({ sync_id: syncId, payload: data, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function pullSync(syncId: string): Promise<BackupData | null> {
  if (!supabase) throw new Error("Sync not configured");
  const { data, error } = await supabase
    .from(TABLE)
    .select("payload")
    .eq("sync_id", syncId)
    .maybeSingle();
  if (error) throw error;
  return data ? (data.payload as BackupData) : null;
}

export function subscribeSync(
  syncId: string,
  onUpdate: () => void
): () => void {
  if (!supabase) return () => {};

  const channel = supabase
    .channel(`sync:${syncId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: TABLE, filter: `sync_id=eq.${syncId}` },
      () => onUpdate()
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: TABLE, filter: `sync_id=eq.${syncId}` },
      () => onUpdate()
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}
