import { defineConfig } from "vite";
import type { Connect, Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { handlePin, defaultProvider } from "./server/pin.ts";

/**
 * Adapts Node's `IncomingMessage`/`ServerResponse` to the Web-standard
 * `Request`/`Response` `handlePin` speaks, so the logo-pin route works in
 * `vite dev` without teaching `handlePin` anything about Node or Connect.
 * The same handler mounts unchanged behind whatever serverless runtime
 * production ends up on (those already speak `Request`/`Response` natively).
 */
function pinMiddlewarePlugin(): Plugin {
  return {
    name: "launchpad-pin-middleware",
    configureServer(server) {
      server.middlewares.use("/api/pin", (async (
        req: IncomingMessage,
        res: ServerResponse,
        next: Connect.NextFunction
      ) => {
        if (req.method !== "POST") return next();
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks);
          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers: { "content-type": req.headers["content-type"] ?? "" },
            body: body.length ? body : undefined,
          });
          const response = await handlePin(request, defaultProvider());
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          next(err instanceof Error ? err : new Error(String(err)));
        }
      }) as Connect.HandleFunction);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pinMiddlewarePlugin()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // The local-Anvil integration test is its own vitest project
    // (vitest.anvil.config.ts) — never collected by the default `test` run,
    // so `npm test` never needs a running chain.
    exclude: ["**/node_modules/**", "**/dist/**", "src/test/anvil/**"],
  },
});
