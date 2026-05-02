import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import { Trash2 } from "lucide-react";
import { Sheet } from "../../ui/Sheet";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { useExpenseStore } from "../../stores/useExpenseStore";
import { useToast } from "../../hooks/useToast";
import { colorFromString } from "../../lib/analytics";
import { DatePicker } from "../../ui/DatePicker";
import type { Expense } from "../../types";

export function EditExpenseSheet({
  expense,
  onClose,
}: {
  expense: Expense | null;
  onClose: () => void;
}) {
  const updateExpense = useExpenseStore((s) => s.updateExpense);
  const deleteExpense = useExpenseStore((s) => s.deleteExpense);
  const categories = useExpenseStore((s) => s.categories);
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [form, setForm] = useState<{ itemName: string; amount: string; category: string; date: string; notes: string }>({
    itemName: "",
    amount: "",
    category: "Other",
    date: format(new Date(), "yyyy-MM-dd"),
    notes: "",
  });

  useEffect(() => {
    if (expense) {
      setForm({
        itemName: expense.itemName,
        amount: expense.amount.toString(),
        category: expense.category,
        date: format(parseISO(expense.date), "yyyy-MM-dd"),
        notes: expense.notes ?? "",
      });
    }
  }, [expense]);

  const save = () => {
    if (!expense) return;
    const amount = parseFloat(form.amount);
    if (!form.itemName.trim() || !Number.isFinite(amount) || amount <= 0) {
      toast.error("Item name and a valid amount are required");
      return;
    }
    updateExpense(expense.id, {
      itemName: form.itemName.trim(),
      amount,
      category: form.category,
      date: new Date(form.date + "T12:00:00").toISOString(),
      notes: form.notes.trim() || undefined,
    });
    toast.success("Expense updated");
    onClose();
  };

  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  return (
    <Sheet
      open={!!expense}
      onClose={onClose}
      title="Edit expense"
      side={isMobile ? "bottom" : "right"}
      width={420}
    >
      <div className="flex flex-col gap-4 p-5">
        <Input
          label="Item"
          value={form.itemName}
          onChange={(e) => setForm({ ...form, itemName: e.target.value })}
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <Input
          label="Amount"
          type="number"
          inputMode="decimal"
          prefix="$"
          mono
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">Category</label>
          <div className="flex flex-wrap gap-1.5">
            {categories.slice(0, 8).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setForm({ ...form, category: form.category === c ? "Other" : c })}
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
              <select
                value={categories.slice(8).includes(form.category) ? form.category : ""}
                onChange={(e) => { if (e.target.value) setForm({ ...form, category: e.target.value }); }}
                className="h-[30px] rounded-full border border-white/[0.08] bg-surface-2 pl-2.5 pr-6 text-[12px] text-[var(--text-secondary)] outline-none appearance-none"
              >
                <option value="">More…</option>
                {categories.slice(8).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Date selector — presets + custom picker */}
        {(() => {
          const todayStr = format(new Date(), "yyyy-MM-dd");
          const editPresets = [
            { label: "Today", val: todayStr },
            { label: "Yesterday", val: format(new Date(Date.now() - 864e5), "yyyy-MM-dd") },
            { label: "2d ago", val: format(new Date(Date.now() - 2 * 864e5), "yyyy-MM-dd") },
            { label: "3d ago", val: format(new Date(Date.now() - 3 * 864e5), "yyyy-MM-dd") },
          ];
          const editIsPreset = editPresets.some((p) => p.val === form.date);
          return (
            <div className="flex flex-col gap-2">
              <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">Date</label>
              <div className="flex gap-2 flex-wrap items-center">
                {editPresets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setForm({ ...form, date: p.val })}
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
                  value={editIsPreset ? "" : form.date}
                  onChange={(v) => { setForm({ ...form, date: v || format(new Date(), "yyyy-MM-dd") }); }}
                  max={todayStr}
                  placeholder="Pick date"
                  active={!editIsPreset}
                />
              </div>
            </div>
          );
        })()}

        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Any extra detail"
            rows={2}
            className="rounded-[10px] border border-white/[0.06] bg-surface-2 px-3 py-2.5 text-[14px] text-white placeholder:text-[var(--text-tertiary)] outline-none focus:border-accent/60 resize-none [color-scheme:dark]"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={save} className="flex-1">Save changes</Button>
        </div>

        <div className="border-t border-white/[0.06] pt-3">
          {confirmDelete ? (
            <div className="rounded-lg border border-negative/30 bg-negative/[0.07] p-3 flex flex-col gap-2">
              <div className="text-[12px] text-[var(--text-tertiary)]">Delete this expense? This cannot be undone.</div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    if (!expense) return;
                    deleteExpense(expense.id);
                    toast.info(`Deleted "${expense.itemName}"`);
                    onClose();
                  }}
                  variant="primary"
                  className="flex-1 !bg-negative/80 hover:!bg-negative border-transparent"
                >
                  Delete
                </Button>
                <Button onClick={() => setConfirmDelete(false)} variant="ghost" className="flex-1">Cancel</Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full flex items-center justify-center gap-1.5 rounded-[10px] border border-white/[0.06] py-2.5 text-[12px] text-[var(--text-tertiary)] hover:border-negative/30 hover:bg-negative/10 hover:text-negative transition"
            >
              <Trash2 size={13} /> Delete expense
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
