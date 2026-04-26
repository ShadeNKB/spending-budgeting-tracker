import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import clsx from "clsx";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-[10px] font-medium whitespace-nowrap transition-colors transition-transform duration-150 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 focus-visible:ring-accent/50 touch-manipulation",
  {
    variants: {
      variant: {
        primary: "bg-accent text-surface-0 hover:bg-accent-hover hover:shadow-[0_0_22px_-4px_rgba(34,211,238,0.35)]",
        ghost: "border border-white/[0.06] text-white/90 hover:bg-surface-2 hover:border-white/10",
        subtle: "text-[var(--text-secondary)] hover:text-white hover:bg-surface-2",
        danger: "text-negative hover:bg-negative/10",
        dangerSolid: "bg-negative text-white hover:bg-negative/90",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-[15px]",
        icon: "h-10 w-10",
        iconSm: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { className, variant, size, ...p },
  ref
) {
  return <button ref={ref} className={clsx(button({ variant, size }), className)} {...p} />;
});
