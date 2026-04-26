import { useRef, useState } from "react";
import { format } from "date-fns";
import { Plus, Trash2, Download, Upload, FileDown, Wallet, Tags, Database, Check, X } from "lucide-react";
import { Sheet } from "../../ui/Sheet";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Pill } from "../../ui/Pill";
import { useUIStore } from "../../stores/useUIStore";
import { useExpenseStore } from "../../stores/useExpenseStore";
import { useToast } from "../../hooks/useToast";
import { formatMoney } from "../../lib/format";
import { colorFromString } from "../../lib/analytics";
import type { BackupData } from "../../types";

type Tab = "categories" | "budgets" | "backup";

export function SettingsDrawer() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<Tab>("categories");

  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="Settings" side="right" width={460}>
      <div className="px-5 pt-4 pb-2">
        <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-surface-1 p-1 w-full">
          {([
            ["categories", Tags, "Categories"],
            ["budgets", Wallet, "Budgets"],
            ["backup", Database, "Backup"],
          ] as const).map(([key, Icon, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={
                "flex-1 inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition " +
                (tab === key
                  ? "bg-white text-surface-0"
                  : "text-[var(--text-secondary)] hover:text-white")
              }
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {tab === "categories" && <CategoriesPanel />}
        {tab === "budgets" && <BudgetsPanel />}
        {tab === "backup" && <BackupPanel />}
      </div>
    </Sheet>
  );
}

function CategoriesPanel() {
  const categories = useExpenseStore((s) => s.categories);
  const expenses = useExpenseStore((s) => s.expenses);
  const add = useExpenseStore((s) => s.addCategory);
  const rename = useExpenseStore((s) => s.renameCategory);
  const remove = useExpenseStore((s) => s.removeCategory);
  const toast = useToast();
  const [newCat, setNewCat] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const counts = categories.reduce<Record<string, number>>((acc, c) => {
    acc[c] = expenses.filter((e) => e.category === c).length;
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label="Add category"
            placeholder="e.g. Gifts"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newCat.trim()) {
                add(newCat.trim());
                setNewCat("");
                toast.success("Category added");
              }
            }}
          />
        </div>
        <Button
          onClick={() => {
            if (newCat.trim()) {
              add(newCat.trim());
              setNewCat("");
              toast.success("Category added");
            }
          }}
        >
          <Plus size={14} /> Add
        </Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {categories.map((c) => (
          <li key={c} className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorFromString(c) }} />
            <input
              defaultValue={c}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== c) {
                  rename(c, v);
                  toast.success("Renamed");
                }
              }}
              className="flex-1 min-w-0 bg-transparent text-[13px] text-white outline-none"
            />
            <Pill tone="default">{counts[c] ?? 0}</Pill>
            {confirmDelete === c ? (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => {
                    remove(c);
                    setConfirmDelete(null);
                    toast.info("Category deleted");
                  }}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md bg-negative/10 text-negative hover:bg-negative/20 transition"
                  title="Confirm delete"
                >
                  <Check size={13} />
                </button>
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-surface-2 transition"
                  title="Cancel"
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(c)}
                className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-negative/10 hover:text-negative transition"
                title="Delete category"
              >
                <Trash2 size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BudgetsPanel() {
  const categories = useExpenseStore((s) => s.categories);
  const budgets = useExpenseStore((s) => s.budgets);
  const setBudget = useExpenseStore((s) => s.setBudget);
  const removeBudget = useExpenseStore((s) => s.removeBudget);
  const toast = useToast();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[var(--text-tertiary)]">
        Set a monthly cap for categories you want to track against.
      </p>
      <ul className="flex flex-col gap-1.5">
        {categories.map((c) => {
          const current = budgets[c];
          return (
            <li key={c} className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-2">
              <span className="h-2 w-2 rounded-full" style={{ background: colorFromString(c) }} />
              <span className="flex-1 text-[13px] text-white">{c}</span>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[var(--text-tertiary)]">$</span>
                <input
                  key={`${c}-${current ?? "none"}`}
                  type="number"
                  inputMode="decimal"
                  defaultValue={current ?? ""}
                  placeholder="—"
                  className="h-8 w-24 rounded-md border border-white/[0.06] bg-surface-2 px-2 text-right font-mono text-[13px] text-white outline-none focus:border-accent/60 tabular-nums [color-scheme:dark]"
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (Number.isFinite(v) && v > 0) {
                      setBudget(c, v);
                      toast.success(`${c}: ${formatMoney(v)} budget set`);
                    } else if (e.target.value === "" && current != null) {
                      removeBudget(c);
                      toast.info(`Budget cleared`);
                    }
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BackupPanel() {
  const expenses = useExpenseStore((s) => s.expenses);
  const exportBackup = useExpenseStore((s) => s.exportBackup);
  const importBackup = useExpenseStore((s) => s.importBackup);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [pendingImport, setPendingImport] = useState<{ data: BackupData; count: number } | null>(null);

  const exportJson = () => {
    const data = exportBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spendtrack-backup-${format(new Date(), "yyyy-MM-dd")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Backup downloaded");
  };

  const exportCsv = () => {
    const headers = ["Date", "Item", "Category", "Amount", "Notes"];
    const rows = expenses.map((e) =>
      [format(new Date(e.date), "yyyy-MM-dd"), `"${e.itemName}"`, e.category, e.amount, `"${e.notes ?? ""}"`].join(",")
    );
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spendtrack-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV exported");
  };

  const onFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target!.result as string) as BackupData;
        if (!data.expenses || !Array.isArray(data.expenses)) throw new Error();
        setPendingImport({ data, count: data.expenses.length });
      } catch {
        toast.error("Invalid backup file");
      }
    };
    reader.readAsText(f);
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    importBackup(pendingImport.data);
    toast.success(`Imported ${pendingImport.count} expenses`);
    setPendingImport(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4">
        <div className="text-[13px] font-semibold text-white">{expenses.length} expenses</div>
        <div className="text-[12px] text-[var(--text-tertiary)]">All data is stored locally in this browser.</div>
      </div>

      {pendingImport && (
        <div className="rounded-lg border border-warning/30 bg-warning/[0.07] p-4 flex flex-col gap-3">
          <div>
            <div className="text-[13px] font-semibold text-white">Import {pendingImport.count} expenses?</div>
            <div className="text-[12px] text-[var(--text-tertiary)] mt-0.5">This will replace all current data. This cannot be undone.</div>
          </div>
          <div className="flex gap-2">
            <Button onClick={confirmImport} variant="primary" className="flex-1">Confirm import</Button>
            <Button onClick={() => setPendingImport(null)} variant="ghost" className="flex-1">Cancel</Button>
          </div>
        </div>
      )}

      <Button onClick={exportJson} variant="primary">
        <Download size={14} /> Download JSON backup
      </Button>
      <Button onClick={exportCsv} variant="ghost">
        <FileDown size={14} /> Export to CSV
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <Button onClick={() => fileRef.current?.click()} variant="ghost">
        <Upload size={14} /> Import JSON backup
      </Button>
    </div>
  );
}
