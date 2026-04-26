import type { LucideIcon } from "lucide-react";
import { Button } from "./Button";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <div
      className={
        "flex flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-white/[0.08] bg-surface-1/40 px-6 py-12 text-center " +
        (className ?? "")
      }
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full border border-white/[0.08] bg-surface-2 text-[var(--text-secondary)]">
        <Icon size={18} />
      </div>
      <div>
        <h3 className="text-[15px] font-semibold text-white">{title}</h3>
        {description && <p className="mt-1 text-[13px] text-[var(--text-tertiary)] max-w-[320px]">{description}</p>}
      </div>
      {action && (
        <Button variant="ghost" size="sm" onClick={action.onClick} className="mt-1">
          {action.label}
        </Button>
      )}
    </div>
  );
}
