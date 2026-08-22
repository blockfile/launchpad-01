import { describe, expect, it } from "vitest";
import { applyTradeToCandle, bucketStart } from "../src/lib/candles";

describe("bucketStart", () => {
  it("floors a timestamp to the 1h bucket", () => expect(bucketStart(3_661n, "1h")).toBe(3_600n));
  it("floors a timestamp to the 1d bucket", () => expect(bucketStart(90_000n, "1d")).toBe(86_400n));
});

describe("applyTradeToCandle", () => {
  it("opens a new candle from the first trade", () => {
    const candle = applyTradeToCandle(undefined, { price18: 100n, tokenAmountRaw: 5n, quoteAmountRaw: 500n });
    expect(candle).toEqual({
      open: 100n, high: 100n, low: 100n, close: 100n,
      volumeToken: 5n, volumeQuote: 500n, tradeCount: 1,
    });
  });

  it("tracks high/low/close and accumulates volume across trades", () => {
    let candle = applyTradeToCandle(undefined, { price18: 100n, tokenAmountRaw: 5n, quoteAmountRaw: 500n });
    candle = applyTradeToCandle(candle, { price18: 150n, tokenAmountRaw: 2n, quoteAmountRaw: 300n });
    candle = applyTradeToCandle(candle, { price18: 80n, tokenAmountRaw: 1n, quoteAmountRaw: 80n });
    expect(candle).toEqual({
      open: 100n, high: 150n, low: 80n, close: 80n,
      volumeToken: 8n, volumeQuote: 880n, tradeCount: 3,
    });
  });
});
