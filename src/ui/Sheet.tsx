import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function Sheet({
  open,
  onClose,
  children,
  title,
  side = "right",
  width = 420,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  side?: "right" | "bottom";
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const isBottom = side === "bottom";

  // Portal to document.body so backdrop-filter ancestors (e.g. TopBar's
  // backdrop-blur) don't create a new containing block for position:fixed.
  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-[96] bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            key="panel"
            className={
              "fixed z-[97] bg-surface-1 border-white/[0.07] shadow-[0_40px_80px_-20px_rgba(0,0,0,0.7)] overflow-hidden flex flex-col " +
              (isBottom
                ? "left-0 right-0 bottom-0 border-t rounded-t-2xl max-h-[85dvh]"
                : "top-0 bottom-0 right-0 border-l")
            }
            style={!isBottom ? { width: `min(${width}px, 96vw)` } : undefined}
            initial={isBottom ? { y: "100%" } : { x: "100%" }}
            animate={isBottom ? { y: 0 } : { x: 0 }}
            exit={isBottom ? { y: "100%" } : { x: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 40 }}
          >
            {isBottom && (
              <div className="flex justify-center pt-3 pb-1 shrink-0">
                <div className="h-1 w-10 rounded-full bg-white/20" />
              </div>
            )}
            {title !== undefined && (
              <header className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06] shrink-0">
                <h2 className="text-[15px] font-semibold text-white">{title}</h2>
                <button
                  onClick={onClose}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-surface-2 hover:text-white transition"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </header>
            )}
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
