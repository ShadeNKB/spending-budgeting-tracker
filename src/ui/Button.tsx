import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import clsx from 'clsx'

// Focus is the shared :focus-visible outline (index.css). Sizes under 44 px get the coarse-
// pointer hit area (.tap-target): a phone tap lands on a 44 x 44 px area with no visual change.
const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-[10px] font-medium whitespace-nowrap transition duration-150 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none touch-manipulation',
  {
    variants: {
      variant: {
        // The filled variants carry a transparent border: forced colours (Windows contrast
        // themes) drop the fill but paint the border, so the main action keeps its outline next
        // to a bordered Cancel instead of reading as plain text. Invisible otherwise.
        primary:
          'border border-transparent bg-accent text-surface-0 hover:bg-accent-hover hover:shadow-[0_0_22px_-4px_rgba(34,211,238,0.35)]',
        ghost: 'border border-white/[0.06] text-white/90 hover:bg-surface-2 hover:border-white/10',
        subtle: 'text-[var(--text-secondary)] hover:text-white hover:bg-surface-2',
        danger: 'text-negative hover:bg-negative/10',
        // White on negative.solid: 4.83:1 in both themes (index.css keeps the label white in
        // light mode). Hover darkens, so the label never drops under 4.5:1.
        dangerSolid: 'border border-transparent bg-negative-solid text-white hover:brightness-95',
      },
      size: {
        sm: 'tap-target h-8 px-3 text-[13px]',
        md: 'tap-target h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-[15px]',
        icon: 'tap-target h-10 w-10',
        iconSm: 'tap-target h-8 w-8',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { className, variant, size, ...p },
  ref,
) {
  return <button ref={ref} className={clsx(button({ variant, size }), className)} {...p} />
})
