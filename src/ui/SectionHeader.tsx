import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Consistent card section header — a leading accent icon, an uppercase eyebrow
 * heading, and an optional right-aligned meta slot. Standardizes the header
 * treatment that was previously hand-rolled per card (mismatched icons,
 * tracking, and meta styling).
 */
export function SectionHeader({
  icon: Icon,
  children,
  meta,
}: {
  icon?: LucideIcon
  children: ReactNode
  meta?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {Icon && <Icon size={13} className="shrink-0 text-accent/70" />}
        <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
          {children}
        </h2>
      </div>
      {meta != null && (
        <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">{meta}</span>
      )}
    </div>
  )
}
