import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { LuTrendingUp, LuTrendingDown, LuRocket, LuActivity } from "react-icons/lu";
import { fetchStats, fetchTokens } from "../../lib/indexer/client";
import { formatPct } from "../../lib/format";

interface Chip {
  key: string;
  icon: ReactNode;
  label: string;
  tone: "up" | "down" | "gold" | "muted";
}

const TONE_CLASS: Record<Chip["tone"], string> = {
  up: "text-accent-bright",
  down: "text-rose",
  gold: "text-gold",
  muted: "text-ink-muted",
};

// Shown when the indexer (B) is unavailable — a tasteful, obviously-live set so
// the bar never reads as broken or empty.
const PLACEHOLDER: Chip[] = [
  { key: "p1", icon: <LuRocket />, label: "New launches every few minutes", tone: "gold" },
  { key: "p2", icon: <LuTrendingUp />, label: "Trending: DEGEN +18.4%", tone: "up" },
  { key: "p3", icon: <LuActivity />, label: "Live market data", tone: "muted" },
  { key: "p4", icon: <LuTrendingDown />, label: "WOJAK -6.1%", tone: "down" },
  { key: "p5", icon: <LuTrendingUp />, label: "PONS +2.5%", tone: "up" },
];

function compact(value: number): string {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function useTickerChips(): Chip[] {
  const statsQuery = useQuery({
    queryKey: ["stats"],
    queryFn: fetchStats,
    staleTime: 30_000,
    retry: false,
  });
  const tokensQuery = useQuery({
    // Distinct from Explore's ["tokens", sort] INFINITE query — a plain useQuery
    // sharing that key would read an incompatible ({pages}) cache shape and the
    // token chips would silently vanish. This key is the ticker's alone.
    queryKey: ["ticker", "newest-tokens"],
    queryFn: () => fetchTokens({ sort: "newest" }),
    staleTime: 30_000,
    retry: false,
  });

  return useMemo(() => {
    const chips: Chip[] = [];
    const stats = statsQuery.data;
    if (stats) {
      chips.push(
        { key: "s-launched", icon: <LuRocket />, label: `${compact(stats.tokensLaunched)} tokens launched`, tone: "gold" },
        { key: "s-trades", icon: <LuActivity />, label: `${compact(stats.totalTrades)} trades`, tone: "muted" },
        {
          key: "s-vol",
          icon: <LuTrendingUp />,
          label: `${compact(Number(stats.totalVolumeQuote))} total volume`,
          tone: "up",
        },
      );
    }
    for (const t of tokensQuery.data?.items ?? []) {
      const bps = t.priceChangeBps24h;
      const pct = bps == null ? null : bps / 100;
      const tone: Chip["tone"] = pct == null ? "muted" : pct >= 0 ? "up" : "down";
      const change = pct == null ? "new" : formatPct(pct);
      chips.push({
        key: `t-${t.address}`,
        icon: pct != null && pct < 0 ? <LuTrendingDown /> : <LuTrendingUp />,
        label: `${t.symbol} ${change}`,
        tone,
      });
    }
    return chips.length > 0 ? chips : PLACEHOLDER;
  }, [statsQuery.data, tokensQuery.data]);
}

function ChipRow({ chips, ariaHidden }: { chips: Chip[]; ariaHidden?: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-2 pr-2" aria-hidden={ariaHidden}>
      {chips.map((chip) => (
        <span key={chip.key} className="chip">
          <span className={TONE_CLASS[chip.tone]}>{chip.icon}</span>
          <span className="tnum text-ink">{chip.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Top ticker bar: an auto-scrolling marquee of live activity chips wired to B's
 * `/stats` + newest `/tokens` where cheap, with a tasteful placeholder set when
 * B is unavailable. The chip list is rendered twice and the row is translated
 * -50% on a linear loop for a seamless scroll; `prefers-reduced-motion` drops
 * the animation and lets the row scroll manually instead.
 */
export function Ticker() {
  const reduce = useReducedMotion();
  const chips = useTickerChips();
  // Duration scales with chip count so density stays readable regardless of load.
  const duration = Math.max(18, chips.length * 3.2);

  return (
    <div className="relative flex items-center gap-3 border-b border-border bg-bg-2/60 px-4 py-2 backdrop-blur">
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        Live
      </span>

      <div className="relative flex-1 overflow-hidden">
        {reduce ? (
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            <ChipRow chips={chips} />
          </div>
        ) : (
          <motion.div
            className="flex w-max gap-2"
            animate={{ x: ["0%", "-50%"] }}
            transition={{ duration, ease: "linear", repeat: Infinity }}
          >
            <ChipRow chips={chips} />
            <ChipRow chips={chips} ariaHidden />
          </motion.div>
        )}
      </div>
    </div>
  );
}
