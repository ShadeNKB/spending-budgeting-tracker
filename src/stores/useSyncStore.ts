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
  disconnectSync: () => void;
  triggerSync: () => Promise<void>;
  scheduleSyncPush: () => void;
}

let realtimeUnsub: (() => void) | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

export const useSyncStore = create<SyncState>((set, get) => ({
  syncId: null,
  cloudStatus: "idle",
  lastSyncAt: null,

  initSync: () => {
    if (!syncEnabled) return;
    const saved = storage.getSyncId();
    if (saved) {
      get().setupSync(saved).catch(console.error);
    }
  },

  setupSync: async (syncId: string) => {
    storage.saveSyncId(syncId);
    set({ syncId });

    // Subscribe to remote changes before initial pull so we don't miss anything.
    if (realtimeUnsub) realtimeUnsub();
    realtimeUnsub = subscribeSync(syncId, () => {
      get().triggerSync().catch(console.error);
    });

    await get().triggerSync();
  },

  disconnectSync: () => {
    storage.saveSyncId(null);
    set({ syncId: null, cloudStatus: "idle", lastSyncAt: null });
    if (realtimeUnsub) {
      realtimeUnsub();
      realtimeUnsub = null;
    }
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
  },

  triggerSync: async () => {
    const { syncId } = get();
    if (!syncId || !syncEnabled) return;

    set({ cloudStatus: "syncing" });
    try {
      const expStore = useExpenseStore.getState();
      const local = expStore.exportBackup();
      const remote = await pullSync(syncId);

      const merged = remote ? mergeBackups(local, remote) : local;

      // Apply merged data without triggering another sync push.
      syncApplying.value = true;
      expStore.applySync(merged);
      syncApplying.value = false;

      await pushSync(syncId, merged);
      set({ cloudStatus: "synced", lastSyncAt: Date.now() });
    } catch (err) {
      syncApplying.value = false;
      console.error("[sync] triggerSync failed", err);
      set({ cloudStatus: "error" });
    }
  },

  scheduleSyncPush: () => {
    if (!get().syncId || !syncEnabled) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      get().triggerSync().catch(console.error);
    }, 3000);
  },
}));
