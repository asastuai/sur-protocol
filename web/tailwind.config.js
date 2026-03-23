/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
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
      },
      boxShadow: {
        "glow-primary": "0 0 20px rgba(0, 82, 255, 0.3), 0 0 40px rgba(0, 82, 255, 0.15)",
        "glow-long": "0 0 15px rgba(63, 185, 80, 0.25)",
        "glow-short": "0 0 15px rgba(248, 81, 73, 0.25)",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Fira Code", "monospace"],
        sans: ["DM Sans", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
