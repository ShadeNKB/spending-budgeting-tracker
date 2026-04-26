import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, CornerDownLeft, X, CalendarDays, PenLine } from "lucide-react";
import { format } from "date-fns";
import clsx from "clsx";
import { parseExpense } from "../../utils/parseExpense";
import { useExpenseStore } from "../../stores/useExpenseStore";
import { useToast } from "../../hooks/useToast";
import { useHaptic } from "../../hooks/useHaptic";
import { Pill } from "../../ui/Pill";
import { colorFromString } from "../../lib/analytics";
import { AddExpenseSheet } from "./AddExpenseSheet";

export function SmartInput({
  autoFocus,
  onCommit,
  placeholder = "e.g. coffee 4.50  ·  grab 12 yesterday",
  className,
  dense,
}: {
  autoFocus?: boolean;
  onCommit?: () => void;
  placeholder?: string;
  className?: string;
  dense?: boolean;
}) {
  const [value, setValue] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addExpense = useExpenseStore((s) => s.addExpense);
  const categoryMappings = useExpenseStore((s) => s.categoryMappings);
  const consumeUndo = useExpenseStore((s) => s.consumeUndo);
  const toast = useToast();
  const vibrate = useHaptic();

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const parsed = useMemo(() => parseExpense(value, categoryMappings), [value, categoryMappings]);
  const canCommit = Boolean(parsed.itemName && parsed.amount && parsed.amount > 0);

  const today = format(new Date(), "yyyy-MM-dd");
  const parsedDateLabel = parsed.parsedDate && parsed.parsedDate !== today
    ? format(new Date(parsed.parsedDate + "T12:00:00"), "MMM d")
    : null;

  const commit = () => {
    if (!canCommit) return;
    const created = addExpense({
      itemName: parsed.itemName,
      amount: parsed.amount!,
      category: parsed.suggestedCategory,
      date: parsed.parsedDate ? new Date(parsed.parsedDate + "T12:00:00").toISOString() : undefined,
    });
    vibrate(10);
    toast.success(
      `${parsedDateLabel ? `${parsedDateLabel} · ` : ""}Added "${created.itemName}" · $${created.amount.toFixed(2)}`,
      {
        action: {
          label: "Undo",
          onClick: () => {
            const entry = useExpenseStore.getState().undoStack.find((u) => u.id === `add-${created.id}`);
            if (entry) consumeUndo(entry.id);
          },
        },
      }
    );
    setTimeout(() => {
      const entry = useExpenseStore.getState().undoStack.find((u) => u.id === `add-${created.id}`);
      if (entry) useExpenseStore.getState().clearUndo(entry.id);
    }, 6000);
    setValue("");
    onCommit?.();
  };

  return (
    <>
      <div
        className={clsx(
          "relative flex flex-col gap-2 rounded-2xl border border-white/[0.07] bg-surface-1/85 backdrop-blur-md px-3 py-2.5 transition",
          "focus-within:border-accent/40 focus-within:shadow-[0_0_0_4px_rgba(34,211,238,0.1)]",
          className
        )}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-accent/80 shrink-0" />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              else if (e.key === "Escape") { setValue(""); inputRef.current?.blur(); }
            }}
            placeholder={placeholder}
            className={clsx(
              "flex-1 min-w-0 bg-transparent text-white placeholder:text-[var(--text-tertiary)] outline-none",
              dense ? "text-[14px]" : "text-[15px]"
            )}
            aria-label="Quick add expense"
          />

          {value && (
            <button onClick={() => setValue("")} className="text-[var(--text-tertiary)] hover:text-white transition shrink-0">
              <X size={14} />
            </button>
          )}

          <button
            onClick={() => setSheetOpen(true)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-surface-2 hover:text-white transition shrink-0"
            aria-label="Full entry form"
            title="Full entry (with date picker)"
          >
            <PenLine size={13} />
          </button>

          <button
            onClick={commit}
            disabled={!canCommit}
            className={clsx(
              "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-semibold transition shrink-0",
              canCommit
                ? "bg-accent text-surface-0 hover:bg-accent-hover"
                : "bg-surface-2 text-[var(--text-tertiary)] cursor-not-allowed"
            )}
          >
            Add <CornerDownLeft size={12} />
          </button>
        </div>

        {value && (
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            {parsed.itemName && (
              <Pill tone="default">
                <span className="truncate max-w-[140px]">{parsed.itemName}</span>
              </Pill>
            )}
            {parsed.amount != null && parsed.amount > 0 ? (
              <Pill tone="accent">${parsed.amount.toFixed(2)}</Pill>
            ) : (
              <Pill tone="warning">add amount</Pill>
            )}
            {parsed.suggestedCategory && (
              <Pill tone="info">
                <span
                  className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: colorFromString(parsed.suggestedCategory) }}
                />
                {parsed.suggestedCategory}
              </Pill>
            )}
            {parsedDateLabel && (
              <Pill tone="default">
                <CalendarDays size={10} /> {parsedDateLabel}
              </Pill>
            )}
          </div>
        )}
      </div>

      <AddExpenseSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        prefill={
          parsed.itemName || parsed.amount
            ? {
                itemName: parsed.itemName,
                amount: parsed.amount ?? undefined,
                category: parsed.suggestedCategory,
                date: parsed.parsedDate ?? today,
              }
            : undefined
        }
      />
    </>
  );
}
