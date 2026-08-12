import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BFF = process.env.BFF_URL ?? "http://127.0.0.1:4820";

// Dev server proxies /api (incl. the /api/events SSE stream) to the BFF.
// Loopback is the safe default. Set VITE_HOST explicitly only when a trusted
// reverse proxy or equivalent access control protects the development server.
export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.VITE_HOST ?? "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: BFF, changeOrigin: false, ws: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // Three.js is isolated and lazy-loaded with the Memory route; its vendor
    // chunk is intentionally larger than Vite's generic 500 kB warning.
    chunkSizeWarningLimit: 540,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three";
        },
      },
    },
  },
});
