import { useRef } from 'react'
import clsx from 'clsx'

export interface SegmentedOption<T extends string = string> {
  value: T
  label: React.ReactNode
}

type Props<T extends string> = {
  /** The radiogroup's accessible name, e.g. "Period". */
  label: string
  value: T
  onChange: (v: T) => void
  options: SegmentedOption<T>[]
  size?: 'sm' | 'md'
  fullWidth?: boolean
  className?: string
}

/** Arrow keys of the ARIA radio group pattern: previous or next option, wrapping at the ends. */
const STEP: Partial<Record<string, -1 | 1>> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
}

/**
 * A named radio group drawn as a segmented control. One tab stop (the checked option, roving
 * tabindex); the arrow keys move and select, so selection follows focus. On touch screens the
 * options are 36 px tall in a 44 px track, and their hit area spans the track.
 */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  size = 'md',
  fullWidth,
  className,
}: Props<T>) {
  const group = useRef<HTMLDivElement>(null)
  const checked = options.findIndex((o) => o.value === value)
  // With no option checked the first one takes the tab stop, so the group stays reachable.
  const tabStop = Math.max(checked, 0)

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = STEP[e.key]
    if (step === undefined || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    e.preventDefault()
    const nextIndex = (index + step + options.length) % options.length
    const next = options[nextIndex]
    if (!next || nextIndex === index) return
    const radio = group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]
    // A keyboard move: said so explicitly, as WebKit would otherwise draw no ring for this
    // script focus after the group was clicked.
    radio?.focus({ focusVisible: true })
    onChange(next.value)
  }

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className={clsx(
        'inline-flex items-center gap-0.5 rounded-full border border-white/[0.06] bg-surface-1 p-1 [@media(pointer:coarse)]:p-[3px]',
        fullWidth && 'w-full',
        className,
      )}
    >
      {options.map((opt, i) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => {
              onChange(opt.value)
            }}
            onKeyDown={(e) => {
              onKeyDown(e, i)
            }}
            className={clsx(
              'tap-target relative inline-flex min-w-11 items-center justify-center rounded-full font-medium transition-colors [@media(pointer:coarse)]:h-9',
              size === 'sm' ? 'h-7 px-3 text-[12px]' : 'h-8 px-3.5 text-[13px]',
              fullWidth && 'flex-1',
              active
                ? 'bg-accent/12 text-accent shadow-[inset_0_0_0_1px_rgba(34,211,238,0.18)]'
                : 'text-[var(--text-secondary)] hover:text-white',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
