import { Children, forwardRef, isValidElement, useId, type ReactNode } from 'react'
import clsx from 'clsx'

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string
}

/**
 * The text of the option a controlled select is showing, read from its plain-text `<option>`
 * children. Null when the select is uncontrolled or no such option matches.
 */
function chosenOptionText(children: ReactNode, value: SelectProps['value']): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  for (const child of Children.toArray(children)) {
    if (!isValidElement<React.OptionHTMLAttributes<HTMLOptionElement>>(child)) continue
    if (child.type !== 'option') continue
    const { value: optionValue, children: text } = child.props
    if (typeof text !== 'string') continue
    const key =
      typeof optionValue === 'string' || typeof optionValue === 'number' ? optionValue : text
    if (String(key) === String(value)) return text
  }
  return null
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, className, id, children, ...props },
  ref,
) {
  const rid = useId()
  const selectId = id ?? rid
  // On touch screens the select's own text is floored at 16 px (index.css; iOS zooms the page
  // on focus otherwise), which no longer fits a width-capped select. The chosen option is drawn
  // on top at the design size instead, cut with an ellipsis rather than mid-letter, and the
  // select's own text is hidden. The select keeps its size, focus ring, value and name.
  const shown = chosenOptionText(children, props.value)

  return (
    <div className="relative w-fit max-w-full">
      {label && (
        <label htmlFor={selectId} className="sr-only">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        className={clsx(
          'h-11 cursor-pointer appearance-none rounded-[10px] border border-white/[0.06] bg-surface-2 pl-3 pr-8 text-[13px] outline-none transition focus:border-accent/60 focus:shadow-[0_0_0_3px_rgba(34,211,238,0.18)]',
          shown === null ? 'text-white' : 'text-transparent [&>option]:text-[var(--text-primary)]',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {shown !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 right-8 flex items-center pl-[13px] text-[13px] text-white forced-colors:hidden"
        >
          <span className="min-w-0 truncate">{shown}</span>
        </span>
      )}
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
