import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ["@spruvex-r/types"] },
  // Workspace packages (e.g. @spruvex-r/types) are symlinked in from
  // outside node_modules, so Rollup's default commonjsOptions.include
  // (which only matches paths under node_modules) skips them and falls
  // back to a minimal, best-effort CJS interop that can't see named
  // exports re-exported through a getter (Object.defineProperty(exports,
  // "X", { get: ... })) — the pattern TypeScript emits for `export *`.
  // Explicitly including the workspace package routes it through the
  // full commonjs plugin instead.
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages\/types/],
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
