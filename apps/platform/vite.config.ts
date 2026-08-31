import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // @spruvex-r/types builds to CJS; without forcing it into Vite's dep
  // pre-bundling, the exact set of eagerly-imported pages determines whether
  // Vite's crawler resolves it correctly or serves the raw CJS file straight
  // to the browser ("exports is not defined") — see apps/dashboard's
  // vite.config.ts, which needed the same fix for the same reason.
  optimizeDeps: { include: ["@spruvex-r/types"] },
  server: {
    port: 5177,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
