/** bps change between two price18 fixed-point values. Safe to convert to a
 * plain Number here (unlike raw wei amounts) — a bps ratio is always small
 * and bounded, never the wei-scale figure the "never a float" rule guards. */
export function priceChangeBps(previousPrice18: bigint, currentPrice18: bigint): number | null {
  if (previousPrice18 <= 0n) return null;
  return Number(((currentPrice18 - previousPrice18) * 10_000n) / previousPrice18);
}
