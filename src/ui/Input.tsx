import { forwardRef, useId } from "react";
import clsx from "clsx";

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "prefix" | "suffix"> & {
  label?: string;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  error?: string;
  hint?: string;
  mono?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, prefix, suffix, error, hint, mono, className, id, ...p },
  ref
) {
  const rid = useId();
  const inputId = id ?? rid;
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
          {label}
        </label>
      )}
      <div
        className={clsx(
          "flex h-11 items-center gap-2 rounded-[10px] border bg-surface-2 px-3 transition-all",
          "focus-within:border-accent/60 focus-within:shadow-[0_0_0_3px_rgba(34,211,238,0.18)]",
          error ? "border-negative/50" : "border-white/[0.06] hover:border-white/[0.1]"
        )}
      >
        {prefix && <span className="text-[var(--text-tertiary)] text-sm shrink-0">{prefix}</span>}
        <input
          ref={ref}
          id={inputId}
          className={clsx(
            "flex-1 bg-transparent text-white placeholder:text-[var(--text-tertiary)] outline-none",
            mono && "font-mono tabular-nums",
            className
          )}
          {...p}
        />
        {suffix && <span className="text-[var(--text-tertiary)] text-sm shrink-0">{suffix}</span>}
      </div>
      {(error || hint) && (
        <span className={clsx("text-xs", error ? "text-negative" : "text-[var(--text-tertiary)]")}>{error ?? hint}</span>
      )}
    </div>
  );
});
