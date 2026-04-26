import { motion } from "framer-motion";
import clsx from "clsx";
import { useId } from "react";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
}

type Props<T extends string> = {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  size?: "sm" | "md";
  fullWidth?: boolean;
  className?: string;
};

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  fullWidth,
  className,
}: Props<T>) {
  const layoutId = useId();
  return (
    <div
      role="tablist"
      className={clsx(
        "inline-flex items-center gap-0.5 rounded-full border border-white/[0.06] bg-surface-1 p-1",
        fullWidth && "w-full",
        className
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={clsx(
              "relative inline-flex items-center justify-center rounded-full font-medium transition-colors",
              size === "sm" ? "h-7 px-3 text-[12px]" : "h-8 px-3.5 text-[13px]",
              fullWidth && "flex-1",
              active ? "text-surface-0" : "text-[var(--text-secondary)] hover:text-white"
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${layoutId}`}
                className="absolute inset-0 rounded-full bg-white"
                transition={{ type: "spring", stiffness: 420, damping: 36 }}
              />
            )}
            <span className="relative z-10">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
