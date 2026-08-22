import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAccount, useReadContract } from "wagmi";
import { formatEther } from "viem";
import { tokenAbi } from "@launchpad/shared";
import { fetchHoldings } from "../lib/indexer/client";
import { shortAddress } from "../lib/format";
import { safeImageSrc } from "../lib/safeUrl";

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

/**
 * One manually-added, not-yet-indexed holding: reads `balanceOf` directly
 * on-chain for a token B's indexer doesn't know about yet (e.g. launched too
 * recently for the indexer to have caught up). Split into its own component
 * (rather than calling `useReadContract` inside the parent's `.map`) so each
 * entry gets its own stable hook call, one per mounted row, regardless of how
 * many other manual entries exist alongside it.
 */
function ManualHoldingRow({
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
    <tr>
      <td className="py-2">
        <Link to={`/token/${tokenAddress}`} className="flex flex-col gap-0.5">
          <span>{shortAddress(tokenAddress)}</span>
          <span className="text-xs text-amber-400">added manually — not yet indexed</span>
        </Link>
      </td>
      <td>{balanceRead.isLoading || balance === undefined ? "…" : formatBalance(balance)}</td>
      <td>—</td>
    </tr>
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
      <div className="p-6 text-slate-100">
        <h1 className="mb-4 text-2xl font-semibold">Portfolio</h1>
        <p className="text-slate-400">Connect a wallet to view your holdings.</p>
      </div>
    );
  }

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const hasRows = items.length > 0 || manualTokens.length > 0;

  return (
    <div className="p-6 text-slate-100">
      <h1 className="mb-4 text-2xl font-semibold">Portfolio</h1>

      {isLoading && <p>Loading holdings…</p>}
      {isError && <p role="alert">Failed to load holdings.</p>}

      {!isLoading && !isError && !hasRows && <p className="text-slate-400">No holdings yet.</p>}

      {!isLoading && !isError && hasRows && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-slate-400">
              <th className="pb-2 font-normal">Token</th>
              <th className="pb-2 font-normal">Balance</th>
              <th className="pb-2 font-normal">Value</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.tokenAddress}>
                <td className="py-2">
                  <Link to={`/token/${item.tokenAddress}`} className="flex items-center gap-2">
                    <img src={safeImageSrc(item.logo)} alt="" className="h-6 w-6 rounded-full" />
                    <div>
                      <div>{item.name}</div>
                      <div className="text-slate-500">{item.symbol}</div>
                    </div>
                  </Link>
                </td>
                <td>{formatBalance(item.balance)}</td>
                <td>{formatValueEth(item.valueEth)}</td>
              </tr>
            ))}
            {manualTokens.map((tokenAddress) => (
              <ManualHoldingRow key={tokenAddress} tokenAddress={tokenAddress} wallet={address} />
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

      <form onSubmit={handleAddManual} className="mt-6 flex items-end gap-2">
        <label className="grid gap-1 text-sm">
          <span className="text-slate-400">Add token by address</span>
          <input
            aria-label="Token address"
            placeholder="0x…"
            value={manualInput}
            onChange={(event) => setManualInput(event.target.value)}
            className="w-96 rounded border border-slate-700 bg-transparent px-2 py-1"
          />
        </label>
        <button
          type="submit"
          className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-100"
        >
          Add
        </button>
      </form>
      {manualError && (
        <p role="alert" className="mt-2 text-sm text-rose-400">
          {manualError}
        </p>
      )}
    </div>
  );
}
