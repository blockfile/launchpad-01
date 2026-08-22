import { formatPrice18 } from "../lib/price";

const SORTS = ["newest", "price", "holders"] as const;
export type Sort = (typeof SORTS)[number];

export function parseSort(raw: string | undefined): Sort {
  return (SORTS as readonly string[]).includes(raw ?? "") ? (raw as Sort) : "newest";
}

const VALID_INTERVALS = new Set(["1m", "5m", "1h", "1d"]);
export type Interval = "1m" | "5m" | "1h" | "1d";
export function parseInterval(raw: string | undefined): Interval | undefined {
  return raw && VALID_INTERVALS.has(raw) ? (raw as Interval) : undefined;
}

/** Structural row shape `toSummary` needs — deliberately not `typeof
 * tokens.$inferSelect` (that type only exists via the `ponder:schema` virtual
 * module). Any object with at least these fields satisfies it, including the
 * richer rows `src/api/index.ts` actually passes in. */
export interface TokenSummaryRow {
  address: string;
  name: string;
  symbol: string;
  logo: string;
  lastPrice18: bigint | null;
  supply: bigint;
  decimals: number;
  holderCount: number;
  launchTimestamp: bigint;
}

export function toSummary(row: TokenSummaryRow) {
  return {
    address: row.address,
    name: row.name,
    symbol: row.symbol,
    logo: row.logo,
    price: row.lastPrice18 !== null ? formatPrice18(row.lastPrice18) : null,
    // marketCap = price × supply / 10^decimals, formatted the same way price18
    // is — null pre-first-trade for the same reason `price` is null then. This
    // is the field C's Explore page (frontend spec §2.1) lists as a required
    // column that B's original draft omitted; agreed-contract addition, not
    // a denormalized column (computed here at read time from lastPrice18).
    // Divides by the token's own `decimals`, not a hardcoded 1e18 — every
    // launch token is 18-decimal today, but `supply` is a raw integer in the
    // token's native decimals, so hardcoding would silently misprice any
    // future non-18-decimal token instead of following its actual decimals.
    marketCap:
      row.lastPrice18 !== null
        ? formatPrice18((row.lastPrice18 * row.supply) / 10n ** BigInt(row.decimals))
        : null,
    holderCount: row.holderCount,
    launchTimestamp: row.launchTimestamp.toString(),
  };
}
