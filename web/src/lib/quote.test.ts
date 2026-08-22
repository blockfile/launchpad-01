import { describe, expect, it } from "vitest";
import { spotAmountOut, applySlippage } from "./quote";

describe("spotAmountOut", () => {
  it("computes token-out for a WETH-in buy when the token is token0 (price is WETH per token)", () => {
    // sqrtPriceX96 for price = 4 (WETH per token, i.e. 1 token = 4 WETH): sqrt(4) * 2^96
    const sqrtPriceX96 = 2n * 2n ** 96n;
    const amountIn = 1000n; // WETH wei
    // fee-adjusted input: 1000 * (1_000_000 - 10_000) / 1_000_000 = 990; tokens out = weth_in / price = 990/4 = 247 (integer)
    const out = spotAmountOut({ sqrtPriceX96, isToken0: true, tokenInIsPaired: true, amountIn, poolFeePpm: 10_000 });
    expect(out).toBe(247n);
  });

  it("computes WETH-out for a token-in sell, the inverse direction", () => {
    const sqrtPriceX96 = 2n * 2n ** 96n;
    // fee-adjusted input 990 tokens * price(4 weth/token) = 3960 wei
    const out = spotAmountOut({ sqrtPriceX96, isToken0: true, tokenInIsPaired: false, amountIn: 1000n, poolFeePpm: 10_000 });
    expect(out).toBe(3960n);
  });

  it("computes our-token-out for a paired-in buy when our token is token1 (paired asset is token0)", () => {
    // isToken0=false: paired asset is token0, our token is token1. Buying = paired
    // (token0) in, our token (token1) out => multiply by price. netIn 990 * 4 = 3960.
    const sqrtPriceX96 = 2n * 2n ** 96n;
    const out = spotAmountOut({ sqrtPriceX96, isToken0: false, tokenInIsPaired: true, amountIn: 1000n, poolFeePpm: 10_000 });
    expect(out).toBe(3960n);
  });

  it("computes paired-out for a token-in sell when our token is token1 (inverse of the above)", () => {
    // isToken0=false selling: our token (token1) in, paired (token0) out => divide
    // by price. netIn 990 / 4 = 247 (integer).
    const sqrtPriceX96 = 2n * 2n ** 96n;
    const out = spotAmountOut({ sqrtPriceX96, isToken0: false, tokenInIsPaired: false, amountIn: 1000n, poolFeePpm: 10_000 });
    expect(out).toBe(247n);
  });
});

describe("applySlippage", () => {
  it("subtracts the slippage bps from an estimate", () => {
    expect(applySlippage(1000n, 100)).toBe(990n); // 1% slippage
  });

  it("returns 0 for a 0 estimate (the panel must gate on estimate>0, never send this)", () => {
    expect(applySlippage(0n, 100)).toBe(0n);
  });
});
