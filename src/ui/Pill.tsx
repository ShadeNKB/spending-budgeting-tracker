import clsx from 'clsx'

type Tone = 'default' | 'accent' | 'positive' | 'negative' | 'warning' | 'info'

const tones: Record<Tone, string> = {
  default: 'bg-surface-2 text-[var(--text-secondary)] border-white/[0.06]',
  accent: 'bg-accent/10 text-accent border-accent/30',
  positive: 'bg-positive/10 text-positive border-positive/25',
  negative: 'bg-negative/10 text-negative border-negative/25',
  warning: 'bg-warning/10 text-warning border-warning/25',
  info: 'bg-blue-500/10 text-blue-400 border-blue-500/25',
}

const base =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-[1.3]'

/**
 * A small status label. Given `onClick` it becomes a button with a 44 px touch hit area; its
 * `aria-label` (e.g. "Remove date filter Oct 3") names the action. A plain pill takes no
 * `aria-label`: naming a generic span is prohibited ARIA, so its text is what is read.
 */
export function Pill({
  children,
  tone = 'default',
  className,
  onClick,
  title,
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode
  tone?: Tone
  className?: string
  onClick?: () => void
  title?: string
  'aria-label'?: string
}) {
  if (onClick) {
    return (
      <button
        type="button"
        title={title}
        aria-label={ariaLabel}
        onClick={onClick}
        className={clsx(base, 'tap-target transition hover:brightness-125', tones[tone], className)}
      >
        {children}
      </button>
    )
  }
  return (
    <span title={title} className={clsx(base, tones[tone], className)}>
      {children}
    </span>
  )
}
