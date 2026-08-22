import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { handlers } from "./msw/handlers";
import { fetchCandles, fetchToken, fetchTokens } from "./client";

const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("indexer client", () => {
  it("fetches and validates the tokens list against the fixture", async () => {
    const page = await fetchTokens({ sort: "newest" });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]).toHaveProperty("address");
    expect(page.items[0]).toHaveProperty("marketCap");
    expect(page.nextCursor === null || typeof page.nextCursor === "string").toBe(true);
  });
  it("fetches one token's detail", async () => {
    const detail = await fetchToken("0x1111111111111111111111111111111111111111");
    expect(detail.symbol).toBeTruthy();
  });
  it("fetches candles for an interval", async () => {
    const res = await fetchCandles("0x1111111111111111111111111111111111111111", "1h");
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0]).toHaveProperty("bucketStart");
  });
  it("throws when the response doesn't match the schema", async () => {
    server.use(
      http.get("*/tokens", () => HttpResponse.json({ items: [{ address: "not-an-address" }] })),
    );
    await expect(fetchTokens({})).rejects.toThrow();
  });
});
