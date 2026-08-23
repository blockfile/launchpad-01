import { useState } from "react";
import { useParams } from "react-router";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import { motion } from "framer-motion";
import { FaXTwitter, FaTelegram, FaDiscord, FaGlobe } from "react-icons/fa6";
import { SiFarcaster } from "react-icons/si";
import type { IconType } from "react-icons";
import {
  LuCopy,
  LuCheck,
  LuUsers,
  LuArrowUpRight,
  LuArrowDownRight,
} from "react-icons/lu";
import { fetchToken, fetchCandles, fetchTrades, fetchHolders } from "../lib/indexer/client";
import { PriceChart } from "../components/PriceChart";
import { TradePanel } from "../components/TradePanel";
import { formatAge, formatPct, shortAddress } from "../lib/format";
import { safeImageSrc, safeLinkHref } from "../lib/safeUrl";
import { onLogoError, formatCompactAmount } from "../components/TokenCard";

type Timeframe = "1m" | "5m" | "1h" | "1d";
type Tab = "trades" | "holders";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "1h", "1d"];
const TABS: { key: Tab; label: string }[] = [
  { key: "trades", label: "Trades" },
  { key: "holders", label: "Holders" },
];

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

// A holder `balance` (and a trade's `tokenAmountRaw`, and the token `supply`)
// from B is RAW 18-dec wei — unlike price/marketCap, which arrive already
// human-decimal — so it MUST go through `formatEther` first. Rendering it via
// `formatDecimalString` printed the raw wei integer, i.e. every value 10^18×
// too large.
function formatBalance(raw: string): string {
  return Number(formatEther(BigInt(raw))).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

// Holder share-of-supply is already a plain percentage (not bps, unlike
// priceChangeBps24h), and — unlike a price change — is never negative, so
// this skips `formatPct`'s signed "+50.00%" prefix.
function formatSharePct(pct: number): string {
  return `${pct.toFixed(2)}%`;
}

// The header's change chip. `/tokens/:address` carries no `priceChangeBps24h`
// (only the `/tokens` list does — see schema), so the change is derived,
// presentation-only, from the already-fetched candles for the active interval:
// oldest bucket's open → newest bucket's close. Null (empty / degenerate) ⇒ a
// neutral "New" chip rather than a misleading 0%.
function computeChangePct(candles: { open: string; close: string }[]): number | null {
  if (candles.length === 0) return null;
  const first = Number(candles[0].open);
  const last = Number(candles[candles.length - 1].close);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
  return ((last - first) / first) * 100;
}

/** Emerald/rose directional change pill (or a neutral "New" when unknown). */
function ChangeChip({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="chip border-border !bg-surface-2 text-xs text-ink-muted">New</span>;
  }
  const up = pct >= 0;
  return (
    <span
      className={`chip !gap-1 border-transparent text-sm font-semibold tnum ${
        up ? "!bg-emerald/12 text-emerald" : "!bg-rose/12 text-rose"
      }`}
    >
      {up ? <LuArrowUpRight /> : <LuArrowDownRight />}
      {formatPct(pct)}
    </span>
  );
}

/** A small copy-to-clipboard control for the truncated contract address. The
 * clipboard write is best-effort (guarded — jsdom / insecure origins have no
 * `navigator.clipboard`); a brief check-mark confirms the copy. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable — nothing to do */
        }
      }}
      className="inline-flex rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {copied ? <LuCheck className="text-sm text-emerald" /> : <LuCopy className="text-sm" />}
    </button>
  );
}

const SOCIAL_META: { key: "twitter" | "telegram" | "discord" | "website" | "farcaster"; label: string; Icon: IconType }[] = [
  { key: "twitter", label: "Twitter", Icon: FaXTwitter },
  { key: "telegram", label: "Telegram", Icon: FaTelegram },
  { key: "discord", label: "Discord", Icon: FaDiscord },
  { key: "website", label: "Website", Icon: FaGlobe },
  { key: "farcaster", label: "Farcaster", Icon: SiFarcaster },
];

/** One labelled stat in an info row (mono value on a faint caption). */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium text-ink">
        {children}
      </span>
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
  const socialLinks = socials
    ? SOCIAL_META.map(({ key, label, Icon }) => ({
        label,
        Icon,
        href: safeLinkHref(socials[key]),
      })).filter((entry): entry is { label: string; Icon: IconType; href: string } => entry.href !== null)
    : [];

  const changePct = computeChangePct(candlesQuery.data?.items ?? []);
  const marketCap = formatCompactAmount(token?.marketCap ?? null);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      {tokenQuery.isError && (
        <p role="alert" className="surface-card p-4 text-rose">
          Failed to load token.
        </p>
      )}

      {/* ── Header strip ──────────────────────────────────────────────────── */}
      {tokenQuery.isLoading && !token && (
        <div className="surface-card flex items-center gap-4 p-4 sm:p-5">
          <div className="h-14 w-14 shrink-0 animate-pulse rounded-2xl bg-surface-2" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-40 animate-pulse rounded bg-surface-2" />
            <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
          </div>
          <div className="h-8 w-28 animate-pulse rounded bg-surface-2" />
        </div>
      )}

      {token && (
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="surface-card p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            {/* Identity */}
            <div className="flex min-w-0 items-center gap-4">
              <img
                src={safeImageSrc(token.logo)}
                alt=""
                onError={onLogoError}
                className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-1 ring-border"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h1 className="truncate text-xl font-bold tracking-tight text-ink sm:text-2xl">
                    {token.name}
                  </h1>
                  <span className="font-mono text-xs uppercase tracking-wide text-ink-muted">
                    {token.symbol}
                  </span>
                  <span className="chip border-accent/25 !bg-accent/10 !px-2 !py-0.5 text-[0.62rem] font-semibold uppercase tracking-wider text-accent">
                    V3
                  </span>
                  <span className="chip border-border !bg-surface-2 !px-2 !py-0.5 text-[0.62rem] uppercase tracking-wider text-ink-muted">
                    Robinhood Chain
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="font-mono text-xs text-ink-faint">{shortAddress(address ?? "")}</span>
                  <CopyButton value={address ?? ""} label="Copy contract address" />
                </div>
                {socialLinks.length > 0 && (
                  <div className="mt-2 flex items-center gap-1">
                    {socialLinks.map(({ label, Icon, href }) => (
                      <a
                        key={label}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        aria-label={label}
                        className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
                      >
                        <Icon className="text-sm" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Price + stats */}
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <div className="flex items-center gap-2">
                <span className="tnum text-2xl font-bold text-ink sm:text-3xl">
                  {formatDecimalString(token.price)}
                </span>
                <ChangeChip pct={changePct} />
              </div>
              <div className="flex items-center gap-5 text-xs">
                <div className="text-right">
                  <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">
                    Market cap
                  </div>
                  <div className="tnum text-sm font-semibold text-ink">{marketCap ?? "—"}</div>
                </div>
                <div className="text-right">
                  <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">
                    Holders
                  </div>
                  <div className="tnum inline-flex items-center gap-1 text-sm font-semibold text-ink">
                    <LuUsers className="text-ink-muted" /> {token.holderCount}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.section>
      )}

      {/* ── Two-column terminal ───────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Left: chart + trades/holders */}
        <div className="min-w-0 space-y-6">
          <div className="surface-card p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-ink">Price</span>
              <div className="flex items-center gap-1 rounded-full border border-border bg-surface p-1">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
                    aria-pressed={timeframe === tf}
                    className={`tnum rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      timeframe === tf
                        ? "bg-surface-hover text-accent"
                        : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>
            <PriceChart candles={candlesQuery.data?.items ?? []} />
          </div>

          <div className="surface-card p-4 sm:p-5">
            <div className="mb-4 flex gap-1 border-b border-border">
              {TABS.map(({ key, label }) => {
                const active = tab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    aria-pressed={active}
                    className="relative px-4 py-2.5 text-sm font-medium transition-colors"
                  >
                    <span className={active ? "text-ink" : "text-ink-muted hover:text-ink"}>
                      {label}
                    </span>
                    {active && (
                      <motion.span
                        layoutId="trade-tab-underline"
                        className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-accent"
                        transition={{ type: "spring", stiffness: 380, damping: 30 }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              {tab === "trades" && (
                <>
                  <div className="overflow-x-auto scroll-slim">
                    <table className="w-full min-w-[30rem] text-sm">
                      <thead>
                        <tr className="text-left text-[0.68rem] uppercase tracking-wider text-ink-faint">
                          <th className="pb-2 font-medium">Side</th>
                          <th className="pb-2 font-medium">Amount</th>
                          <th className="pb-2 text-right font-medium">Price</th>
                          <th className="pb-2 text-right font-medium">Trader</th>
                          <th className="pb-2 text-right font-medium">Time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {trades.map((trade) => {
                          const buy = trade.side === "buy";
                          return (
                            <tr
                              key={`${trade.txHash}-${trade.logIndex}`}
                              className="transition-colors hover:bg-surface-2/50"
                            >
                              <td className="py-2">
                                <span
                                  className={`chip !gap-1 border-transparent !px-2 !py-0.5 text-[0.7rem] font-semibold capitalize ${
                                    buy ? "!bg-emerald/12 text-emerald" : "!bg-rose/12 text-rose"
                                  }`}
                                >
                                  {buy ? <LuArrowUpRight /> : <LuArrowDownRight />}
                                  {trade.side}
                                </span>
                              </td>
                              <td className="tnum py-2 text-ink-muted">
                                {formatBalance(trade.tokenAmountRaw)}
                              </td>
                              <td className="tnum py-2 text-right text-ink">
                                {formatDecimalString(trade.price)}
                              </td>
                              <td className="py-2 text-right font-mono text-xs text-ink-muted">
                                {shortAddress(trade.traderAddress)}
                              </td>
                              <td className="py-2 text-right text-ink-faint">
                                {formatAge(Number(trade.blockTimestamp))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {trades.length === 0 && !tradesQuery.isLoading && (
                    <p className="py-8 text-center text-sm text-ink-muted">No trades yet.</p>
                  )}
                  {tradesQuery.hasNextPage && (
                    <div className="mt-4 flex justify-center">
                      <button
                        type="button"
                        onClick={() => void tradesQuery.fetchNextPage()}
                        disabled={tradesQuery.isFetchingNextPage}
                        className="btn-ghost text-xs disabled:opacity-40"
                      >
                        {tradesQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  )}
                </>
              )}

              {tab === "holders" && (
                <>
                  <div className="overflow-x-auto scroll-slim">
                    <table className="w-full min-w-[26rem] text-sm">
                      <thead>
                        <tr className="text-left text-[0.68rem] uppercase tracking-wider text-ink-faint">
                          <th className="w-10 pb-2 font-medium">#</th>
                          <th className="pb-2 font-medium">Holder</th>
                          <th className="pb-2 text-right font-medium">Balance</th>
                          <th className="pb-2 pl-6 font-medium">Share</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {holders.map((holder, index) => (
                          <tr
                            key={holder.address}
                            className="transition-colors hover:bg-surface-2/50"
                          >
                            <td className="tnum py-2 text-ink-faint">{index + 1}</td>
                            <td className="py-2 font-mono text-xs text-ink-muted">
                              {shortAddress(holder.address)}
                            </td>
                            <td className="tnum py-2 text-right text-ink">
                              {formatBalance(holder.balance)}
                            </td>
                            <td className="py-2 pl-6">
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                                  <div
                                    className="h-full rounded-full bg-accent/70"
                                    style={{ width: `${Math.min(100, Math.max(0, holder.pct))}%` }}
                                  />
                                </div>
                                <span className="tnum w-14 text-right text-xs text-ink-muted">
                                  {formatSharePct(holder.pct)}
                                </span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {holders.length === 0 && !holdersQuery.isLoading && (
                    <p className="py-8 text-center text-sm text-ink-muted">No holders yet.</p>
                  )}
                  {holdersQuery.hasNextPage && (
                    <div className="mt-4 flex justify-center">
                      <button
                        type="button"
                        onClick={() => void holdersQuery.fetchNextPage()}
                        disabled={holdersQuery.isFetchingNextPage}
                        className="btn-ghost text-xs disabled:opacity-40"
                      >
                        {holdersQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </motion.div>
          </div>
        </div>

        {/* Right: sticky trade panel + token info */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <TradePanel
            tokenAddress={address as `0x${string}` | undefined}
            fallbackPoolAddress={token?.poolAddress as `0x${string}` | undefined}
          />

          {token && (
            <div className="surface-card p-4 sm:p-5">
              <h2 className="mb-3 text-sm font-semibold text-ink">About</h2>
              {token.description && (
                <p className="text-sm leading-relaxed text-ink-muted">{token.description}</p>
              )}
              <dl className="mt-4 divide-y divide-border border-y border-border">
                <InfoRow label="Total supply">
                  <span className="tnum">{formatBalance(token.supply)}</span>
                </InfoRow>
                <InfoRow label="Deployer">
                  {/* Full address on purpose (CSS-truncated): a shortened
                      "0x…"-with-ellipsis form would collide with the holders
                      table's identical top-holder address. */}
                  <span className="max-w-[8.5rem] truncate font-mono text-xs" title={token.deployer}>
                    {token.deployer}
                  </span>
                  <CopyButton value={token.deployer} label="Copy deployer address" />
                </InfoRow>
              </dl>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
