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

// Pinata authenticates with a JWT (three dot-separated base64url segments,
// starts "eyJ"). The dashboard also shows a 20-hex-char "API Key" and an "API
// Secret" — pasting one of those here is the #1 misconfiguration (seen in
// production 2026-08-27: every upload failed with Pinata 401 "token contains
// an invalid number of segments"). Fail loudly at boot instead of per-upload.
const jwt = process.env.PINATA_JWT;
if (jwt && jwt.split(".").length !== 3) {
  console.error(
    "[pin] PINATA_JWT is not a JWT (expected 3 dot-separated segments starting with 'eyJ'). " +
      "You probably pasted the Pinata API Key or Secret — copy the JWT field from Pinata → API Keys.",
  );
  process.exit(1);
}
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
    // Surface the upstream status (e.g. "Pinata pin failed: 401") so a
    // credential/scope problem is diagnosable from the browser, not only pm2 logs.
    const detail = err instanceof Error && /^Pinata pin failed: \d+/.test(err.message) ? ` (${err.message})` : "";
    res.statusCode = 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: `Pinning failed${detail}. Try again.` }));
  }
}

createServer((req, res) => void onRequest(req, res)).listen(PORT, HOST, () => {
  console.log(`[pin] listening on http://${HOST}:${PORT} (provider: ${process.env.PINATA_JWT ? "pinata" : "MOCK — set PINATA_JWT"})`);
});
