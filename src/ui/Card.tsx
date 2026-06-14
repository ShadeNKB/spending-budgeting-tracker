import clsx from 'clsx'

type Props = React.HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean
  glow?: boolean
  padded?: boolean
  children?: React.ReactNode
}

export function Card({ className, interactive, glow, padded = true, children, ...p }: Props) {
  return (
    <div
      className={clsx(
        'rounded-2xl border border-white/[0.06] bg-surface-1 transition-[border-color,background-color,box-shadow,transform] duration-[180ms]',
        padded && 'p-5 md:p-6',
        interactive &&
          'cursor-pointer hover:-translate-y-px hover:border-white/[0.1] hover:bg-surface-2',
        glow && 'relative overflow-hidden',
        className,
      )}
      {...p}
    >
      {glow && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-50"
          style={{
            background:
              'linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.7) 50%, transparent 100%)',
          }}
        />
      )}
      {children}
    </div>
  )
}
