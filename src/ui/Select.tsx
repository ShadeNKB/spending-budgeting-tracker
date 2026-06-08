import { forwardRef, useId } from 'react'
import clsx from 'clsx'

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, className, id, children, ...props },
  ref,
) {
  const rid = useId()
  const selectId = id ?? rid

  return (
    <div className="relative">
      {label && (
        <label htmlFor={selectId} className="sr-only">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        className={clsx(
          'h-11 cursor-pointer appearance-none rounded-[10px] border border-white/[0.06] bg-surface-2 pl-3 pr-8 text-[13px] text-white outline-none transition focus:border-accent/60 focus:shadow-[0_0_0_3px_rgba(34,211,238,0.18)]',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  )
})
