import { useEffect, useState } from "react";
import { format } from "date-fns";
import { CalendarDays, ChevronDown } from "lucide-react";
import { Sheet } from "../../ui/Sheet";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { Pill } from "../../ui/Pill";
import { useExpenseStore } from "../../stores/useExpenseStore";
import { useToast } from "../../hooks/useToast";
import { useHaptic } from "../../hooks/useHaptic";
import { colorFromString } from "../../lib/analytics";
import { DatePicker } from "../../ui/DatePicker";

interface Props {
  open: boolean;
  onClose: () => void;
  prefill?: { itemName?: string; amount?: number; category?: string; date?: string };
}

export function AddExpenseSheet({ open, onClose, prefill }: Props) {
  const categories = useExpenseStore((s) => s.categories);
  const addExpense = useExpenseStore((s) => s.addExpense);
  const consumeUndo = useExpenseStore((s) => s.consumeUndo);
  const toast = useToast();
  const vibrate = useHaptic();

  const today = format(new Date(), "yyyy-MM-dd");

  const [form, setForm] = useState({
    itemName: prefill?.itemName ?? "",
    amount: prefill?.amount ? String(prefill.amount) : "",
    category: prefill?.category ?? "",
    date: prefill?.date ?? today,
    notes: "",
  });
  const [errors, setErrors] = useState<Partial<typeof form>>({});

  // Sync form when sheet opens (handles prefill from SmartInput re-opens)
  useEffect(() => {
    if (open) {
      setForm({
        itemName: prefill?.itemName ?? "",
        amount: prefill?.amount ? String(prefill.amount) : "",
        category: prefill?.category ?? "",
        date: prefill?.date ?? today,
        notes: "",
      });
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const validate = () => {
    const e: Partial<typeof form> = {};
    if (!form.itemName.trim()) e.itemName = "Required";
    const a = parseFloat(form.amount);
    if (!Number.isFinite(a) || a <= 0) e.amount = "Enter a valid amount";
    return e;
  };

  const submit = () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    const created = addExpense({
      itemName: form.itemName.trim(),
      amount: parseFloat(form.amount),
      category: form.category || undefined,
      date: new Date(form.date + "T12:00:00").toISOString(),
      notes: form.notes.trim() || undefined,
    });
    vibrate(10);
    const isBackdated = form.date !== today;
    toast.success(
      `${isBackdated ? `Added for ${format(new Date(form.date), "MMM d")} · ` : ""}$${created.amount.toFixed(2)} — ${created.itemName}`,
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
    setForm({ itemName: "", amount: "", category: "", date: today, notes: "" });
    onClose();
  };

  const isBackdated = form.date && form.date !== today;

  const presets = [
    { id: "today", label: "Today", val: today },
    { id: "yesterday", label: "Yesterday", val: format(new Date(Date.now() - 864e5), "yyyy-MM-dd") },
    { id: "-2", label: "2d ago", val: format(new Date(Date.now() - 2 * 864e5), "yyyy-MM-dd") },
    { id: "-3", label: "3d ago", val: format(new Date(Date.now() - 3 * 864e5), "yyyy-MM-dd") },
  ];
  const isPreset = presets.some((p) => p.val === form.date);
  const isCustomActive = !isPreset;

  return (
    <Sheet open={open} onClose={onClose} title="Add expense" side="bottom">
      <div className="flex flex-col gap-3 px-4 pb-6 pt-2">
        {/* Date selector */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-0.5">
          {presets.map((p) => (
            <button
              key={p.id}
              onClick={() => set("date", p.val)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition ${
                form.date === p.val
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-white/[0.08] text-[var(--text-secondary)] hover:border-white/20 hover:text-white"
              }`}
            >
              {p.label}
            </button>
          ))}
          <DatePicker
            variant="pill"
            value={isCustomActive ? form.date : ""}
            onChange={(v) => { set("date", v || today); }}
            max={today}
            placeholder="Pick date"
            active={isCustomActive}
          />
        </div>

        {isBackdated && (
          <div className="flex items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-[12px] text-accent">
            <CalendarDays size={12} />
            Logging for {format(new Date(form.date + "T12:00:00"), "EEEE, MMMM d")}
          </div>
        )}

        <Input
          label="What"
          placeholder="e.g. Coffee, Grab, Spotify"
          value={form.itemName}
          onChange={(e) => set("itemName", e.target.value)}
          error={errors.itemName}
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <Input
          label="Amount"
          type="number"
          inputMode="decimal"
          prefix="$"
          mono
          placeholder="0.00"
          value={form.amount}
          onChange={(e) => set("amount", e.target.value)}
          error={errors.amount}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">Category</label>
          <div className="flex flex-wrap gap-1.5">
            {categories.slice(0, 8).map((c) => (
              <button
                key={c}
                onClick={() => set("category", form.category === c ? "" : c)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium transition ${
                  form.category === c
                    ? "border-transparent text-surface-0"
                    : "border-white/[0.08] text-[var(--text-secondary)] hover:text-white"
                }`}
                style={form.category === c ? { background: colorFromString(c) } : undefined}
              >
                {c}
              </button>
            ))}
            {categories.length > 8 && (
              <div className="relative">
                <select
                  value={form.category}
                  onChange={(e) => set("category", e.target.value)}
                  className="h-[30px] rounded-full border border-white/[0.08] bg-surface-2 pl-2.5 pr-6 text-[12px] text-[var(--text-secondary)] outline-none appearance-none"
                >
                  <option value="">More…</option>
                  {categories.slice(8).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" />
              </div>
            )}
          </div>
        </div>

        <Input
          label="Notes (optional)"
          placeholder="Any extra detail"
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
        />

        <div className="flex gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={submit} className="flex-1">
            Add{isBackdated ? ` for ${format(new Date(form.date + "T12:00:00"), "MMM d")}` : ""}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
