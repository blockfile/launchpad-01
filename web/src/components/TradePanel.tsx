import { useState } from "react";
import { useAccount, useBlockNumber, useChainId, useReadContract } from "wagmi";
import { formatEther, parseEther } from "viem";
import { tokenAbi } from "@launchpad/shared";
import { useTokenPool, useSpotQuote, type TradeSide } from "../lib/quote";
import { BusyButton } from "./ui/BusyButton";
import { notify } from "../lib/toast";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const BALANCE_PCTS = [25, 50, 75, 100] as const;

/** Decimal ETH/token string → wei. "" and a lone "." are both un-parseable and
 * map to a zero input (so an empty box yields no quote, never a bad one). */
function parseAmount(value: string): bigint {
  if (!value || value === ".") return 0n;
  try {
    return parseEther(value as `${number}`);
  } catch {
    return 0n;
  }
}

/** A compact display of a wei amount (full precision, trailing zeros trimmed by
 * `formatEther`), or an em dash when there is nothing to show yet. */
function displayWei(wei: bigint): string {
  return wei > 0n ? formatEther(wei) : "—";
}

/**
 * Buy/sell panel for one launched token. The estimate and its slippage-floored
 * `minAmountOut` come from `useSpotQuote` (a live `slot0` read); the Swap action
 * is DISABLED until that estimate is a real positive number, so there is no code
 * path that submits a min-out of 0. The actual swap write lands in Task 12,
 * which re-reads `slot0` via `quote.refetch()` immediately before pricing.
 */
export function TradePanel({ tokenAddress }: { tokenAddress?: `0x${string}` }) {
  const chainId = useChainId();
  const { address: account } = useAccount();

  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("");
  const [slippagePct, setSlippagePct] = useState("1");

  const pool = useTokenPool(tokenAddress, chainId);
  const amountIn = parseAmount(amount);
  const quote = useSpotQuote({
    pool: pool.pool,
    isToken0: pool.isToken0,
    poolFeePpm: pool.poolFeePpm,
    side,
    amountIn,
  });

  // Input asset: a buy spends the paired asset (WETH); a sell spends the token.
  const inputToken = side === "buy" ? pool.pairedToken : tokenAddress;
  const balanceRead = useReadContract({
    address: inputToken,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [account ?? ZERO_ADDRESS],
    query: { enabled: Boolean(account) && Boolean(inputToken) },
  });
  const balance = (balanceRead.data as bigint | undefined) ?? 0n;

  const { data: currentBlock } = useBlockNumber({ watch: true });
  const restricted =
    pool.restrictionsEndBlock !== undefined &&
    currentBlock !== undefined &&
    pool.restrictionsEndBlock > currentBlock;

  const slippageBps = Math.max(0, Math.round(Number(slippagePct || "0") * 100));
  const estimate = quote.amountOutEstimate;
  const hasQuote = estimate > 0n;
  const minOut = quote.minAmountOut(slippageBps);
  const canSwap = pool.exists && hasQuote && Boolean(account);

  const inSymbol = side === "buy" ? "WETH" : "Token";
  const outSymbol = side === "buy" ? "Token" : "WETH";

  if (!tokenAddress) return null;

  if (pool.isLoading && !pool.exists) {
    return (
      <div
        data-testid="trade-panel"
        className="h-fit rounded border border-slate-700 p-4 text-sm text-slate-500"
      >
        Loading market…
      </div>
    );
  }

  if (!pool.exists) {
    return (
      <div
        data-testid="trade-panel"
        className="h-fit rounded border border-slate-700 p-4 text-sm text-amber-400"
      >
        This address is not a launched token and cannot be traded here.
      </div>
    );
  }

  function setPctOfBalance(pct: number) {
    setAmount(formatEther((balance * BigInt(pct)) / 100n));
  }

  return (
    <div
      data-testid="trade-panel"
      className="h-fit rounded border border-slate-700 p-4 text-sm text-slate-100"
    >
      {/* Buy / sell tabs */}
      <div className="mb-4 grid grid-cols-2 gap-2">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={
              side === s
                ? s === "buy"
                  ? "rounded bg-emerald-600 px-3 py-2 font-semibold"
                  : "rounded bg-rose-600 px-3 py-2 font-semibold"
                : "rounded border border-slate-700 px-3 py-2 text-slate-400"
            }
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      {restricted && (
        <div
          data-testid="restriction-banner"
          role="status"
          className="mb-4 rounded border border-amber-700/60 bg-amber-950/40 p-3 text-xs text-amber-300"
        >
          Trading restrictions are active until block {String(pool.restrictionsEndBlock)}. Max
          wallet / max transaction limits are enforced until then.
        </div>
      )}

      {/* Amount */}
      <label className="grid gap-1">
        <span className="text-slate-400">Amount ({inSymbol})</span>
        <input
          aria-label={`Amount (${inSymbol})`}
          inputMode="decimal"
          placeholder="0"
          className="rounded border border-slate-700 bg-transparent px-2 py-1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      <div className="mt-2 grid grid-cols-4 gap-2">
        {BALANCE_PCTS.map((pct) => (
          <button
            key={pct}
            type="button"
            onClick={() => setPctOfBalance(pct)}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-500"
          >
            {pct}%
          </button>
        ))}
      </div>
      <div className="mt-1 text-xs text-slate-500">
        Balance: {displayWei(balance)} {inSymbol}
      </div>

      {/* Slippage */}
      <label className="mt-4 grid gap-1">
        <span className="text-slate-400">Slippage (%)</span>
        <input
          aria-label="Slippage (%)"
          inputMode="decimal"
          className="w-24 rounded border border-slate-700 bg-transparent px-2 py-1"
          value={slippagePct}
          onChange={(e) => setSlippagePct(e.target.value)}
        />
      </label>

      {/* Quote read-out */}
      <dl className="mt-4 grid gap-1 rounded border border-slate-800 p-3 text-xs">
        <div className="flex justify-between">
          <dt className="text-slate-400">Estimated {outSymbol} out</dt>
          <dd data-testid="estimate-out">{displayWei(estimate)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-400">Minimum received ({slippagePct || "0"}% slippage)</dt>
          <dd data-testid="min-out">{hasQuote ? formatEther(minOut) : "—"}</dd>
        </div>
      </dl>

      {!account && <p className="mt-3 text-xs text-amber-400">Connect a wallet to trade.</p>}

      <BusyButton
        busy=""
        busyWhen="swap"
        disabled={!canSwap}
        className="mt-4 w-full rounded bg-sky-600 px-4 py-2 font-semibold disabled:opacity-40"
        onClick={() =>
          // Write wiring is Task 12: it re-reads slot0 via quote.refetch() and
          // submits with this exact minOut. Never reachable with a 0 estimate —
          // the button is disabled above until the quote resolves.
          notify("Swap execution ships in the next update.", "info")
        }
      >
        Swap
      </BusyButton>
    </div>
  );
}
