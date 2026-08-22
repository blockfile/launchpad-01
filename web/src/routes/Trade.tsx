import { useState } from "react";
import { useParams } from "react-router";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import { fetchToken, fetchCandles, fetchTrades, fetchHolders } from "../lib/indexer/client";
import { PriceChart } from "../components/PriceChart";
import { TradePanel } from "../components/TradePanel";
import { formatAge, shortAddress } from "../lib/format";
import { safeImageSrc, safeLinkHref } from "../lib/safeUrl";

type Timeframe = "1m" | "5m" | "1h" | "1d";
type Tab = "trades" | "holders";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "1h", "1d"];

// Same rationale as Explore's own copy of this helper (see Explore.tsx):
// price/marketCap/trade-price are already human-decimal strings from B, so this
// is just a thousands-separator pass, never `formatEther` (which expects wei
// bigints). Kept local rather than shared — every route owning its own small
// formatters is the established pattern here rather than growing a shared
// "indexer number formatting" module. NOTE: a holder `balance` is NOT one of
// these — it is RAW 18-dec wei on the wire (see `formatBalance` below).
function formatDecimalString(value: string | null): string {
  if (value == null) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

// A holder `balance` from B's `/tokens/:address/holders` is RAW 18-dec wei
// (unlike price/marketCap, which arrive already human-decimal), so it MUST go
// through `formatEther` first — the same rule Portfolio's own `formatBalance`
// applies. Rendering it via `formatDecimalString` printed the raw wei integer,
// i.e. every balance 10^18× too large.
function formatBalance(raw: string): string {
  return Number(formatEther(BigInt(raw))).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

// Holder share-of-supply is already a plain percentage (not bps, unlike
// priceChangeBps24h), and — unlike a price change — is never negative, so
// this skips `formatPct`'s signed "+50.00%" prefix.
function formatSharePct(pct: number): string {
  return `${pct.toFixed(2)}%`;
}

export default function Trade() {
  const { address } = useParams<{ address: string }>();
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [tab, setTab] = useState<Tab>("trades");

  const tokenQuery = useQuery({
    queryKey: ["token", address],
    queryFn: () => fetchToken(address!),
    enabled: Boolean(address),
  });
  const candlesQuery = useQuery({
    queryKey: ["candles", address, timeframe],
    queryFn: () => fetchCandles(address!, timeframe),
    enabled: Boolean(address),
  });
  const tradesQuery = useInfiniteQuery({
    queryKey: ["trades", address],
    queryFn: ({ pageParam }) => fetchTrades(address!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(address),
  });
  const holdersQuery = useInfiniteQuery({
    queryKey: ["holders", address],
    queryFn: ({ pageParam }) => fetchHolders(address!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(address),
  });

  const trades = tradesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const holders = holdersQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const token = tokenQuery.data;
  const socials = token?.socials;
  // Socials are attacker-set (anyone can `launchToken`): only render an anchor
  // for a value that survives the `https:`/`ipfs:` allow-list — a
  // `javascript:`/`data:`/blank value yields no link at all.
  const socialLinks: Array<[string, string]> = socials
    ? (
        [
          ["Twitter", socials.twitter],
          ["Telegram", socials.telegram],
          ["Discord", socials.discord],
          ["Website", socials.website],
          ["Farcaster", socials.farcaster],
        ] as Array<[string, string]>
      )
        .map(([label, raw]) => [label, safeLinkHref(raw)] as [string, string | null])
        .filter((entry): entry is [string, string] => entry[1] !== null)
    : [];

  return (
    <div className="grid grid-cols-1 gap-6 p-6 text-slate-100 lg:grid-cols-[2fr_1fr]">
      <div>
        {tokenQuery.isLoading && <p>Loading token…</p>}
        {tokenQuery.isError && <p role="alert">Failed to load token.</p>}

        {token && (
          <div className="mb-4">
            <div className="flex items-center gap-3">
              <img src={safeImageSrc(token.logo)} alt="" className="h-10 w-10 rounded-full" />
              <div>
                <h1 className="text-xl font-semibold">{token.name}</h1>
                <div className="text-slate-400">{token.symbol}</div>
              </div>
              <div className="ml-auto text-right">
                <div>{formatDecimalString(token.price)}</div>
                <div className="text-slate-400">{token.holderCount} holders</div>
              </div>
            </div>
            <p className="mt-2 text-sm text-slate-400">{token.description}</p>
            {socialLinks.length > 0 && (
              <div className="mt-2 flex gap-3 text-sm text-slate-400">
                {socialLinks.map(([label, href]) => (
                  <a key={label} href={href} target="_blank" rel="noopener noreferrer nofollow">
                    {label}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mb-2 flex gap-2 text-sm">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={timeframe === tf ? "font-semibold text-white" : "text-slate-400"}
            >
              {tf}
            </button>
          ))}
        </div>

        <PriceChart candles={candlesQuery.data?.items ?? []} />

        <div className="mt-4">
          <div className="mb-2 flex gap-4 border-b border-slate-800 text-sm">
            <button
              type="button"
              onClick={() => setTab("trades")}
              className={
                tab === "trades"
                  ? "border-b-2 border-white pb-2 font-semibold text-white"
                  : "pb-2 text-slate-400"
              }
            >
              Recent trades
            </button>
            <button
              type="button"
              onClick={() => setTab("holders")}
              className={
                tab === "holders"
                  ? "border-b-2 border-white pb-2 font-semibold text-white"
                  : "pb-2 text-slate-400"
              }
            >
              Holders
            </button>
          </div>

          {tab === "trades" && (
            <>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-slate-400">
                    <th className="pb-2 font-normal">Side</th>
                    <th className="pb-2 font-normal">Trader</th>
                    <th className="pb-2 font-normal">Price</th>
                    <th className="pb-2 font-normal">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <tr key={`${trade.txHash}-${trade.logIndex}`}>
                      <td className={trade.side === "buy" ? "text-emerald-400" : "text-rose-400"}>
                        {trade.side}
                      </td>
                      <td>{shortAddress(trade.traderAddress)}</td>
                      <td>{formatDecimalString(trade.price)}</td>
                      <td>{formatAge(Number(trade.blockTimestamp))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {tradesQuery.hasNextPage && (
                <div className="mt-3 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void tradesQuery.fetchNextPage()}
                    disabled={tradesQuery.isFetchingNextPage}
                    className="rounded border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
                  >
                    {tradesQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}

          {tab === "holders" && (
            <>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-slate-400">
                    <th className="pb-2 font-normal">Holder</th>
                    <th className="pb-2 font-normal">Balance</th>
                    <th className="pb-2 font-normal">% supply</th>
                  </tr>
                </thead>
                <tbody>
                  {holders.map((holder) => (
                    <tr key={holder.address}>
                      <td>{shortAddress(holder.address)}</td>
                      <td>{formatBalance(holder.balance)}</td>
                      <td>{formatSharePct(holder.pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {holdersQuery.hasNextPage && (
                <div className="mt-3 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void holdersQuery.fetchNextPage()}
                    disabled={holdersQuery.isFetchingNextPage}
                    className="rounded border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
                  >
                    {holdersQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <TradePanel
        tokenAddress={address as `0x${string}` | undefined}
        fallbackPoolAddress={token?.poolAddress as `0x${string}` | undefined}
      />
    </div>
  );
}
