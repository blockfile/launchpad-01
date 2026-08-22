import { useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchToken, fetchCandles, fetchTrades, fetchHolders } from "../lib/indexer/client";
import { PriceChart } from "../components/PriceChart";
import { formatAge, shortAddress } from "../lib/format";

type Timeframe = "1m" | "5m" | "1h" | "1d";
type Tab = "trades" | "holders";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "1h", "1d"];

// Same rationale as Explore's own copy of this helper (see Explore.tsx):
// price/marketCap/trade-price/holder-balance are already human-decimal
// strings from B, so this is just a thousands-separator pass, never
// `formatEth` (which expects wei bigints). Kept local rather than shared —
// every route owning its own small formatters is the established pattern
// here rather than growing a shared "indexer number formatting" module.
function formatDecimalString(value: string | null): string {
  if (value == null) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

// Holder share-of-supply is already a plain percentage (not bps, unlike
// priceChangeBps24h), and — unlike a price change — is never negative, so
// this skips `formatPct`'s signed "+50.00%" prefix.
function formatSharePct(pct: number): string {
  return `${pct.toFixed(2)}%`;
}

/**
 * Placeholder slot for Task 11's real buy/sell panel. This task only shells
 * the trade page layout against B's read endpoints — quote/swap logic is
 * explicitly out of scope here.
 */
function TradePanel() {
  return (
    <div
      data-testid="trade-panel-placeholder"
      className="h-fit rounded border border-slate-700 p-4 text-sm text-slate-500"
    >
      Buy / sell — coming soon.
    </div>
  );
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
  const tradesQuery = useQuery({
    queryKey: ["trades", address],
    queryFn: () => fetchTrades(address!),
    enabled: Boolean(address),
  });
  const holdersQuery = useQuery({
    queryKey: ["holders", address],
    queryFn: () => fetchHolders(address!),
    enabled: Boolean(address),
  });

  const token = tokenQuery.data;
  const socials = token?.socials;

  return (
    <div className="grid grid-cols-1 gap-6 p-6 text-slate-100 lg:grid-cols-[2fr_1fr]">
      <div>
        {tokenQuery.isLoading && <p>Loading token…</p>}
        {tokenQuery.isError && <p role="alert">Failed to load token.</p>}

        {token && (
          <div className="mb-4">
            <div className="flex items-center gap-3">
              <img src={token.logo} alt="" className="h-10 w-10 rounded-full" />
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
            {socials && (
              <div className="mt-2 flex gap-3 text-sm text-slate-400">
                {socials.twitter && <a href={socials.twitter}>Twitter</a>}
                {socials.telegram && <a href={socials.telegram}>Telegram</a>}
                {socials.discord && <a href={socials.discord}>Discord</a>}
                {socials.website && <a href={socials.website}>Website</a>}
                {socials.farcaster && <a href={socials.farcaster}>Farcaster</a>}
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
                {(tradesQuery.data?.items ?? []).map((trade) => (
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
          )}

          {tab === "holders" && (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-slate-400">
                  <th className="pb-2 font-normal">Holder</th>
                  <th className="pb-2 font-normal">Balance</th>
                  <th className="pb-2 font-normal">% supply</th>
                </tr>
              </thead>
              <tbody>
                {(holdersQuery.data?.items ?? []).map((holder) => (
                  <tr key={holder.address}>
                    <td>{shortAddress(holder.address)}</td>
                    <td>{formatDecimalString(holder.balance)}</td>
                    <td>{formatSharePct(holder.pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <TradePanel />
    </div>
  );
}
