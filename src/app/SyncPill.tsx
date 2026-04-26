import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Loader2, WifiOff, AlertCircle } from "lucide-react";
import clsx from "clsx";
import { useExpenseStore } from "../stores/useExpenseStore";

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
  const status = useExpenseStore((s) => s.syncStatus);
  const lastSavedAt = useExpenseStore((s) => s.lastSavedAt);
  const isOffline = useExpenseStore((s) => s.isOffline);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);

  let tone = "text-[var(--text-tertiary)] border-white/[0.06]";
  let Icon = Check;
  let label = "Synced";

  if (isOffline) {
    tone = "text-warning border-warning/30 bg-warning/10";
    Icon = WifiOff;
    label = "Offline";
  } else if (status === "saving") {
    tone = "text-accent border-accent/30 bg-accent/5";
    Icon = Loader2;
    label = "Saving…";
  } else if (status === "error") {
    tone = "text-negative border-negative/30 bg-negative/10";
    Icon = AlertCircle;
    label = "Save failed";
  } else if (status === "saved" && lastSavedAt) {
    tone = "text-positive border-positive/25 bg-positive/5";
    Icon = Check;
    label = `Saved · ${timeAgo(lastSavedAt)}`;
  }

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
        title={lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : undefined}
      >
        <Icon size={12} className={status === "saving" ? "animate-spin" : ""} />
        <span>{label}</span>
      </motion.div>
    </AnimatePresence>
  );
}
