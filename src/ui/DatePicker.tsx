import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  getDay,
  addMonths,
  subMonths,
  isSameDay,
  isAfter,
  isBefore,
  parseISO,
  startOfDay,
} from "date-fns";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

interface DatePickerProps {
  /** yyyy-MM-dd string */
  value: string;
  onChange: (val: string) => void;
  /** yyyy-MM-dd max date (inclusive) */
  max?: string;
  /** yyyy-MM-dd min date (inclusive) */
  min?: string;
  /** Render as a pill chip (for inline preset rows) or as a full input field */
  variant?: "pill" | "input";
  placeholder?: string;
  /** Extra classes on the trigger */
  className?: string;
  /** Highlight this trigger as active (pill variant) */
  active?: boolean;
}

interface PopoverPos {
  top: number;
  left: number;
  width: number;
  openAbove: boolean;
}

const CALENDAR_HEIGHT = 320; // approx height of the calendar popover
const CALENDAR_WIDTH = 248;

function calcPosition(trigger: HTMLElement, variant: "pill" | "input"): PopoverPos {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceBelow = vh - rect.bottom;
  const openAbove = spaceBelow < CALENDAR_HEIGHT + 8 && rect.top > CALENDAR_HEIGHT + 8;

  const top = openAbove ? rect.top - CALENDAR_HEIGHT - 6 : rect.bottom + 6;

  // For input variant, stretch to match trigger width; for pill, use fixed width
  const width = variant === "input" ? Math.max(rect.width, CALENDAR_WIDTH) : CALENDAR_WIDTH;

  // Align left to trigger, but clamp so it doesn't overflow right edge
  let left = rect.left;
  if (left + width > vw - 8) {
    left = vw - width - 8;
  }
  if (left < 8) left = 8;

  return { top, left, width, openAbove };
}

export function DatePicker({
  value,
  onChange,
  max,
  min,
  variant = "input",
  placeholder = "Pick date",
  className = "",
  active,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const [viewDate, setViewDate] = useState<Date>(() =>
    value ? new Date(value + "T12:00:00") : new Date()
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Sync view when value changes externally
  useEffect(() => {
    if (value) setViewDate(new Date(value + "T12:00:00"));
  }, [value]);

  // Recalculate position whenever open state changes
  useEffect(() => {
    if (open && triggerRef.current) {
      setPos(calcPosition(triggerRef.current, variant));
    } else {
      setPos(null);
    }
  }, [open, variant]);

  // Recalculate on scroll/resize while open
  useEffect(() => {
    if (!open) return;
    const recalc = () => {
      if (triggerRef.current) setPos(calcPosition(triggerRef.current, variant));
    };
    window.addEventListener("resize", recalc);
    window.addEventListener("scroll", recalc, true);
    return () => {
      window.removeEventListener("resize", recalc);
      window.removeEventListener("scroll", recalc, true);
    };
  }, [open, variant]);

  // Close on outside click/touch
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [open]);

  const maxDate = max ? startOfDay(parseISO(max)) : null;
  const minDate = min ? startOfDay(parseISO(min)) : null;
  const selectedDate = value ? new Date(value + "T12:00:00") : null;
  const today = new Date();

  const monthStart = startOfMonth(viewDate);
  const monthEnd = endOfMonth(viewDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const padStart = getDay(monthStart);

  const isDisabled = (d: Date) => {
    const day = startOfDay(d);
    if (maxDate && isAfter(day, maxDate)) return true;
    if (minDate && isBefore(day, minDate)) return true;
    return false;
  };

  const canGoNextMonth = !maxDate || !isAfter(startOfMonth(addMonths(viewDate, 1)), maxDate);

  const select = (d: Date) => {
    if (isDisabled(d)) return;
    onChange(format(d, "yyyy-MM-dd"));
    setOpen(false);
  };

  const displayStr = value
    ? format(new Date(value + "T12:00:00"), "MMM d, yyyy")
    : placeholder;

  const pillIsActive = active ?? (variant === "pill" && !!value);

  const calendar = pos
    ? createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[9999] rounded-[14px] border border-white/[0.1] bg-[#0f1117] shadow-2xl shadow-black/70 p-3 select-none"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-3 px-1">
            <button
              type="button"
              onClick={() => setViewDate((v) => subMonths(v, 1))}
              className="h-7 w-7 flex items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-white/[0.08] hover:text-white transition"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-[13px] font-semibold text-white tracking-tight">
              {format(viewDate, "MMMM yyyy")}
            </span>
            <button
              type="button"
              onClick={() => setViewDate((v) => addMonths(v, 1))}
              disabled={!canGoNextMonth}
              className="h-7 w-7 flex items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-white/[0.08] hover:text-white transition disabled:opacity-25 disabled:cursor-not-allowed"
            >
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Day-of-week headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAY_LABELS.map((d) => (
              <div key={d} className="text-center text-[10px] font-semibold text-[var(--text-tertiary)] py-1 uppercase tracking-wider">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-y-0.5">
            {Array.from({ length: padStart }).map((_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {days.map((d) => {
              const isSelected = selectedDate ? isSameDay(d, selectedDate) : false;
              const isToday = isSameDay(d, today);
              const disabled = isDisabled(d);
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  onClick={() => select(d)}
                  disabled={disabled}
                  className={[
                    "h-8 w-full flex items-center justify-center rounded-lg text-[13px] transition",
                    isSelected
                      ? "bg-accent text-[#0a0f1a] font-bold shadow-[0_0_10px_-2px_rgba(34,211,238,0.6)]"
                      : isToday && !disabled
                      ? "border border-accent/50 text-accent font-semibold hover:bg-accent/10"
                      : disabled
                      ? "text-white/15 cursor-not-allowed"
                      : "text-white/80 hover:bg-white/[0.08] hover:text-white font-medium",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {format(d, "d")}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/[0.05]">
            <button
              type="button"
              onClick={() => { onChange(""); setOpen(false); }}
              className="text-[12px] text-[var(--text-tertiary)] hover:text-white transition px-1.5 py-1 rounded-lg hover:bg-white/[0.06]"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => select(new Date())}
              disabled={isDisabled(new Date())}
              className="text-[12px] text-accent font-semibold hover:text-white transition px-1.5 py-1 rounded-lg hover:bg-accent/10 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Today
            </button>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <>
      {variant === "pill" ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition cursor-pointer ${
            pillIsActive
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-white/[0.08] text-[var(--text-secondary)] hover:border-white/20 hover:text-white"
          } ${className}`}
        >
          <CalendarDays size={11} />
          {value ? format(new Date(value + "T12:00:00"), "MMM d") : placeholder}
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`w-full inline-flex items-center gap-2.5 rounded-[10px] border bg-surface-2 px-3 h-10 text-[13px] transition hover:border-accent/40 focus:outline-none ${
            open ? "border-accent/50" : "border-white/[0.08]"
          } ${className}`}
        >
          <CalendarDays size={13} className="text-accent/60 shrink-0" />
          <span className={value ? "text-white" : "text-[var(--text-tertiary)]"}>
            {displayStr}
          </span>
        </button>
      )}

      {calendar}
    </>
  );
}
