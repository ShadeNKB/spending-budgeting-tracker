import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from "lucide-react";
import clsx from "clsx";
import { useUIStore, type Toast } from "../stores/useUIStore";

const iconFor = (k: Toast["kind"]) =>
  k === "success" ? CheckCircle2 : k === "error" ? XCircle : k === "warning" ? AlertTriangle : Info;

const toneClass: Record<Toast["kind"], string> = {
  success: "border-positive/30 bg-positive/5 text-positive",
  error: "border-negative/30 bg-negative/5 text-negative",
  warning: "border-warning/30 bg-warning/5 text-warning",
  info: "border-accent/30 bg-accent/5 text-accent",
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useUIStore((s) => s.dismissToast);
  const duration = toast.duration ?? 4000;

  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), duration);
    return () => clearTimeout(t);
  }, [toast.id, dismiss, duration]);

  const Icon = iconFor(toast.kind);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className={clsx(
        "pointer-events-auto flex items-start gap-3 overflow-hidden rounded-xl border bg-surface-1/95 backdrop-blur-md px-4 py-3 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.6)] min-w-[280px] max-w-[380px]",
        toneClass[toast.kind]
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="flex-1 text-sm text-white">{toast.message}</div>
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick();
            dismiss(toast.id);
          }}
          className="text-xs font-semibold text-accent hover:text-accent-hover transition shrink-0"
        >
          {toast.action.label}
        </button>
      )}
      <button
        aria-label="Dismiss"
        onClick={() => dismiss(toast.id)}
        className="text-[var(--text-tertiary)] hover:text-white transition shrink-0"
      >
        <X size={14} />
      </button>
      <motion.div
        initial={{ scaleX: 1 }}
        animate={{ scaleX: 0 }}
        transition={{ duration: duration / 1000, ease: "linear" }}
        style={{ transformOrigin: "left" }}
        className="absolute bottom-0 left-0 right-0 h-[2px] bg-current opacity-40"
      />
    </motion.div>
  );
}

export function ToastHost() {
  const toasts = useUIStore((s) => s.toasts);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed z-[100] flex flex-col-reverse gap-2 bottom-[calc(env(safe-area-inset-bottom,0px)+88px)] right-4 left-4 sm:left-auto sm:bottom-6 sm:right-6 sm:max-w-sm"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
