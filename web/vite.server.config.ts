import { defineConfig } from "vite";

/**
 * Builds the production `/api/pin` server (server/serve.ts) to a single plain
 * JS file: `npm run build:server` → dist-server/serve.js, run by pm2 via
 * `npm run start:server`. Kept separate from vite.config.ts so the SPA build
 * (plugins, publicDir copy, jsdom test config) never leaks into the node bundle.
 */
export default defineConfig({
  build: {
    ssr: "server/serve.ts",
    outDir: "dist-server",
    copyPublicDir: false,
    target: "node22",
    emptyOutDir: true,
  },
});
