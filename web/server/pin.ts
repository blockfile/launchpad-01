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

/**
 * Sniff the leading magic bytes and return the ACTUAL image mime, or null if
 * the bytes are not one of the four accepted formats. The client `Content-Type`
 * header is attacker-controlled and cannot be trusted: a `.svg`/HTML/script
 * payload relabelled `image/png` would otherwise be pinned and later served,
 * so the real bytes are the gate.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: "GIF8" (both 87a and 89a start this way)
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "image/gif";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

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
  // Don't trust the header: verify the bytes really are one of the accepted
  // image formats before forwarding anything to the pin provider.
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return Response.json(
      { error: "That file isn't a valid PNG, JPEG, WebP or GIF image." },
      { status: 400 },
    );
  }
  // Forward the SNIFFED type (the real one), not the client's claimed header.
  const { cid, gatewayUrl } = await provider.pinFile(bytes, sniffed);
  return Response.json({ uri: `ipfs://${cid}`, cid, gatewayUrl });
}

/** Real Pinata in any environment where `PINATA_JWT` is set, mock otherwise (e.g. local dev without a credential). */
export function defaultProvider(): PinProvider {
  const jwt = process.env.PINATA_JWT;
  return jwt ? new PinataPinProvider(jwt) : new MockPinProvider();
}
