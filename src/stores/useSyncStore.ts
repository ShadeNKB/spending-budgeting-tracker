import { create } from "zustand";
import { storage } from "../services/storage";
import {
  syncEnabled,
  syncApplying,
  pushSync,
  pullSync,
  subscribeSync,
  mergeBackups,
} from "../services/syncService";
import { useExpenseStore } from "./useExpenseStore";

export type CloudStatus = "idle" | "syncing" | "synced" | "error";

interface SyncState {
  syncId: string | null;
  cloudStatus: CloudStatus;
  lastSyncAt: number | null;

  initSync: () => void;
  setupSync: (syncId: string) => Promise<void>;
  disconnectSync: () => Promise<void>;
  triggerSync: () => Promise<void>;
  scheduleSyncPush: () => void;
}

// ---------------------------------------------------------------------------
// Module-level coordination state
// ---------------------------------------------------------------------------

// Single in-flight sync at a time — prevents push-during-pull races.
let inFlight: Promise<void> | null = null;
// Generation counter — invalidates stale realtime subscriptions when sync code changes.
let setupGen = 0;
// Realtime unsubscribe handle for the current sync code.
let realtimeUnsub: (() => void) | null = null;
// Debounced push timer.
let pushTimer: ReturnType<typeof setTimeout> | null = null;
// Retry timer for exponential backoff after a failed sync.
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

const PUSH_DEBOUNCE_MS = 3000;
const MAX_RETRY_DELAY_MS = 2 * 60 * 1000; // cap at 2 minutes

function clearTimers() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSyncStore = create<SyncState>((set, get) => ({
  syncId: null,
  cloudStatus: "idle",
  lastSyncAt: null,

  initSync: () => {
    if (!syncEnabled) return;
    const saved = storage.getSyncId();
    if (saved) {
      get().setupSync(saved).catch((err) => console.error("[sync] initSync", err));
    }
  },

  setupSync: async (syncId: string) => {
    storage.saveSyncId(syncId);
    const gen = ++setupGen;
    set({ syncId });

    // Tear down previous subscription first.
    if (realtimeUnsub) {
      try { realtimeUnsub(); } finally { realtimeUnsub = null; }
    }

    // First-connect order: pull-then-subscribe so we don't miss the very first
    // remote-edit event that fires between subscribe and pull.
    await get().triggerSync();
    if (gen !== setupGen) return; // a newer setupSync superseded us

    realtimeUnsub = await subscribeSync(syncId, () => {
      // Stale subscription guard.
      if (gen !== setupGen) return;
      get().triggerSync().catch((err) => console.error("[sync] realtime trigger", err));
    });
  },

  disconnectSync: async () => {
    setupGen++; // invalidate any pending subscriptions
    storage.saveSyncId(null);
    set({ syncId: null, cloudStatus: "idle", lastSyncAt: null });
    clearTimers();
    retryAttempt = 0;
    if (realtimeUnsub) {
      try { realtimeUnsub(); } finally { realtimeUnsub = null; }
    }
  },

  triggerSync: async () => {
    const { syncId } = get();
    if (!syncId || !syncEnabled) return;

    // Reuse in-flight sync — avoids push-during-pull race.
    if (inFlight) return inFlight;

    set({ cloudStatus: "syncing" });
    inFlight = (async () => {
      try {
        const expStore = useExpenseStore.getState();
        const local = expStore.exportBackup();
        const remote = await pullSync(syncId);
        const merged = remote ? mergeBackups(local, remote) : local;

        // Apply merged locally — `syncApplying` blocks the persistence subscriber
        // from scheduling another push (the loop-break flag).
        syncApplying.value = true;
        try {
          expStore.applySync(merged);
        } finally {
          syncApplying.value = false;
        }

        await pushSync(syncId, merged);

        set({ cloudStatus: "synced", lastSyncAt: Date.now() });
        retryAttempt = 0; // reset on success
      } catch (err) {
        console.error("[sync] triggerSync failed", err);
        syncApplying.value = false;
        set({ cloudStatus: "error" });
        scheduleRetry();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  scheduleSyncPush: () => {
    if (!get().syncId || !syncEnabled) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      get().triggerSync().catch((err) => console.error("[sync] push", err));
    }, PUSH_DEBOUNCE_MS);
  },
}));

// ---------------------------------------------------------------------------
// Retry-with-backoff helper (lives outside the store to share module state).
// ---------------------------------------------------------------------------

function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryAttempt = Math.min(retryAttempt + 1, 8); // cap exponent
  // 3s, 6s, 12s, 24s, 48s, 96s, then capped at 120s.
  const delay = Math.min(MAX_RETRY_DELAY_MS, 1500 * Math.pow(2, retryAttempt));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    useSyncStore.getState().triggerSync().catch(() => {/* re-scheduled inside */});
  }, delay);
}
