/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    screens: {
      xs: "380px",
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
    },
    extend: {
      colors: {
        // OLED-near-black surface scale. surface-0 = app bg, ascending elevation.
        surface: {
          0: "#07090D",
          1: "#0E1217",
          2: "#161B22",
          3: "#1F252E",
          4: "#2A313C",
        },
        // Legacy alias (kept so existing bg-surface-1 references still read as app bg)
        dark: {
          900: "#07090D",
          800: "#0E1217",
          700: "#161B22",
          600: "#1F252E",
          500: "#2A313C",
          400: "#5A6478",
          300: "#8A94A6",
        },
        accent: {
          DEFAULT: "#22D3EE",
          hover: "#67E8F9",
          dim: "rgba(34, 211, 238, 0.12)",
        },
        positive: "#22C55E",
        negative: "#EF4444",
        warning: "#F59E0B",
        muted: "#5A6478",
        // Semantic aliases
        success: "#22C55E",
        danger: "#EF4444",
        neon: {
          cyan: "#22D3EE",
          pink: "#E879F9",
          green: "#22C55E",
          yellow: "#F59E0B",
          purple: "#818CF8",
          orange: "#FB923C",
          blue: "#60A5FA",
          red: "#EF4444",
        },
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "'Fira Code'", "monospace"],
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
      },
      fontSize: {
        display: ["clamp(2.25rem, 4.5vw, 3.5rem)", { lineHeight: "1.05", letterSpacing: "-0.03em", fontWeight: "600" }],
        heading: ["1.25rem", { lineHeight: "1.4", fontWeight: "600" }],
        subheading: ["1rem", { lineHeight: "1.5", fontWeight: "500" }],
        label: ["0.6875rem", { lineHeight: "1.4", fontWeight: "500", letterSpacing: "0.08em" }],
        body: ["0.875rem", { lineHeight: "1.55", fontWeight: "400" }],
        caption: ["0.75rem", { lineHeight: "1.4", fontWeight: "400" }],
      },
      spacing: {
        // Safe-area for iOS notches / bottom-bars
        "safe-top": "env(safe-area-inset-top)",
        "safe-bottom": "env(safe-area-inset-bottom)",
      },
      animation: {
        "spin-slow": "spin 3s linear infinite",
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.25s ease-out",
        "pulse-soft": "pulseSoft 2s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: { from: { opacity: "0" }, to: { opacity: "1" } },
        slideUp: { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        pulseSoft: { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0.6" } },
      },
      backdropBlur: { xs: "2px" },
      borderColor: { DEFAULT: "rgba(255,255,255,0.06)" },
    },
  },
  plugins: [],
};
