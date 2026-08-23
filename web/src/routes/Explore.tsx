import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { FaCrown } from "react-icons/fa6";
import {
  LuSearch,
  LuLayoutGrid,
  LuList,
  LuUsers,
  LuClock,
  LuArrowUpRight,
  LuArrowDownRight,
} from "react-icons/lu";
import { fetchTokens, search } from "../lib/indexer/client";
import type { SearchResults, TokenListItem } from "../lib/indexer/schema";
import { formatAge, formatPct } from "../lib/format";
import { safeImageSrc } from "../lib/safeUrl";
import { staggerContainer } from "../components/ui/MotionCard";
import {
  TokenCard,
  formatTokenAmount,
  formatCompactAmount,
  onLogoError,
} from "../components/TokenCard";

// Reconciled against B's real `/tokens` capability (indexer/src/api/helpers.ts
// `parseSort`), which only accepts `newest|price|holders` — anything else
// silently falls back to `newest` against a real indexer. "Market cap" sorts
// by `price` (equivalent: every token's supply is a fixed 1e9, so
// market-cap order == price order); 24h volume and 24h change stay
// DISPLAY-only, never sort keys B doesn't support.
type SortKey = "newest" | "price" | "holders";
type ViewMode = "grid" | "list";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "price", label: "Market cap" },
  { key: "holders", label: "Top holders" },
];

/** The featured token = the loaded token with the highest market cap (ape.store's
 * "King" slot). Presentation-only: a client-side max over the already-fetched
 * page items, never a second query or a new sort key. Falls back to the first
 * item when nothing has traded yet (every marketCap null) so the hero always
 * has an occupant while there is ≥1 token. */
function pickKing(items: TokenListItem[]): TokenListItem | undefined {
  if (items.length === 0) return undefined;
  let king = items[0];
  let best = -Infinity;
  for (const item of items) {
    const cap = item.marketCap == null ? -Infinity : Number(item.marketCap);
    if (cap > best) {
      best = cap;
      king = item;
    }
  }
  return king;
}

/** Static gold coin accent beside the King card. A CSS/SVG glyph rather than a
 * second `<Coin3D>` WebGL context (the sidebar's BrandCoin already owns one),
 * per the redesign's "don't spin a 2nd WebGL context" guidance. Decorative. */
function GoldCoinGlyph() {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className="h-20 w-20 sm:h-24 sm:w-24">
      <defs>
        <radialGradient id="king-coin" cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#fff4cc" />
          <stop offset="45%" stopColor="#f5c518" />
          <stop offset="100%" stopColor="#a97706" />
        </radialGradient>
      </defs>
      <circle cx="48" cy="48" r="42" fill="url(#king-coin)" stroke="#fff4cc" strokeWidth="2" />
      <circle cx="48" cy="48" r="31" fill="none" stroke="#0a0a0b" strokeOpacity="0.22" strokeWidth="2" />
      <path
        d="M32 54l-3-19 11 8 8-13 8 13 11-8-3 19z"
        fill="#0a0a0b"
        fillOpacity="0.35"
      />
    </svg>
  );
}

/** 24h change read used by the King card (the grid/list tiles use TokenCard's
 * own chip). Emerald/rose with a directional arrow, or a muted "New" pill. */
function KingChange({ bps }: { bps: number | null }) {
  if (bps == null) {
    return <span className="chip border-border !bg-surface-2 text-xs text-ink-muted">New</span>;
  }
  const up = bps >= 0;
  return (
    <span
      className={`chip !gap-1 border-transparent text-sm font-semibold tnum ${
        up ? "!bg-emerald/12 text-emerald" : "!bg-rose/12 text-rose"
      }`}
    >
      {up ? <LuArrowUpRight /> : <LuArrowDownRight />}
      {formatPct(bps / 100)}
    </span>
  );
}

/** The premium featured "King of RobinHood" hero — the #1 token by market cap.
 * Gold-accented border + `.hero-glow`, a crown, big mono market cap, price, 24h
 * change, holders/age, and a Trade CTA. Click/Enter navigates like the tiles. */
function FeaturedKing({ item }: { item: TokenListItem }) {
  const navigate = useNavigate();
  const go = () => navigate(`/token/${item.address}`);
  const marketCap = formatCompactAmount(item.marketCap);
  const price = item.price == null ? null : formatTokenAmount(item.price);

  return (
    <section className="relative mb-8">
      <div className="hero-glow" />
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        whileHover={{ y: -3 }}
        role="link"
        tabIndex={0}
        aria-label={`King of RobinHood — ${item.name} (${item.symbol})`}
        onClick={go}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            go();
          }
        }}
        className="surface-card relative z-10 cursor-pointer overflow-hidden !border-gold/30 p-5 shadow-[0_0_0_1px_rgba(245,197,24,0.08),0_24px_60px_-30px_rgba(245,197,24,0.35)] sm:p-6"
      >
        {/* soft gold wash in the corner */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-gold/10 blur-3xl"
        />

        <div className="relative mb-5 flex items-center justify-between gap-3">
          <span className="chip !gap-1.5 border-gold/30 !bg-gold/10 font-semibold uppercase tracking-wider text-gold">
            <FaCrown /> King of RobinHood
          </span>
          <KingChange bps={item.priceChangeBps24h} />
        </div>

        <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-4 sm:gap-5">
            <img
              src={safeImageSrc(item.logo)}
              alt=""
              onError={onLogoError}
              className="h-16 w-16 shrink-0 rounded-2xl object-cover ring-2 ring-gold/40 sm:h-20 sm:w-20"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                  {item.name}
                </h2>
                <span className="font-mono text-xs uppercase tracking-wide text-ink-muted">
                  {item.symbol}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <div>
                  <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">
                    Market cap
                  </div>
                  {marketCap == null ? (
                    <span className="chip mt-0.5 border-accent/25 !bg-accent/10 text-sm font-semibold text-accent">
                      New · not yet traded
                    </span>
                  ) : (
                    <div className="tnum text-3xl font-bold text-ink sm:text-4xl">{marketCap}</div>
                  )}
                </div>
                <div>
                  <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">Price</div>
                  <div className="tnum text-lg text-ink-muted">{price ?? "—"}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-5 md:flex-col md:items-end md:justify-center">
            <div className="hidden shrink-0 sm:block">
              <GoldCoinGlyph />
            </div>
            <div className="flex flex-col items-start gap-3 md:items-end">
              <div className="flex items-center gap-4 text-sm text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <LuUsers /> {item.holderCount} holders
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <LuClock /> {formatAge(Number(item.launchTimestamp))}
                </span>
              </div>
              <Link
                to={`/token/${item.address}`}
                onClick={(event) => event.stopPropagation()}
                className="btn-primary w-full justify-center sm:w-auto"
              >
                Trade <LuArrowUpRight />
              </Link>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

/** Placeholder tiles shown while the first page is in flight. */
function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="surface-card flex flex-col gap-3 p-4">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 animate-pulse rounded-xl bg-surface-2" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
              <div className="h-2 w-1/3 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
          <div className="h-6 w-1/2 animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
          <div className="mt-2 h-3 w-full animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

export default function Explore() {
  const [sort, setSort] = useState<SortKey>("newest");
  const [view, setView] = useState<ViewMode>("grid");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchItems, setSearchItems] = useState<SearchResults["items"]>([]);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["tokens", sort],
      queryFn: ({ pageParam }) => fetchTokens({ sort, cursor: pageParam }),
      initialPageParam: undefined as string | undefined,
      // `nextCursor` is `string | null`; null ⇒ last page ⇒ no more pages.
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  // Global ⌘K / Ctrl+K shortcut opens the search box; Escape closes it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "Escape") {
        setSearchOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Re-runs `search()` whenever the query text changes while the box is open.
  useEffect(() => {
    if (!searchOpen || query.trim() === "") {
      setSearchItems([]);
      return;
    }
    let cancelled = false;
    search(query).then((result) => {
      if (!cancelled) setSearchItems(result.items);
    });
    return () => {
      cancelled = true;
    };
  }, [searchOpen, query]);

  // Flatten every loaded page into one item list; `Load more` appends the next.
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  // The featured King is lifted out of the board so it isn't shown twice.
  const king = pickKing(items);
  const boardItems = king ? items.filter((item) => item.address !== king.address) : items;
  const showEmpty = !isLoading && !isError && items.length === 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Explore</h1>
          <p className="text-sm text-ink-muted">Fresh launches and top movers on RobinLaunch.</p>
        </div>
        <button
          type="button"
          onClick={() => setSearchOpen((open) => !open)}
          className="btn-ghost text-sm text-ink-muted"
        >
          <LuSearch /> Search
          <kbd className="ml-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[0.65rem] text-ink-faint">
            ⌘K
          </kbd>
        </button>
      </div>

      {searchOpen && (
        <div className="surface-card mb-6 p-3">
          <div className="flex items-center gap-2">
            <LuSearch className="shrink-0 text-ink-muted" />
            <input
              autoFocus
              type="text"
              role="searchbox"
              placeholder="Search tokens by name, symbol, or address…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full bg-transparent text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          {searchItems.length > 0 && (
            <ul data-testid="search-results" className="mt-2 divide-y divide-border">
              {searchItems.map((item) => (
                <li key={item.address}>
                  <Link
                    to={`/token/${item.address}`}
                    className="flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-surface-2"
                  >
                    <img
                      src={safeImageSrc(item.logo)}
                      alt=""
                      onError={onLogoError}
                      className="h-6 w-6 rounded-full ring-1 ring-border"
                    />
                    <span className="text-ink">{item.name}</span>
                    <span className="font-mono text-xs uppercase text-ink-muted">{item.symbol}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isError && (
        <p role="alert" className="surface-card p-4 text-rose">
          Failed to load tokens.
        </p>
      )}

      {!isError && (
        <>
          {king && <FeaturedKing item={king} />}

          {/* Control bar: sort chips + grid/list toggle */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {SORTS.map(({ key, label }) => {
                const active = sort === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSort(key)}
                    aria-pressed={active}
                    className={`chip transition-colors ${
                      active
                        ? "border-accent/40 !bg-accent/15 font-semibold text-accent"
                        : "text-ink-muted hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1 rounded-full border border-border bg-surface p-1">
              <button
                type="button"
                onClick={() => setView("grid")}
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                className={`rounded-full p-1.5 transition-colors ${
                  view === "grid" ? "bg-surface-hover text-accent" : "text-ink-muted hover:text-ink"
                }`}
              >
                <LuLayoutGrid className="text-base" />
              </button>
              <button
                type="button"
                onClick={() => setView("list")}
                aria-label="List view"
                aria-pressed={view === "list"}
                className={`rounded-full p-1.5 transition-colors ${
                  view === "list" ? "bg-surface-hover text-accent" : "text-ink-muted hover:text-ink"
                }`}
              >
                <LuList className="text-base" />
              </button>
            </div>
          </div>

          {isLoading && <SkeletonGrid />}

          {showEmpty && (
            <div className="surface-card flex flex-col items-center gap-2 px-6 py-16 text-center">
              <LuSearch className="text-3xl text-ink-faint" />
              <p className="text-lg font-semibold text-ink">No tokens yet</p>
              <p className="max-w-sm text-sm text-ink-muted">
                Nothing has launched here yet. Be the first to mint a coin and claim the crown.
              </p>
              <Link to="/create" className="btn-primary mt-2">
                Launch a token
              </Link>
            </div>
          )}

          {!isLoading && !showEmpty && view === "list" && (
            <div className="mb-2 hidden items-center gap-4 px-4 text-[0.62rem] uppercase tracking-wider text-ink-faint sm:flex">
              <span className="flex-1">Token</span>
              <span className="w-24 text-right">Market cap</span>
              <span className="w-24 text-right">Price</span>
              <span className="w-24 text-right">24h</span>
              <span className="hidden w-16 text-right md:block">Holders</span>
              <span className="hidden w-12 text-right md:block">Age</span>
            </div>
          )}

          {!isLoading && !showEmpty && (
            <motion.div
              key={`${sort}-${view}`}
              variants={staggerContainer}
              initial="hidden"
              animate="show"
              className={
                view === "grid"
                  ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                  : "flex flex-col gap-2"
              }
            >
              {boardItems.map((item) => (
                <TokenCard key={item.address} item={item} variant={view} />
              ))}
            </motion.div>
          )}

          {!isLoading && hasNextPage && (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="btn-ghost text-sm disabled:opacity-40"
              >
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
