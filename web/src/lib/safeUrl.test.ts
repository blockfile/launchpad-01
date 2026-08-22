import { describe, expect, it } from "vitest";
import { safeImageSrc, safeLinkHref, PLACEHOLDER_IMAGE } from "./safeUrl";

describe("safeImageSrc", () => {
  it("passes an https URL through verbatim", () => {
    expect(safeImageSrc("https://example.com/logo.png")).toBe("https://example.com/logo.png");
  });

  it("resolves ipfs:// to the gateway", () => {
    expect(safeImageSrc("ipfs://QmAbc123")).toBe("https://ipfs.io/ipfs/QmAbc123");
    expect(safeImageSrc("ipfs://QmAbc123/nested.png")).toBe(
      "https://ipfs.io/ipfs/QmAbc123/nested.png",
    );
  });

  it("rejects a javascript: URL → placeholder", () => {
    expect(safeImageSrc("javascript:alert(1)")).toBe(PLACEHOLDER_IMAGE);
  });

  it("rejects a data: URL → placeholder", () => {
    expect(safeImageSrc("data:text/html,<script>alert(1)</script>")).toBe(PLACEHOLDER_IMAGE);
  });

  it("rejects plain http, relative, blank, and malformed → placeholder", () => {
    expect(safeImageSrc("http://example.com/x.png")).toBe(PLACEHOLDER_IMAGE);
    expect(safeImageSrc("/local/path.png")).toBe(PLACEHOLDER_IMAGE);
    expect(safeImageSrc("")).toBe(PLACEHOLDER_IMAGE);
    expect(safeImageSrc(null)).toBe(PLACEHOLDER_IMAGE);
    expect(safeImageSrc(undefined)).toBe(PLACEHOLDER_IMAGE);
  });
});

describe("safeLinkHref", () => {
  it("passes an https URL through verbatim", () => {
    expect(safeLinkHref("https://twitter.com/x")).toBe("https://twitter.com/x");
  });

  it("resolves ipfs:// to the gateway", () => {
    expect(safeLinkHref("ipfs://QmAbc123")).toBe("https://ipfs.io/ipfs/QmAbc123");
  });

  it("rejects a javascript: URL → null (caller renders no anchor)", () => {
    expect(safeLinkHref("javascript:alert(1)")).toBeNull();
  });

  it("rejects a data: URL → null", () => {
    expect(safeLinkHref("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects plain http, blank, and malformed → null", () => {
    expect(safeLinkHref("http://example.com")).toBeNull();
    expect(safeLinkHref("")).toBeNull();
    expect(safeLinkHref(null)).toBeNull();
    expect(safeLinkHref(undefined)).toBeNull();
  });
});
