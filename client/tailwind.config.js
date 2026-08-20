/** @type {import('tailwindcss').Config} */
// ORION celestial palette: near-black space, midnight navy elevation, and
// CSS-var-backed silver-blue starlight accents.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#01040a",
          1: "#030813",
          2: "#070e1d",
          3: "#0a1528",
          4: "#10203a",
          5: "#172d4d",
        },
        accent: {
          DEFAULT: "rgb(var(--hud-accent) / <alpha-value>)",
          hover: "rgb(var(--hud-accent-hover) / <alpha-value>)",
        },
        chroma: "rgb(var(--hud-chroma) / <alpha-value>)",
        hudborder: {
          DEFAULT: "rgb(var(--hud-border) / <alpha-value>)",
          light: "rgb(var(--hud-border-light) / <alpha-value>)",
        },
        hud: {
          gold: "#b3871d",
          "gold-bright": "#f0c040",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        display: ["Rajdhani", "Inter", "sans-serif"],
        wordmark: ["Orbitron", "Rajdhani", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 20px -2px rgb(var(--hud-accent) / 0.45)",
        "glow-sm": "0 0 10px -1px rgb(var(--hud-accent) / 0.5)",
      },
      keyframes: {
        "ring-spin": { to: { transform: "rotate(360deg)" } },
        "ring-spin-rev": { to: { transform: "rotate(-360deg)" } },
        "core-pulse": {
          "0%,100%": { opacity: "0.85", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.04)" },
        },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.4s ease both",
        "slide-up": "slide-up 0.35s ease both",
        "core-pulse": "core-pulse 3.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
