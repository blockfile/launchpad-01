import { describe, expect, it, vi, afterEach } from "vitest";
import { handlePin, MockPinProvider, PinataPinProvider, defaultProvider } from "./pin";

describe("handlePin", () => {
  it("rejects a non-image content-type", async () => {
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    const res = await handlePin(req, new MockPinProvider());
    expect(res.status).toBe(400);
  });

  it("returns a cid + gatewayUrl for a valid image", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "image/png" }, body: bytes });
    const res = await handlePin(req, new MockPinProvider());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("cid");
    expect(json.gatewayUrl).toContain(json.cid);
  });

  it("returns an ipfs:// uri built from the provider's cid", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "image/webp" }, body: bytes });
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
    const req = new Request("http://x/api/pin", { method: "POST", headers: { "content-type": "image/png" }, body: bytes });
    const res = await handlePin(req, new MockPinProvider());
    expect(res.status).toBe(400);
  });

  it("accepts png, jpeg, webp and gif", async () => {
    for (const contentType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      const req = new Request("http://x/api/pin", {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Uint8Array([1]),
      });
      const res = await handlePin(req, new MockPinProvider());
      expect(res.status).toBe(200);
    }
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
