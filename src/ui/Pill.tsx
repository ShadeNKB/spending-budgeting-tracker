import clsx from "clsx";

type Tone = "default" | "accent" | "positive" | "negative" | "warning" | "info";

const tones: Record<Tone, string> = {
  default: "bg-surface-2 text-[var(--text-secondary)] border-white/[0.06]",
  accent: "bg-accent/10 text-accent border-accent/30",
  positive: "bg-positive/10 text-positive border-positive/25",
  negative: "bg-negative/10 text-negative border-negative/25",
  warning: "bg-warning/10 text-warning border-warning/25",
  info: "bg-blue-500/10 text-blue-400 border-blue-500/25",
};

export function Pill({
  children,
  tone = "default",
  className,
  onClick,
  title,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  onClick?: () => void;
  title?: string;
}) {
  const Tag = onClick ? "button" : ("span" as const);
  return (
    <Tag
      title={title}
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-[1.3] whitespace-nowrap",
        onClick && "hover:brightness-125 transition",
        tones[tone],
        className
      )}
    >
      {children}
    </Tag>
  );
}
