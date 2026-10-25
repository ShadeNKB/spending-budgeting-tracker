import { forwardRef, useId } from 'react'
import clsx from 'clsx'

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'suffix'> & {
  label?: string
  prefix?: React.ReactNode
  suffix?: React.ReactNode
  error?: string
  hint?: string
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, prefix, suffix, error, hint, mono, className, id, ...p },
  ref,
) {
  const rid = useId()
  const inputId = id ?? rid
  const messageId = error || hint ? `${inputId}-message` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label
          htmlFor={inputId}
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]"
        >
          {label}
        </label>
      )}
      {/* The frame draws the focus ring (.field-focus). It has no padding of its own: the input
          carries the side padding and the full height, so a tap or click anywhere inside the
          frame, bar a prefix or suffix, lands in the input. */}
      <div
        className={clsx(
          'field-focus flex h-11 items-center rounded-[10px] border bg-surface-2 transition-colors',
          error ? 'border-negative/50' : 'border-white/[0.06] hover:border-white/[0.1]',
        )}
      >
        {prefix && (
          <span className="shrink-0 pl-3 text-sm text-[var(--text-tertiary)]">{prefix}</span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          className={clsx(
            'field-control h-full min-w-0 flex-1 bg-transparent text-white placeholder:text-[var(--text-tertiary)]',
            prefix ? 'pl-2' : 'pl-3',
            suffix ? 'pr-2' : 'pr-3',
            mono && 'font-mono tabular-nums',
            className,
          )}
          {...p}
        />
        {suffix && (
          <span className="shrink-0 pr-3 text-sm text-[var(--text-tertiary)]">{suffix}</span>
        )}
      </div>
      {(error || hint) && (
        <span
          id={messageId}
          className={clsx('text-xs', error ? 'text-negative' : 'text-[var(--text-tertiary)]')}
        >
          {error ?? hint}
        </span>
      )}
    </div>
  )
})
