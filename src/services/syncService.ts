// Cross-device sync layer.
// - Local-first: localStorage is source of truth, Supabase is a stateless relay.
// - Per-expense Last-Write-Wins merge by `updatedAt ?? createdAt`.
// - Tombstone set (`deletedIds`) is unioned across devices.
// - The Supabase JS SDK is lazy-loaded so unconfigured users never pay for it.

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { BackupData, Expense } from "../types";
import { DEFAULT_CATEGORIES } from "../constants";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const syncEnabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const TABLE = "sync_buckets";
const PAYLOAD_WARN_BYTES = 800 * 1024; // 800 KB — below Supabase free-tier 1 MB row limit
const TOMBSTONE_CAP = 1000; // cap the deletedIds array; oldest pruned first
const REALTIME_RECONNECT_DELAY = 2000;

// Module-level flag: prevents circular push when applying remote data locally.
export const syncApplying = { value: false };

// ---------------------------------------------------------------------------
// Lazy-loaded Supabase client
// ---------------------------------------------------------------------------

let clientPromise: Promise<SupabaseClient | null> | null = null;

function getClient(): Promise<SupabaseClient | null> {
  if (!syncEnabled) return Promise.resolve(null);
  if (clientPromise) return clientPromise;
  clientPromise = import("@supabase/supabase-js").then((m) =>
    m.createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      realtime: { params: { eventsPerSecond: 2 } },
    })
  );
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

function ts(value: string | undefined): number {
  return value ? new Date(value).getTime() : 0;
}

export function mergeBackups(local: BackupData, remote: BackupData): BackupData {
  const localMap = new Map<string, Expense>(local.expenses.map((e) => [e.id, e]));
  const remoteMap = new Map<string, Expense>(remote.expenses.map((e) => [e.id, e]));

  // Union tombstones — once an ID is deleted on any device it stays deleted.
  const tombstones = new Set<string>([
    ...(local.deletedIds ?? []),
    ...(remote.deletedIds ?? []),
  ]);

  // Union of all expense IDs, keep whichever copy has the newer timestamp.
  const allIds = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
  const merged: Expense[] = [];

  for (const id of allIds) {
    if (tombstones.has(id)) continue;
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    if (!l) { merged.push(r!); continue; }
    if (!r) { merged.push(l); continue; }
    const lTime = ts(l.updatedAt ?? l.createdAt);
    const rTime = ts(r.updatedAt ?? r.createdAt);
    merged.push(lTime >= rTime ? l : r);
  }

  // Keep store consistently sorted by date desc.
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Categories: union, deduped, preserving local order first.
  const categories = [...new Set([...local.categories, ...remote.categories])];
  if (!categories.length) categories.push(...DEFAULT_CATEGORIES);

  // Mappings + budgets: LOCAL-wins on key conflict.
  //
  // These are non-versioned objects (no per-key timestamps), so we can't do
  // true per-key Last-Write-Wins. Local-wins ensures user edits survive the
  // sync round-trip — otherwise the very next push would pull a stale remote
  // value and clobber what the user just typed (e.g. budget set to $200
  // reverts to $150 three seconds later).
  //
  // Trade-off: in a true concurrent-edit race across two devices within the
  // same sync window, the most-recently-pushing device wins. For budgets and
  // category mappings (rare edits), this is acceptable — and crucially, the
  // single-device case (the common one) works correctly.
  const categoryMappings = { ...remote.categoryMappings, ...local.categoryMappings };
  const budgets = { ...remote.budgets, ...local.budgets };

  // Cap tombstones — only the most recently deleted IDs we still need to broadcast.
  // Tombstones older than the cap are assumed to have propagated to all devices already.
  const cappedTombstones = [...tombstones].slice(-TOMBSTONE_CAP);

  return {
    expenses: merged,
    categories,
    categoryMappings,
    budgets,
    deletedIds: cappedTombstones,
    exportDate: new Date().toISOString(),
    version: "3.0",
  };
}

// ---------------------------------------------------------------------------
// Remote operations
// ---------------------------------------------------------------------------

export class PayloadTooLargeError extends Error {
  constructor(public bytes: number) {
    super(`Sync payload is ${(bytes / 1024).toFixed(0)} KB — too large to safely sync.`);
  }
}

export async function pushSync(syncId: string, data: BackupData): Promise<void> {
  const client = await getClient();
  if (!client) throw new Error("Sync not configured");

  // Pre-flight payload size check — Supabase free tier caps rows at ~1 MB.
  // Warn only in dev (Vite replaces import.meta.env.DEV with a static boolean).
  const serialized = JSON.stringify(data);
  if (serialized.length > PAYLOAD_WARN_BYTES) {
    if (import.meta.env.DEV) {
      console.warn(`[sync] payload is ${(serialized.length / 1024).toFixed(0)} KB — approaching row limit`);
    }
    if (serialized.length > 1024 * 1024) throw new PayloadTooLargeError(serialized.length);
  }

  const { error } = await client
    .from(TABLE)
    .upsert({ sync_id: syncId, payload: data, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function pullSync(syncId: string): Promise<BackupData | null> {
  const client = await getClient();
  if (!client) throw new Error("Sync not configured");
  const { data, error } = await client
    .from(TABLE)
    .select("payload")
    .eq("sync_id", syncId)
    .maybeSingle();
  if (error) throw error;
  return data ? (data.payload as BackupData) : null;
}

/**
 * Subscribe to remote changes. Auto-reconnects if the channel drops.
 * Returns a Promise<unsub> because the SDK is lazy-loaded.
 */
export async function subscribeSync(
  syncId: string,
  onUpdate: () => void
): Promise<() => void> {
  const client = await getClient();
  if (!client) return () => {};

  let active = true;
  let channel: RealtimeChannel | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (!active || !client) return;
    channel = client
      .channel(`sync:${syncId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE, filter: `sync_id=eq.${syncId}` }, () => {
        if (active) onUpdate();
      })
      .subscribe((status) => {
        // Realtime sometimes drops silently on flaky networks — re-arm if so.
        if (active && (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT")) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            if (!active || !client) return;
            client.removeChannel(channel!);
            channel = null;
            open();
          }, REALTIME_RECONNECT_DELAY);
        }
      });
  };

  open();

  return () => {
    active = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (channel && client) client.removeChannel(channel);
    channel = null;
  };
}
