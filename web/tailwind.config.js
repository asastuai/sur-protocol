/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Legacy SUR colors (keep for existing components)
        sur: {
          bg: "var(--sur-bg)",
          surface: "var(--sur-surface)",
          border: "var(--sur-border)",
          text: "var(--sur-text)",
          muted: "var(--sur-muted)",
          accent: "var(--sur-accent)",
          green: "var(--sur-green)",
          red: "var(--sur-red)",
          yellow: "var(--sur-yellow)",
        },
        // shadcn-style tokens (used by FRONT components)
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        long: {
          DEFAULT: "hsl(var(--long) / <alpha-value>)",
          foreground: "hsl(var(--long-foreground) / <alpha-value>)",
        },
        short: {
          DEFAULT: "hsl(var(--short) / <alpha-value>)",
          foreground: "hsl(var(--short-foreground) / <alpha-value>)",
        },
        // Glass and glow (used by custom utility classes)
        glass: {
          DEFAULT: "var(--glass)",
          border: "var(--glass-border)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        "glow-primary": "0 0 20px rgba(0, 82, 255, 0.3), 0 0 40px rgba(0, 82, 255, 0.15)",
        "glow-long": "0 0 15px rgba(63, 185, 80, 0.25)",
        "glow-short": "0 0 15px rgba(248, 81, 73, 0.25)",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Fira Code", "monospace"],
        sans: ["Inter", "DM Sans", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
