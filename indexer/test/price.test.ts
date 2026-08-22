import { describe, expect, it } from "vitest";
import { formatPrice18, sqrtPriceX96ToPrice18 } from "../src/lib/price";

const Q96 = 1n << 96n;

describe("sqrtPriceX96ToPrice18", () => {
  it("is 1.0 when raw price is 1, decimals match, token is token0", () => {
    expect(sqrtPriceX96ToPrice18(Q96, true, 18, 18)).toBe(10n ** 18n);
  });
  it("is 1.0 when raw price is 1, decimals match, token is token1 (reciprocal of 1 is 1)", () => {
    expect(sqrtPriceX96ToPrice18(Q96, false, 18, 18)).toBe(10n ** 18n);
  });
  it("adjusts for a token0 with fewer decimals than the quote", () => {
    // raw ratio is 1 (sqrtPrice=1); price_human = rawPrice * 10^(6-18) = 1e-12;
    // price18 is that human price scaled back up by the function's own 1e18
    // fixed-point, i.e. 1e-12 * 1e18 = 1e6.
    expect(sqrtPriceX96ToPrice18(Q96, true, 6, 18)).toBe(1_000_000n);
  });

  it("adjusts for a token1 (reciprocal branch) with fewer decimals than the quote", () => {
    // Independent derivation, not read off the implementation:
    // sqrtPriceX96 always expresses raw token1-per-token0 (rawPrice = 1 here,
    // since sqrtPriceX96 = Q96). By definition, 1 raw token0 unit has the same
    // value as `rawPrice` raw token1 units, so:
    //   H(token0 -> token1) = rawPrice * 10^(d0-d1)
    // The launched token here is token1 (isToken0=false), so the quantity we
    // actually want is the reciprocal, H(token1 -> token0):
    //   H(token1 -> token0) = 1 / H(token0 -> token1) = (1/rawPrice) * 10^(d1-d0)
    // d1 (launched token1's decimals, `tokenDecimals`) = 6, d0 (quote token0's
    // decimals, `quoteDecimals`) = 18, rawPrice = 1:
    //   H(token1 -> token0) = 1 * 10^(6-18) = 1e-12
    // price18 scales that human price back up by the function's 1e18 fixed
    // point: 1e-12 * 1e18 = 1e6.
    expect(sqrtPriceX96ToPrice18(Q96, false, 6, 18)).toBe(1_000_000n);
  });
});

describe("formatPrice18", () => {
  it("formats a whole number", () => expect(formatPrice18(2n * 10n ** 18n)).toBe("2.000000000000000000"));
  it("formats the smallest positive fixed-point unit", () => expect(formatPrice18(1n)).toBe("0.000000000000000001"));
});
