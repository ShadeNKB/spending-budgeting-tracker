import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import clsx from 'clsx'
import { Button } from '../../ui/Button'
import { whenText } from './recoveryText'

// The parts every section of the Recovery view shares (PR-4 track spec §3.2): the section frame,
// one card per row with its actions under the text, a list that shows 20 rows at a time, and the
// date line. Nothing here moves on a state change.

/** Rows a list shows at first, and adds per "Show 20 more". */
const PAGE = 20

/** Row actions: equal width under the row text, 44 px tall on phones (compact on desktop). */
export const ROW_ACTION = 'tap-target h-11 flex-1 px-3 text-[13px] sm:h-9 sm:flex-none'

/**
 * One section: an h4 that "Review" can send focus to, an optional control beside it (Mark all
 * seen), its lines and its rows.
 */
export function RecoverySection({
  title,
  aside,
  headingRef,
  children,
}: {
  title: ReactNode
  aside?: ReactNode
  headingRef?: Ref<HTMLHeadingElement>
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h4
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="focus-inset text-[13px] font-semibold text-white"
        >
          {title}
        </h4>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A row: its title, its lines, then its actions (stacked full width on phones). */
export function RecoveryRow({
  title,
  badge,
  children,
  actions,
}: {
  title: ReactNode
  badge?: ReactNode
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-surface-1 p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <p className="min-w-0 text-[13px] font-medium text-white [overflow-wrap:anywhere]">
          {title}
        </p>
        {badge}
      </div>
      {children !== undefined && (
        <div className="flex min-w-0 flex-col gap-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">
          {children}
        </div>
      )}
      {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

/**
 * The rows of a section, 20 at a time. "Show 20 more" hands focus to the first row it adds, so
 * the reader carries on where the list grew.
 */
export function PagedList<T>({
  items,
  label,
  keyOf,
  render,
}: {
  items: readonly T[]
  label: string
  keyOf: (item: T) => string
  render: (item: T) => ReactNode
}) {
  const [shown, setShown] = useState(PAGE)
  const [focusAt, setFocusAt] = useState<number | null>(null)
  const firstNew = useRef<HTMLLIElement>(null)
  const more = Math.min(PAGE, items.length - shown)
  useLayoutEffect(() => {
    if (focusAt !== null) firstNew.current?.focus()
  }, [focusAt])
  return (
    <>
      <ul aria-label={label} className="flex flex-col gap-2">
        {items.slice(0, shown).map((item, i) => (
          <li
            key={keyOf(item)}
            ref={i === focusAt ? firstNew : undefined}
            tabIndex={i === focusAt ? -1 : undefined}
            className={clsx(i === focusAt && 'focus-inset rounded-lg')}
          >
            {render(item)}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Button
          variant="ghost"
          className="w-full sm:w-auto sm:self-start"
          onClick={() => {
            setFocusAt(shown)
            setShown(shown + PAGE)
          }}
        >
          Show {more} more
        </Button>
      )}
    </>
  )
}

/** A row's time, as `whenText` says it. */
export function When({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{whenText(at)}</time>
}
