import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAccount, useReadContract } from "wagmi";
import { formatEther } from "viem";
import { motion } from "framer-motion";
import { LuWallet, LuPlus, LuCompass } from "react-icons/lu";
import { tokenAbi } from "@launchpad/shared";
import { fetchHoldings } from "../lib/indexer/client";
import type { Holdings } from "../lib/indexer/schema";
import { shortAddress } from "../lib/format";
import { safeImageSrc } from "../lib/safeUrl";
import { onLogoError } from "../components/TokenCard";
import { cardVariants, staggerContainer } from "../components/ui/MotionCard";

type HoldingItem = Holdings["items"][number];

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function isEvmAddress(value: string): value is `0x${string}` {
  return EVM_ADDRESS_RE.test(value);
}

/** Every bigint-backed balance here (both B's indexed `balance` decimal
 * string and a manual entry's live `balanceOf` bigint) is a raw wei amount,
 * never an already-human-decimal value like `valueEth`/`price` elsewhere in
 * the indexer payloads — so this goes through `formatEther`, not a plain
 * `Number(...)` pass. */
function formatBalance(raw: string | bigint): string {
  const wei = typeof raw === "string" ? BigInt(raw) : raw;
  return Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** `valueEth` is already a human-decimal string from B (its own wei→decimal
 * conversion happened server-side) — rendered directly, never through
 * `formatBalance`/`formatEther`. Null pre-first-trade (no price yet). */
function formatValueEth(value: string | null): string {
  if (value == null) return "—";
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
}

/** The whole card is the real navigation target (a `Link`, not an imperative
 * `role="link"` div like `TokenCard`) so its `href` stays directly
 * assertable, then gets the same entrance/hover motion as `MotionCard`. */
const MotionLink = motion.create(Link);

/**
 * One indexed holding, card-form: logo, name/symbol, mono balance, and value
 * (or a tasteful "—" pre-first-trade), linking to the token's detail page.
 */
function HoldingCard({ item }: { item: HoldingItem }) {
  return (
    <MotionLink
      to={`/token/${item.tokenAddress}`}
      variants={cardVariants}
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      className="surface-card surface-card-hover group flex flex-col gap-3 p-4"
    >
      <div className="flex items-center gap-3">
        <img
          src={safeImageSrc(item.logo)}
          alt=""
          onError={onLogoError}
          className="h-11 w-11 shrink-0 rounded-xl object-cover ring-1 ring-border transition-transform duration-200 group-hover:scale-105"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold leading-tight text-ink">{item.name}</div>
          <div className="truncate font-mono text-[11px] uppercase tracking-wide text-ink-muted">
            {item.symbol}
          </div>
        </div>
      </div>

      <div className="mt-auto grid grid-cols-2 gap-2 border-t border-border pt-3">
        <div>
          <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">Balance</div>
          <div className="tnum truncate text-sm font-semibold text-ink">
            {formatBalance(item.balance)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">Value</div>
          <div className="tnum truncate text-sm text-ink-muted">{formatValueEth(item.valueEth)}</div>
        </div>
      </div>
    </MotionLink>
  );
}

/**
 * One manually-added, not-yet-indexed holding: reads `balanceOf` directly
 * on-chain for a token B's indexer doesn't know about yet (e.g. launched too
 * recently for the indexer to have caught up). Split into its own component
 * (rather than calling `useReadContract` inside the parent's `.map`) so each
 * entry gets its own stable hook call, one per mounted card, regardless of how
 * many other manual entries exist alongside it.
 */
function ManualHoldingCard({
  tokenAddress,
  wallet,
}: {
  tokenAddress: `0x${string}`;
  wallet: `0x${string}`;
}) {
  const balanceRead = useReadContract({
    address: tokenAddress,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [wallet],
  });
  const balance = balanceRead.data as bigint | undefined;

  return (
    <MotionLink
      to={`/token/${tokenAddress}`}
      variants={cardVariants}
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      className="surface-card surface-card-hover flex flex-col gap-3 p-4"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 font-mono text-[10px] text-ink-faint ring-1 ring-border">
          0x…
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm text-ink">{shortAddress(tokenAddress)}</div>
          <div className="truncate text-[11px] text-gold">added manually — not yet indexed</div>
        </div>
      </div>

      <div className="mt-auto grid grid-cols-2 gap-2 border-t border-border pt-3">
        <div>
          <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">Balance</div>
          <div className="tnum truncate text-sm font-semibold text-ink">
            {balanceRead.isLoading || balance === undefined ? "…" : formatBalance(balance)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[0.62rem] uppercase tracking-wider text-ink-faint">Value</div>
          <div className="tnum truncate text-sm text-ink-muted">—</div>
        </div>
      </div>
    </MotionLink>
  );
}

/** Placeholder tiles shown while the first page of holdings is in flight. */
function HoldingsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="surface-card flex flex-col gap-3 p-4">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 animate-pulse rounded-xl bg-surface-2" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
              <div className="h-2 w-1/3 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
          <div className="mt-auto grid grid-cols-2 gap-2 border-t border-border pt-3">
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface-2" />
            <div className="ml-auto h-4 w-3/4 animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only view of the connected wallet's holdings: the indexed list from
 * B (`fetchHoldings`) plus a manual "add token by address" fallback for any
 * token B hasn't indexed yet, which reads `balanceOf` straight from the
 * chain instead. This page never writes anything.
 */
export default function Portfolio() {
  const { address } = useAccount();
  const [manualTokens, setManualTokens] = useState<`0x${string}`[]>([]);
  const [manualInput, setManualInput] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["holdings", address],
      queryFn: ({ pageParam }) => fetchHoldings(address!, pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      enabled: Boolean(address),
    });

  function handleAddManual(event: FormEvent) {
    event.preventDefault();
    const trimmed = manualInput.trim();
    if (!isEvmAddress(trimmed)) {
      setManualError("Enter a valid token address (0x… + 40 hex chars).");
      return;
    }
    setManualError(null);
    setManualInput("");
    setManualTokens((tokens) => (tokens.includes(trimmed) ? tokens : [...tokens, trimmed]));
  }

  if (!address) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Portfolio</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Every token your wallet holds across RobinLaunch, in one place.
        </p>

        <div className="surface-card mt-8 flex flex-col items-center gap-2 px-6 py-16 text-center">
          <LuWallet className="text-3xl text-ink-faint" />
          <p className="text-lg font-semibold text-ink">Connect your wallet to see your holdings</p>
        </div>
      </div>
    );
  }

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const hasRows = items.length > 0 || manualTokens.length > 0;
  const totalHoldings = items.length + manualTokens.length;
  const pricedTotalEth = items.reduce(
    (sum, item) => (item.valueEth == null ? sum : sum + Number(item.valueEth)),
    0,
  );
  const hasPricedHoldings = items.some((item) => item.valueEth != null);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Portfolio</h1>
        <p className="text-sm text-ink-muted">
          Every token your wallet holds across RobinLaunch, in one place.
        </p>
      </div>

      {hasRows && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span className="chip">
            <span className="tnum font-semibold text-ink">{totalHoldings}</span>
            &nbsp;holding{totalHoldings === 1 ? "" : "s"}
          </span>
          {hasPricedHoldings && (
            <span className="chip">
              <span className="tnum font-semibold text-ink">
                {pricedTotalEth.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              &nbsp;ETH total value
            </span>
          )}
        </div>
      )}

      {isLoading && <HoldingsSkeleton />}

      {isError && (
        <p role="alert" className="surface-card p-4 text-rose">
          Failed to load holdings.
        </p>
      )}

      {!isLoading && !isError && !hasRows && (
        <div className="surface-card flex flex-col items-center gap-2 px-6 py-16 text-center">
          <LuCompass className="text-3xl text-ink-faint" />
          <p className="text-lg font-semibold text-ink">No tokens yet</p>
          <p className="max-w-sm text-sm text-ink-muted">
            Your wallet isn't holding anything on RobinLaunch yet.
          </p>
          <Link to="/" className="btn-primary mt-2">
            Explore the board
          </Link>
        </div>
      )}

      {!isLoading && !isError && hasRows && (
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {items.map((item) => (
            <HoldingCard key={item.tokenAddress} item={item} />
          ))}
          {manualTokens.map((tokenAddress) => (
            <ManualHoldingCard key={tokenAddress} tokenAddress={tokenAddress} wallet={address} />
          ))}
        </motion.div>
      )}

      {!isLoading && !isError && hasNextPage && (
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

      <form
        onSubmit={handleAddManual}
        className="surface-card mt-8 flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between sm:gap-4"
      >
        <label className="grid flex-1 gap-1.5 text-sm">
          <span className="text-ink-muted">Add token by address</span>
          <input
            aria-label="Token address"
            placeholder="0x…"
            value={manualInput}
            onChange={(event) => setManualInput(event.target.value)}
            className="w-full rounded-xl border border-border-strong bg-surface-2 px-3 py-2 font-mono text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent/50"
          />
        </label>
        <button type="submit" className="btn-primary shrink-0">
          <LuPlus /> Add
        </button>
      </form>
      {manualError && (
        <p role="alert" className="mt-2 text-sm text-rose">
          {manualError}
        </p>
      )}
    </div>
  );
}
