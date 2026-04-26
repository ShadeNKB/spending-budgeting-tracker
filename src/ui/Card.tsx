import { motion, type HTMLMotionProps } from "framer-motion";
import clsx from "clsx";

type Props = HTMLMotionProps<"div"> & {
  interactive?: boolean;
  glow?: boolean;
  padded?: boolean;
  children?: React.ReactNode;
};

export function Card({ className, interactive, glow, padded = true, children, ...p }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
      whileHover={interactive ? { y: -1 } : undefined}
      className={clsx(
        "rounded-[14px] border border-white/[0.06] bg-surface-1 transition-colors",
        padded && "p-5 md:p-6",
        interactive && "cursor-pointer hover:bg-surface-2 hover:border-white/[0.1]",
        glow && "relative overflow-hidden",
        className
      )}
      {...p}
    >
      {glow && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-50"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, rgba(34,211,238,0.7) 50%, transparent 100%)",
          }}
        />
      )}
      {children}
    </motion.div>
  );
}
