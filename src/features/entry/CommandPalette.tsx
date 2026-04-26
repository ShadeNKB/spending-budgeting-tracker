import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Search, Activity, ListOrdered, LineChart, Settings2, Plus, Download, Sparkles, PenLine } from "lucide-react";
import clsx from "clsx";
import Fuse from "fuse.js";
import { useUIStore } from "../../stores/useUIStore";
import { useExpenseStore } from "../../stores/useExpenseStore";
import { SmartInput } from "./SmartInput";
import { formatMoney } from "../../lib/format";
import { format as fmtDate, parseISO } from "date-fns";
import { parseExpense } from "../../utils/parseExpense";
import { useToast } from "../../hooks/useToast";
import { useHaptic } from "../../hooks/useHaptic";

type Action = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  onRun: () => void;
};

export function CommandPalette() {
  const open = useUIStore((s) => s.paletteOpen);
  const setOpen = useUIStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen);
  const navigate = useNavigate();
  const expenses = useExpenseStore((s) => s.expenses);
  const categoryMappings = useExpenseStore((s) => s.categoryMappings);
  const addExpense = useExpenseStore((s) => s.addExpense);
  const exportBackup = useExpenseStore((s) => s.exportBackup);
  const toast = useToast();
  const vibrate = useHaptic();

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const parsedQuery = useMemo(() => parseExpense(query, categoryMappings), [query, categoryMappings]);
  const canQuickAdd = Boolean(parsedQuery.itemName && parsedQuery.amount && parsedQuery.amount > 0);

  const quickAddAction: Action | null = useMemo(() => {
    if (!canQuickAdd) return null;

    return {
      id: "quick-add-query",
      label: `Add "${parsedQuery.itemName}" - $${parsedQuery.amount!.toFixed(2)}`,
      hint: "Enter",
      icon: Plus,
      onRun: () => {
        const created = addExpense({
          itemName: parsedQuery.itemName,
          amount: parsedQuery.amount!,
          category: parsedQuery.suggestedCategory,
          date: parsedQuery.parsedDate
            ? new Date(parsedQuery.parsedDate + "T12:00:00").toISOString()
            : undefined,
        });
        vibrate(10);
        toast.success(`Added "${created.itemName}" - $${created.amount.toFixed(2)}`);
        setQuery("");
      },
    };
  }, [addExpense, canQuickAdd, parsedQuery, toast, vibrate]);

  const actions: Action[] = useMemo(
    () => [
      { id: "add-expense", label: "Add expense", hint: "Ctrl+N", icon: PenLine, onRun: () => setAddSheetOpen(true) },
      { id: "nav-pulse", label: "Go to Pulse", icon: Activity, onRun: () => navigate("/pulse") },
      { id: "nav-ledger", label: "Go to Ledger", icon: ListOrdered, onRun: () => navigate("/ledger") },
      { id: "nav-insights", label: "Go to Insights", icon: LineChart, onRun: () => navigate("/insights") },
      { id: "settings", label: "Open Settings", icon: Settings2, onRun: () => setSettingsOpen(true) },
      {
        id: "export",
        label: "Export backup (JSON)",
        icon: Download,
        onRun: () => {
          const data = exportBackup();
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `spendtrack-backup-${fmtDate(new Date(), "yyyy-MM-dd")}.json`;
          a.click();
          URL.revokeObjectURL(url);
        },
      },
    ],
    [navigate, setSettingsOpen, setAddSheetOpen, exportBackup]
  );

  const expenseHits = useMemo(() => {
    if (!query || query.length < 2) return [];
    const fuse = new Fuse(expenses, {
      keys: ["itemName", "category", "notes"],
      threshold: 0.35,
      includeScore: true,
    });
    return fuse.search(query).slice(0, 6).map((r) => r.item);
  }, [expenses, query]);

  const filteredActions = useMemo(() => {
    if (quickAddAction) return [quickAddAction, ...actions];
    if (!query) return actions;
    const q = query.toLowerCase();
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query, quickAddAction]);

  const totalItems = filteredActions.length + expenseHits.length;

  const runAt = (idx: number) => {
    if (idx < filteredActions.length) {
      filteredActions[idx].onRun();
    } else {
      const exp = expenseHits[idx - filteredActions.length];
      if (exp) {
        const date = fmtDate(parseISO(exp.date), "yyyy-MM-dd");
        navigate(`/ledger?date=${date}&q=${encodeURIComponent(exp.itemName)}`);
      }
    }
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(totalItems - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (totalItems > 0) runAt(activeIdx);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={() => setOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: -16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
            className="fixed inset-x-4 top-[12vh] z-[91] mx-auto max-w-[560px] overflow-hidden rounded-2xl border border-white/[0.08] bg-surface-1 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
            onKeyDown={onKey}
          >
            <div className="p-3 border-b border-white/[0.06]">
              <SmartInput autoFocus onCommit={() => setOpen(false)} className="!bg-surface-2" />
            </div>

            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
              <Search size={14} className="text-[var(--text-tertiary)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIdx(0);
                }}
                placeholder="Search actions, expenses, or quick-add..."
                className="flex-1 bg-transparent text-sm text-white placeholder:text-[var(--text-tertiary)] outline-none"
              />
              <kbd className="rounded bg-surface-2 border border-white/[0.06] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">ESC</kbd>
            </div>

            <div className="max-h-[50vh] overflow-y-auto py-1">
              {filteredActions.length > 0 && (
                <div>
                  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                    Actions
                  </div>
                  {filteredActions.map((a, i) => {
                    const Icon = a.icon;
                    const active = i === activeIdx;
                    return (
                      <button
                        key={a.id}
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => runAt(i)}
                        className={clsx(
                          "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition",
                          active ? "bg-surface-2 text-white" : "text-[var(--text-secondary)]"
                        )}
                      >
                        <Icon size={15} className={active ? "text-accent" : ""} />
                        <span className="flex-1">{a.label}</span>
                        {a.hint && <kbd className="rounded bg-surface-3 border border-white/[0.06] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">{a.hint}</kbd>}
                      </button>
                    );
                  })}
                </div>
              )}

              {expenseHits.length > 0 && (
                <div className="mt-1">
                  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                    Expenses
                  </div>
                  {expenseHits.map((e, i) => {
                    const idx = filteredActions.length + i;
                    const active = idx === activeIdx;
                    return (
                      <button
                        key={e.id}
                        onMouseEnter={() => setActiveIdx(idx)}
                        onClick={() => runAt(idx)}
                        className={clsx(
                          "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition",
                          active ? "bg-surface-2" : ""
                        )}
                      >
                        <Sparkles size={14} className="text-[var(--text-tertiary)]" />
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-white">{e.itemName}</div>
                          <div className="text-[11px] text-[var(--text-tertiary)]">
                            {e.category} / {fmtDate(parseISO(e.date), "MMM d")}
                          </div>
                        </div>
                        <span className="font-mono text-[13px] tabular-nums text-white">
                          {formatMoney(e.amount)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {totalItems === 0 && (
                <div className="px-4 py-8 text-center text-sm text-[var(--text-tertiary)]">
                  No matches - try an action or expense like <span className="text-white">coffee 4.50</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-2 text-[11px] text-[var(--text-tertiary)]">
              <span className="inline-flex items-center gap-1.5">
                <Plus size={11} /> Type to add fast
              </span>
              <span className="inline-flex items-center gap-2">
                <kbd className="rounded bg-surface-2 border border-white/[0.06] px-1.5 py-0.5 text-[10px]">Enter</kbd>
                run
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
