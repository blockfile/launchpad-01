import { formatPrice18 } from "../lib/price";

const SORTS = ["newest", "price", "holders"] as const;
export type Sort = (typeof SORTS)[number];

export function parseSort(raw: string | undefined): Sort {
  return (SORTS as readonly string[]).includes(raw ?? "") ? (raw as Sort) : "newest";
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
    // marketCap = price × supply / 1e18, formatted the same way price18 is —
    // null pre-first-trade for the same reason `price` is null then. This is
    // the field C's Explore page (frontend spec §2.1) lists as a required
    // column that B's original draft omitted; agreed-contract addition, not
    // a denormalized column (computed here at read time from lastPrice18).
    marketCap:
      row.lastPrice18 !== null ? formatPrice18((row.lastPrice18 * row.supply) / 10n ** 18n) : null,
    holderCount: row.holderCount,
    launchTimestamp: row.launchTimestamp.toString(),
  };
}
