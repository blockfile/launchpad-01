import { z } from "zod";

const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
// B's uint256-safe wire contract: every bigint-backed column (amounts, prices,
// supply, block numbers/timestamps) is a decimal string on the wire, never a
// JSON number/float. Only small bounded integers (counts, bps, fee tiers) stay
// JSON numbers. See indexer spec's "Wire-format contract" note.
const decimalString = z.string();

// Shared by every route built on B's `toSummary()` helper (`/tokens`,
// `/tokens/:address`, `/search`) — verified against
// `indexer/src/api/helpers.ts`'s `toSummary()`, which returns exactly these
// eight fields. Only `/tokens` additionally runs each row through
// `attach24hStats()` (see `indexer/src/api/index.ts`), which is what adds
// `volume24h`/`priceChangeBps24h` — `/tokens/:address` and `/search` do NOT
// call `attach24hStats`, so those two fields must not be required there.
const tokenSummarySchema = z.object({
  address: evmAddress,
  name: z.string(),
  symbol: z.string(),
  logo: z.string(),
  price: decimalString.nullable(), // null pre-first-trade
  marketCap: decimalString.nullable(), // null pre-first-trade (needs a price to compute)
  holderCount: z.number().int().nonnegative(),
  launchTimestamp: z.string(),
});

export const tokenListItemSchema = tokenSummarySchema.extend({
  volume24h: decimalString,
  priceChangeBps24h: z.number().nullable(),
});
export type TokenListItem = z.infer<typeof tokenListItemSchema>;

export const tokensPageSchema = z.object({
  items: z.array(tokenListItemSchema),
  nextCursor: z.string().nullable(), // always present — B never omits this key, even on the last page
});
export type TokensPage = z.infer<typeof tokensPageSchema>;

export const socialsSchema = z.object({
  twitter: z.string(),
  telegram: z.string(),
  discord: z.string(),
  website: z.string(),
  farcaster: z.string(),
});

export const tokenDetailSchema = tokenSummarySchema.extend({
  description: z.string(),
  socials: socialsSchema,
  deployer: evmAddress,
  // NOTE: no `feeWallet` — B cannot derive it from any event it handles (its
  // own spec's "Known limitation, accepted"), and no C page reads one back
  // from B (the Launch form only ever *writes* a feeWallet as a call arg).
  poolAddress: evmAddress,
  pairedToken: evmAddress,
  poolFee: z.number().int(),
  supply: decimalString,
  dexId: decimalString,
  launchConfigId: decimalString,
  restrictionsEndBlock: decimalString,
  graduationThreshold: decimalString,
});
export type TokenDetail = z.infer<typeof tokenDetailSchema>;

export const candleSchema = z.object({
  bucketStart: z.string(),
  open: decimalString,
  high: decimalString,
  low: decimalString,
  close: decimalString,
  volumeToken: decimalString,
  volumeQuote: decimalString,
  tradeCount: z.number().int(),
});
export type Candle = z.infer<typeof candleSchema>;
export const candlesResponseSchema = z.object({
  interval: z.enum(["1m", "5m", "1h", "1d"]),
  items: z.array(candleSchema),
});
export type CandlesResponse = z.infer<typeof candlesResponseSchema>;
/** Chart-ready shape `PriceChart` actually feeds `lightweight-charts` (which
 * requires plain numbers) — a client-side parse of the wire's decimal
 * strings, never the wire shape itself. See `toChartCandles` in Task 10. */
export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const tradeSchema = z.object({
  txHash: z.string(),
  logIndex: z.number().int(),
  blockTimestamp: z.string(),
  side: z.enum(["buy", "sell"]),
  traderAddress: evmAddress,
  tokenAmountRaw: decimalString,
  quoteAmountRaw: decimalString,
  price: decimalString,
});
export const tradesPageSchema = z.object({
  items: z.array(tradeSchema),
  nextCursor: z.string().nullable(),
});
export type TradesPage = z.infer<typeof tradesPageSchema>;

export const holderSchema = z.object({ address: evmAddress, balance: decimalString, pct: z.number() });
export const holdersPageSchema = z.object({
  items: z.array(holderSchema),
  nextCursor: z.string().nullable(),
  totalHolders: z.number().int(),
});
export type HoldersPage = z.infer<typeof holdersPageSchema>;

// Matches B's real `/search` handler (`indexer/src/api/index.ts`), which maps
// every result — both the address-hit branch and the name/symbol ILIKE
// branch — through the same `toSummary()` helper as `/tokens`. The brief's
// original draft only required {address, name, symbol, logo}; that undersells
// what B actually sends (price/marketCap/holderCount/launchTimestamp too),
// so this reuses `tokenSummarySchema` to match B's real payload exactly.
export const searchResultsSchema = z.object({
  items: z.array(tokenSummarySchema),
});
export type SearchResults = z.infer<typeof searchResultsSchema>;

// All-time global counters (not a 24h window — B's /stats is a running total;
// windowed volume/change already lives on /tokens and /tokens/:addr/candles).
export const statsSchema = z.object({
  tokensLaunched: z.number().int(),
  totalVolumeQuote: decimalString,
  totalTrades: z.number().int(),
});
export type Stats = z.infer<typeof statsSchema>;

export const launchConfigsSchema = z.object({
  launchConfigIds: z.array(z.number().int()),
  dexIds: z.array(z.number().int()),
});
export type LaunchConfigs = z.infer<typeof launchConfigsSchema>;

export const holdingsSchema = z.object({
  items: z.array(
    z.object({
      tokenAddress: evmAddress,
      symbol: z.string(),
      name: z.string(),
      logo: z.string(),
      balance: decimalString,
      valueEth: decimalString.nullable(), // null pre-first-trade, same rule as tokenListItemSchema.price
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type Holdings = z.infer<typeof holdingsSchema>;
