/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        sur: {
          bg: "#141518",
          surface: "#1b1d28",
          border: "#252836",
          text: "#e4e5eb",
          muted: "#6b7280",
          accent: "#0052FF",
          green: "#0ECB81",
          red: "#F6465D",
          yellow: "#ffb224",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Fira Code", "monospace"],
        sans: ["DM Sans", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
