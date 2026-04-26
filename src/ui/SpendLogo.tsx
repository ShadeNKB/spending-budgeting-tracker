import { motion } from "framer-motion";

export function SpendLogo({ size = 28, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <motion.div
      className="rounded-[8px] shrink-0"
      style={{ width: size, height: size }}
      animate={animated ? {
        boxShadow: [
          "0 0 12px -2px rgba(34,211,238,0.5)",
          "0 0 20px -2px rgba(34,211,238,0.75)",
          "0 0 12px -2px rgba(34,211,238,0.5)",
        ],
      } : undefined}
      transition={animated ? { duration: 2.8, repeat: Infinity, ease: "easeInOut" as const } : undefined}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 28 28"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id="sl-g" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#22D3EE" />
            <stop offset="100%" stopColor="#3B82F6" />
          </linearGradient>
        </defs>
        {/* Background rounded square */}
        <rect width="28" height="28" rx="7" fill="url(#sl-g)" />
        {/* Sparkline trend */}
        <path
          d="M5 19.5 L9 15 L13 17.5 L18 9.5 L23 13"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0.92"
        />
        {/* Terminal dot */}
        <circle cx="23" cy="13" r="2.2" fill="white" opacity="0.95" />
      </svg>
    </motion.div>
  );
}
