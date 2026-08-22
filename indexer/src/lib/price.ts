const Q96 = 1n << 96n;
const PRICE_SCALE = 10n ** 18n;

function shiftDecimal(value: bigint, exponent: number): bigint {
  if (exponent === 0) return value;
  return exponent > 0 ? value * 10n ** BigInt(exponent) : value / 10n ** BigInt(-exponent);
}

/** Converts a Uniswap V3 sqrtPriceX96 into a fixed-point "quote per token"
 * price scaled by 1e18. `isToken0` (from getLaunchedToken, never guessed)
 * says whether the LAUNCHED token is the pool's token0 — required because
 * sqrtPriceX96 always expresses token1-per-token0 raw units, regardless of
 * which side is "the launched token" and which is the WETH quote. */
export function sqrtPriceX96ToPrice18(
  sqrtPriceX96: bigint,
  isToken0: boolean,
  tokenDecimals: number,
  quoteDecimals: number,
): bigint {
  const rawFixed = (sqrtPriceX96 * sqrtPriceX96 * PRICE_SCALE) / (Q96 * Q96);
  const decimalShift = tokenDecimals - quoteDecimals;
  if (isToken0) return shiftDecimal(rawFixed, decimalShift);
  if (rawFixed === 0n) return 0n;
  return shiftDecimal(PRICE_SCALE * PRICE_SCALE, decimalShift) / rawFixed;
}

/** Formats a price18 fixed-point bigint as a decimal string, e.g.
 * `2_000000000000000000n -> "2.000000000000000000"`. Storage stays bigint;
 * this only runs at the API response boundary. */
export function formatPrice18(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / PRICE_SCALE;
  const frac = (abs % PRICE_SCALE).toString().padStart(18, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}
