import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchTokens, search } from "../lib/indexer/client";
import type { SearchResults } from "../lib/indexer/schema";
import { formatAge, formatPct } from "../lib/format";
import { safeImageSrc } from "../lib/safeUrl";

// Reconciled against B's real `/tokens` capability (indexer/src/api/helpers.ts
// `parseSort`), which only accepts `newest|price|holders` — anything else
// silently falls back to `newest` against a real indexer. "Market cap" sorts
// by `price` (equivalent: every token's supply is a fixed 1e9, so
// market-cap order == price order); 24h volume and 24h change stay
// DISPLAY-only columns, never sort keys B doesn't support.
type SortKey = "newest" | "price" | "holders";

/** `item.price`/`item.marketCap`/`item.volume24h` are already human-decimal
 * strings from B (B's `formatPrice18` did the wei→decimal conversion
 * server-side) — never run these through `formatEth`, which expects wei
 * bigints for chain-read values elsewhere in the app (Launch/Trade). This is
 * just a thousands-separator pass over an already-formatted number. */
function formatDecimalString(value: string | null): string {
  if (value == null) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export default function Explore() {
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortKey>("newest");
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

  // Flatten every loaded page into one row list; `Load more` appends the next.
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  // An `<a>`/`<Link>` cannot legally wrap a `<tr>` (invalid HTML, misrenders
  // in a real browser) — the row itself is the click/keyboard target instead,
  // navigated imperatively via `useNavigate()`.
  function goToToken(address: string) {
    navigate(`/token/${address}`);
  }
  function onRowKeyDown(event: ReactKeyboardEvent<HTMLTableRowElement>, address: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      goToToken(address);
    }
  }

  return (
    <div className="p-6 text-slate-100">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Explore</h1>
        <button
          type="button"
          onClick={() => setSearchOpen((open) => !open)}
          className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-400"
        >
          Search <kbd>⌘K</kbd>
        </button>
      </div>

      {searchOpen && (
        <div className="mb-4 rounded border border-slate-700 p-3">
          <input
            autoFocus
            type="text"
            role="searchbox"
            placeholder="Search tokens by name, symbol, or address…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full bg-transparent text-slate-100 outline-none"
          />
          {searchItems.length > 0 && (
            <ul data-testid="search-results" className="mt-2 divide-y divide-slate-800">
              {searchItems.map((item) => (
                <li key={item.address}>
                  <Link to={`/token/${item.address}`} className="flex items-center gap-2 py-2">
                    <img src={safeImageSrc(item.logo)} alt="" className="h-5 w-5 rounded-full" />
                    <span>{item.name}</span>
                    <span className="text-slate-500">{item.symbol}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isLoading && <p>Loading tokens…</p>}
      {isError && <p role="alert">Failed to load tokens.</p>}

      {!isLoading && !isError && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-slate-400">
              <th className="pb-2 font-normal">Token</th>
              <th className="pb-2 font-normal">Price</th>
              <th className="pb-2 font-normal">
                <button type="button" onClick={() => setSort("price")} className={sort === "price" ? "font-semibold text-white" : ""}>
                  Market cap
                </button>
              </th>
              {/* Display-only: B's `/tokens` sort has no `volume24h` key. */}
              <th className="pb-2 font-normal">24h volume</th>
              {/* Display-only: B's `/tokens` sort has no `priceChange24h` key. */}
              <th className="pb-2 font-normal">24h change</th>
              <th className="pb-2 font-normal">
                <button type="button" onClick={() => setSort("holders")} className={sort === "holders" ? "font-semibold text-white" : ""}>
                  Holders
                </button>
              </th>
              <th className="pb-2 font-normal">
                <button type="button" onClick={() => setSort("newest")} className={sort === "newest" ? "font-semibold text-white" : ""}>
                  Age
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.address}
                role="link"
                tabIndex={0}
                onClick={() => goToToken(item.address)}
                onKeyDown={(event) => onRowKeyDown(event, item.address)}
                className="cursor-pointer hover:bg-slate-900"
              >
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <img src={safeImageSrc(item.logo)} alt="" className="h-6 w-6 rounded-full" />
                    <div>
                      <div>{item.name}</div>
                      <div className="text-slate-500">{item.symbol}</div>
                    </div>
                  </div>
                </td>
                <td>{formatDecimalString(item.price)}</td>
                <td>{formatDecimalString(item.marketCap)}</td>
                <td>{formatDecimalString(item.volume24h)}</td>
                <td>
                  {item.priceChangeBps24h == null ? "—" : formatPct(item.priceChangeBps24h / 100)}
                </td>
                <td>{item.holderCount}</td>
                <td>{formatAge(Number(item.launchTimestamp))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!isLoading && !isError && hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
