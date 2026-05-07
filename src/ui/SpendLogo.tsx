import { motion } from "framer-motion";

/**
 * SpendTrack brand mark.
 *
 * The mark is derived from the app's signature **PaceRing** visualization —
 * the same data-viz pattern the user sees on the Pulse hero card. This
 * unifies brand identity with the product's most distinctive feature.
 *
 * Renders the same SVG as `public/favicon.svg` so brand is consistent
 * across favicon, PWA icon, in-app header, OS install prompts.
 */
export function SpendLogo({
  size = 28,
  animated = false,
}: {
  size?: number;
  animated?: boolean;
}) {
  // The arc length is animated subtly when `animated` is true.
  return (
    <motion.div
      className="rounded-[8px] shrink-0"
      style={{ width: size, height: size }}
      animate={
        animated
          ? {
              boxShadow: [
                "0 0 12px -2px rgba(34,211,238,0.45)",
                "0 0 22px -2px rgba(34,211,238,0.7)",
                "0 0 12px -2px rgba(34,211,238,0.45)",
              ],
            }
          : undefined
      }
      transition={
        animated
          ? { duration: 3.2, repeat: Infinity, ease: "easeInOut" as const }
          : undefined
      }
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block" }}
        aria-hidden
      >
        <defs>
          <linearGradient id={`sl-bg-${size}`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0E1217" />
            <stop offset="100%" stopColor="#161B22" />
          </linearGradient>
          <linearGradient id={`sl-ring-${size}`} x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#22D3EE" />
            <stop offset="100%" stopColor="#3B82F6" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill={`url(#sl-bg-${size})`} />
        <rect
          x="0.5"
          y="0.5"
          width="31"
          height="31"
          rx="7.5"
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="1"
        />
        {/* Pace ring track */}
        <circle cx="16" cy="16" r="8" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2.5" />
        {/* Pace ring active arc — 46% completion */}
        <circle
          cx="16"
          cy="16"
          r="8"
          fill="none"
          stroke={`url(#sl-ring-${size})`}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="50.27"
          strokeDashoffset="27.15"
          transform="rotate(-90 16 16)"
        />
        {/* Center dot accent */}
        <circle cx="16" cy="16" r="2" fill={`url(#sl-ring-${size})`} />
      </svg>
    </motion.div>
  );
}
