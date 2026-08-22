/**
 * Server-only IPFS pinning: forwards an uploaded logo image to Pinata and
 * hands the browser back a `{ uri, cid, gatewayUrl }` triple.
 *
 * This file is the ONLY place the Pinata credential (`PINATA_JWT`) is read.
 * It speaks the Web-standard `Request`/`Response` (not a framework's own
 * request type), so `handlePin` mounts unchanged as Vite dev middleware
 * today and as a serverless function handler later — see the adapter in
 * `vite.config.ts`. Nothing under `web/src/**` imports this file or the
 * `PinataPinProvider` class; the browser only ever calls the same-origin
 * `/api/pin` route (see `src/components/LogoField.tsx`), so the credential
 * never reaches the client bundle.
 */
export interface PinProvider {
  pinFile(bytes: Uint8Array, contentType: string): Promise<{ cid: string; gatewayUrl: string }>;
}

const ACCEPT = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 5 * 1024 * 1024;

/** Deterministic fake CID — no real credential or network call, for tests/dev. */
export class MockPinProvider implements PinProvider {
  async pinFile(bytes: Uint8Array): Promise<{ cid: string; gatewayUrl: string }> {
    const cid = `mock-${bytes.length}-${Date.now()}`;
    return { cid, gatewayUrl: `https://mock.ipfs.local/ipfs/${cid}` };
  }
}

export class PinataPinProvider implements PinProvider {
  constructor(private readonly jwt: string) {}

  async pinFile(bytes: Uint8Array, contentType: string): Promise<{ cid: string; gatewayUrl: string }> {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: contentType }), "logo");
    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.jwt}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Pinata pin failed: ${res.status}`);
    const json = (await res.json()) as { IpfsHash: string };
    return { cid: json.IpfsHash, gatewayUrl: `https://gateway.pinata.cloud/ipfs/${json.IpfsHash}` };
  }
}

export async function handlePin(request: Request, provider: PinProvider): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!ACCEPT.has(contentType)) {
    return Response.json({ error: "Use a PNG, JPEG, WebP or GIF image." }, { status: 400 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return Response.json({ error: "The image is empty." }, { status: 400 });
  if (bytes.length > MAX_BYTES) return Response.json({ error: "Images must be smaller than 5 MB." }, { status: 400 });
  const { cid, gatewayUrl } = await provider.pinFile(bytes, contentType);
  return Response.json({ uri: `ipfs://${cid}`, cid, gatewayUrl });
}

/** Real Pinata in any environment where `PINATA_JWT` is set, mock otherwise (e.g. local dev without a credential). */
export function defaultProvider(): PinProvider {
  const jwt = process.env.PINATA_JWT;
  return jwt ? new PinataPinProvider(jwt) : new MockPinProvider();
}
