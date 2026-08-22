import { describe, expect, it, vi, afterEach } from "vitest";
import { handlePin, MockPinProvider, PinataPinProvider, defaultProvider, sniffImageType } from "./pin";

// Real leading magic bytes for each accepted format (padded to the minimum the
// sniff needs — 12 bytes for WebP's RIFF/WEBP pair).
const MAGIC: Record<string, Uint8Array<ArrayBuffer>> = {
  "image/png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  "image/jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
  "image/gif": new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]),
  "image/webp": new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
};

describe("handlePin", () => {
  it("rejects a non-image content-type", async () => {
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    const res = await handlePin(req, new MockPinProvider());
    expect(res.status).toBe(400);
  });

  it("returns a cid + gatewayUrl for a valid image", async () => {
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "image/png" }, body: MAGIC["image/png"] });
    const res = await handlePin(req, new MockPinProvider());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("cid");
    expect(json.gatewayUrl).toContain(json.cid);
  });

  it("returns an ipfs:// uri built from the provider's cid", async () => {
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "image/webp" }, body: MAGIC["image/webp"] });
    const res = await handlePin(req, new MockPinProvider());
    const json = await res.json();
    expect(json.uri).toBe(`ipfs://${json.cid}`);
  });

  it("rejects an empty body", async () => {
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([]) });
    const res = await handlePin(req, new MockPinProvider());
    expect(res.status).toBe(400);
  });

  it("rejects an image over the 5 MB ceiling", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes.set(MAGIC["image/png"]); // valid header — proves the SIZE gate rejects, not the sniff
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "image/png" }, body: bytes });
    const res = await handlePin(req, new MockPinProvider());
    expect(res.status).toBe(400);
  });

  it("accepts png, jpeg, webp and gif with matching magic bytes", async () => {
    for (const contentType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      const req = new Request("http://x/api/pin", {
        method: "POST",
        headers: { "content-type": contentType },
        body: MAGIC[contentType],
      });
      const res = await handlePin(req, new MockPinProvider());
      expect(res.status).toBe(200);
    }
  });

  it("rejects a spoofed image/png whose bytes are NOT an image (magic-byte sniff)", async () => {
    // An accepted content-type header but a text/script payload — exactly the
    // relabel attack the sniff exists to stop.
    const notAnImage = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20]); // "<svg "
    const req = new Request("http://x/api/pin", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: notAnImage,
    });
    const res = await handlePin(req, new MockPinProvider());
    expect(res.status).toBe(400);
  });

  it("forwards the SNIFFED type to the provider, not the client's header", async () => {
    // Header claims png; bytes are really a JPEG. The provider must be handed
    // the real type.
    const seen: string[] = [];
    const provider = {
      async pinFile(_bytes: Uint8Array, contentType: string) {
        seen.push(contentType);
        return { cid: "cid-x", gatewayUrl: "https://mock/ipfs/cid-x" };
      },
    };
    const req = new Request("http://x/api/pin", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: MAGIC["image/jpeg"],
    });
    const res = await handlePin(req, provider);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["image/jpeg"]);
  });
});

describe("sniffImageType", () => {
  it("detects each accepted format and rejects non-images", () => {
    expect(sniffImageType(MAGIC["image/png"])).toBe("image/png");
    expect(sniffImageType(MAGIC["image/jpeg"])).toBe("image/jpeg");
    expect(sniffImageType(MAGIC["image/gif"])).toBe("image/gif");
    expect(sniffImageType(MAGIC["image/webp"])).toBe("image/webp");
    expect(sniffImageType(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // "<svg"
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});

describe("PinataPinProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the bytes to Pinata with the supplied JWT and maps the response", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-jwt" });
      return new Response(JSON.stringify({ IpfsHash: "QmAbc123" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new PinataPinProvider("test-jwt");
    const result = await provider.pinFile(new Uint8Array([1, 2, 3]), "image/png");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.cid).toBe("QmAbc123");
    expect(result.gatewayUrl).toContain("QmAbc123");
  });

  it("throws when Pinata responds with a non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    const provider = new PinataPinProvider("test-jwt");
    await expect(provider.pinFile(new Uint8Array([1]), "image/png")).rejects.toThrow();
  });
});

describe("defaultProvider", () => {
  const ORIGINAL_JWT = process.env.PINATA_JWT;

  afterEach(() => {
    if (ORIGINAL_JWT === undefined) delete process.env.PINATA_JWT;
    else process.env.PINATA_JWT = ORIGINAL_JWT;
  });

  it("falls back to MockPinProvider when PINATA_JWT is unset", () => {
    delete process.env.PINATA_JWT;
    expect(defaultProvider()).toBeInstanceOf(MockPinProvider);
  });

  it("uses PinataPinProvider when PINATA_JWT is set", () => {
    process.env.PINATA_JWT = "some-jwt";
    expect(defaultProvider()).toBeInstanceOf(PinataPinProvider);
  });
});
