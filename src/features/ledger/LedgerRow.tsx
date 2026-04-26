import { motion, useMotionValue, useTransform, animate, PanInfo } from "framer-motion";
import { useRef, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { formatMoney } from "../../lib/format";
import { colorFromString } from "../../lib/analytics";
import type { Expense } from "../../types";

export function LedgerRow({
  expense,
  onEdit,
  onDelete,
}: {
  expense: Expense;
  onEdit: (e: Expense) => void;
  onDelete: (id: string) => void;
}) {
  const x = useMotionValue(0);
  const bg = useTransform(x, [-120, -40, 0], ["rgba(239,68,68,0.14)", "rgba(239,68,68,0.04)", "rgba(255,255,255,0)"]);
  const [swiping, setSwiping] = useState(false);
  const dragStarted = useRef(false);
  const pointerDownPos = useRef({ x: 0, y: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    setSwiping(false);
    dragStarted.current = true;
    if (info.offset.x < -70) {
      animate(x, -1000, { duration: 0.2, onComplete: () => onDelete(expense.id) });
    } else {
      animate(x, 0, { type: "spring", stiffness: 420, damping: 40 });
    }
    setTimeout(() => { dragStarted.current = false; }, 50);
  };

  const handleRowClick = () => {
    if (!dragStarted.current) onEdit(expense);
  };

  return (
    <motion.div
      style={{ background: bg }}
      className="relative group touch-pan-y"
      onPointerDown={(e) => {
        pointerDownPos.current = { x: e.clientX, y: e.clientY };
        dragStarted.current = false;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setSwiping(true), 100);
      }}
      onPointerUp={() => clearTimeout(timer.current)}
    >
      <motion.div
        className="absolute inset-y-0 right-0 flex items-center gap-1.5 pr-4 text-negative"
        style={{ opacity: useTransform(x, [-120, -20, 0], [1, 0.6, 0]) }}
      >
        <Trash2 size={13} />
        <span className="text-[11px] font-semibold uppercase tracking-wider">Delete</span>
      </motion.div>
      <motion.div
        drag={swiping ? "x" : false}
        dragConstraints={{ left: -160, right: 0 }}
        dragElastic={{ left: 0.2, right: 0 }}
        onDragStart={() => { dragStarted.current = true; }}
        onDragEnd={onDragEnd}
        style={{ x }}
        onClick={handleRowClick}
        className="relative flex items-center gap-3 bg-surface-1 px-3 py-3 md:px-4 cursor-pointer md:cursor-default active:md:cursor-default"
      >
        <span
          className="h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-[12px] font-bold"
          style={{
            background: `${colorFromString(expense.category)}1E`,
            color: colorFromString(expense.category),
            boxShadow: `0 0 0 1px ${colorFromString(expense.category)}30`,
          }}
          aria-hidden
        >
          {expense.itemName.charAt(0).toUpperCase()}
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] text-white">{expense.itemName}</div>
          <div className="text-[11px] text-[var(--text-tertiary)] truncate">
            {expense.category} · {format(parseISO(expense.date), "MMM d")}
            {expense.notes && <span className="ml-1 opacity-60">· {expense.notes}</span>}
          </div>
        </div>

        <span className="font-mono text-[14px] tabular-nums text-white shrink-0">
          {formatMoney(expense.amount)}
        </span>

        <div className="hidden md:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(expense); }}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-surface-2 hover:text-white transition"
            aria-label="Edit"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(expense.id); }}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-negative/10 hover:text-negative transition"
            aria-label="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
