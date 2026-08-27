/**
 * Production HTTP server for the ONE server-side route the SPA needs:
 * `POST /api/pin` (logo → IPFS via Pinata). Everything else — the built
 * `dist/` SPA and the `/indexer/` proxy to Ponder — is served by nginx; see
 * docs/deployments/rhpad-fun-ubuntu.md. Adapts Node's request/response to the
 * Web `Request`/`Response` that `handlePin` speaks, exactly like the Vite dev
 * middleware in vite.config.ts does.
 *
 * Built to a single plain-JS file by `npm run build:server` (esbuild, which
 * Vite already depends on) because `pin.ts` uses TypeScript-only syntax that
 * Node's native type stripping can't run. Run with `npm run start:server`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { defaultProvider, handlePin } from "./pin.ts";

const PORT = Number(process.env.PIN_PORT ?? 3001);
const HOST = process.env.PIN_HOST ?? "127.0.0.1";
const provider = defaultProvider();

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url?.split("?")[0] === "/healthz") {
    res.statusCode = 200;
    res.end("ok");
    return;
  }
  if (req.method !== "POST" || req.url?.split("?")[0] !== "/api/pin") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://localhost${req.url}`, {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] ?? "" },
      body: body.length ? body : undefined,
    });
    const response = await handlePin(request, provider);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("[pin] request failed:", err);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Pinning failed. Try again." }));
  }
}

createServer((req, res) => void onRequest(req, res)).listen(PORT, HOST, () => {
  console.log(`[pin] listening on http://${HOST}:${PORT} (provider: ${process.env.PINATA_JWT ? "pinata" : "MOCK — set PINATA_JWT"})`);
});
