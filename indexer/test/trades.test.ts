import { describe, expect, it } from "vitest";
import { deriveTrade } from "../src/lib/trades";

const Q96 = 1n << 96n;

describe("deriveTrade", () => {
  it("is a buy when the launched token (token1) leaves the pool", () => {
    const trade = deriveTrade(
      { amount0: 1_000_000_000_000_000_000n, amount1: -500_000_000_000_000_000_000n, sqrtPriceX96: Q96 },
      false,
      18,
      18,
    );
    expect(trade.side).toBe("buy");
    expect(trade.tokenAmountRaw).toBe(500_000_000_000_000_000_000n);
    expect(trade.quoteAmountRaw).toBe(1_000_000_000_000_000_000n);
  });

  it("is a sell when the launched token (token0) enters the pool", () => {
    const trade = deriveTrade(
      { amount0: 500_000_000_000_000_000_000n, amount1: -1_000_000_000_000_000_000n, sqrtPriceX96: Q96 },
      true,
      18,
      18,
    );
    expect(trade.side).toBe("sell");
    expect(trade.tokenAmountRaw).toBe(500_000_000_000_000_000_000n);
    expect(trade.quoteAmountRaw).toBe(1_000_000_000_000_000_000n);
  });

  it("is a buy when the launched token (token0) leaves the pool", () => {
    const trade = deriveTrade(
      { amount0: -500_000_000_000_000_000_000n, amount1: 1_000_000_000_000_000_000n, sqrtPriceX96: Q96 },
      true,
      18,
      18,
    );
    expect(trade.side).toBe("buy");
    expect(trade.tokenAmountRaw).toBe(500_000_000_000_000_000_000n);
    expect(trade.quoteAmountRaw).toBe(1_000_000_000_000_000_000n);
  });

  it("is a sell when the launched token (token1) enters the pool", () => {
    const trade = deriveTrade(
      { amount0: -1_000_000_000_000_000_000n, amount1: 500_000_000_000_000_000_000n, sqrtPriceX96: Q96 },
      false,
      18,
      18,
    );
    expect(trade.side).toBe("sell");
    expect(trade.tokenAmountRaw).toBe(500_000_000_000_000_000_000n);
    expect(trade.quoteAmountRaw).toBe(1_000_000_000_000_000_000n);
  });
});
