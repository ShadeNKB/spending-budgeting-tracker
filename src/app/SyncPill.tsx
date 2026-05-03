import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Loader2, WifiOff, AlertCircle, Cloud, CloudOff } from "lucide-react";
import clsx from "clsx";
import { useExpenseStore } from "../stores/useExpenseStore";
import { useSyncStore } from "../stores/useSyncStore";
import { syncEnabled } from "../services/syncService";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function SyncPill() {
  const localStatus = useExpenseStore((s) => s.syncStatus);
  const lastSavedAt = useExpenseStore((s) => s.lastSavedAt);
  const isOffline = useExpenseStore((s) => s.isOffline);

  const syncId = useSyncStore((s) => s.syncId);
  const cloudStatus = useSyncStore((s) => s.cloudStatus);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);

  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  const cloudActive = syncEnabled && !!syncId;

  let tone = "text-[var(--text-tertiary)] border-white/[0.06]";
  let Icon = Check;
  let label = "Saved";
  let title: string | undefined;

  if (isOffline) {
    tone = "text-warning border-warning/30 bg-warning/10";
    Icon = WifiOff;
    label = "Offline";
  } else if (cloudActive) {
    if (cloudStatus === "syncing" || localStatus === "saving") {
      tone = "text-accent border-accent/30 bg-accent/5";
      Icon = Loader2;
      label = "Syncing…";
    } else if (cloudStatus === "error") {
      tone = "text-negative border-negative/30 bg-negative/10";
      Icon = CloudOff;
      label = "Sync failed";
      title = "Changes saved locally — will retry when connected";
    } else if (cloudStatus === "synced" && lastSyncAt) {
      tone = "text-positive border-positive/25 bg-positive/5";
      Icon = Cloud;
      label = `Synced · ${timeAgo(lastSyncAt)}`;
      title = new Date(lastSyncAt).toLocaleTimeString();
    } else {
      tone = "text-[var(--text-tertiary)] border-white/[0.06]";
      Icon = Cloud;
      label = "Sync ready";
    }
  } else if (localStatus === "saving") {
    tone = "text-accent border-accent/30 bg-accent/5";
    Icon = Loader2;
    label = "Saving…";
  } else if (localStatus === "error") {
    tone = "text-negative border-negative/30 bg-negative/10";
    Icon = AlertCircle;
    label = "Save failed";
  } else if (localStatus === "saved" && lastSavedAt) {
    tone = "text-positive border-positive/25 bg-positive/5";
    Icon = Check;
    label = `Saved · ${timeAgo(lastSavedAt)}`;
    title = new Date(lastSavedAt).toLocaleTimeString();
  }

  const spinning = Icon === Loader2;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={label + tick}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.15 }}
        className={clsx(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
          tone
        )}
        title={title}
      >
        <Icon size={12} className={spinning ? "animate-spin" : ""} />
        <span>{label}</span>
      </motion.div>
    </AnimatePresence>
  );
}
