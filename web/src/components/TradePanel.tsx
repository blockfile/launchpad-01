import { useState } from "react";
import {
  useAccount,
  useBlockNumber,
  useChainId,
  useConfig,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { useQueryClient } from "@tanstack/react-query";
import { formatEther, parseEther } from "viem";
import { tokenAbi } from "@launchpad/shared";
import {
  useTokenPool,
  useSpotQuote,
  spotAmountOut,
  applySlippage,
  type TradeSide,
} from "../lib/quote";
import { resolveAddress } from "../lib/contracts";
import { buildBuyCall, buildSellCall } from "../lib/swap";
import { BusyButton } from "./ui/BusyButton";
import { LaunchpadUnavailableNotice } from "./NetworkNotice";
import { WrongNetworkBanner } from "./WrongNetworkBanner";
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
 * Buy/sell panel for one launched token.
 *
 * The estimate and its slippage-floored `minAmountOut` come from `useSpotQuote`
 * (a live `slot0` read); the Swap action is DISABLED until that estimate is a
 * real positive number, so there is no code path that submits a min-out of 0.
 *
 * On submit the write flow is (safety-critical, each step load-bearing):
 *   1. `quote.refetch()` — re-read `slot0` NOW and recompute `minAmountOut`
 *      from the CURRENT tick; never submit against the stale polled quote,
 *      never a zero min-out.
 *   2. SELL only: if `token.allowance(user, router) < amountIn`, `approve` the
 *      EXACT `amountIn` (never max/infinite), await its receipt, then proceed —
 *      `exactInputSingle` consumes exactly `amountIn`, leaving no residual
 *      allowance standing.
 *   3. `buildBuyCall`/`buildSellCall` + `writeContract`, await the receipt.
 *   4. Notify + invalidate this token's trades/holders queries so the page
 *      reflects the trade without a manual refresh (B re-indexes async).
 */
export function TradePanel({
  tokenAddress,
  fallbackPoolAddress,
}: {
  tokenAddress?: `0x${string}`;
  /** B's stored, immutable `poolAddress` for this token (from `fetchToken`).
   * Lets trading survive a drifted live DEX config: if the on-chain `getPool`
   * has been repointed to zero, we still trade against the real launch pool. */
  fallbackPoolAddress?: `0x${string}`;
}) {
  const chainId = useChainId();
  const { address: account } = useAccount();
  const config = useConfig();
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();

  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("");
  const [slippagePct, setSlippagePct] = useState("1");
  const [busy, setBusy] = useState("");

  // WETH is a chain-wide venue address (packages/shared/addresses/<id>.json);
  // `resolveAddress` throws loudly rather than returning a null into a write.
  const weth = resolveAddress(chainId, "weth");

  const pool = useTokenPool(tokenAddress, chainId, fallbackPoolAddress);
  // The token's OWN router, read per-dexId from `getDexConfig(dexId).swapRouter`
  // (never the chain default): a token launched under a non-default dexId points
  // at a different router, and the allowance read, the approve, and both call
  // builders must all target THAT router or the trade reverts / routes through
  // the wrong (possibly attacker-seeded) venue.
  const swapRouter = pool.swapRouter;
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

  // SELL needs the token's allowance to the router; BUY never touches it (the
  // WETH input is native msg.value).
  const allowanceRead = useReadContract({
    address: tokenAddress,
    abi: tokenAbi,
    functionName: "allowance",
    args: [account ?? ZERO_ADDRESS, swapRouter ?? ZERO_ADDRESS],
    query: {
      enabled:
        side === "sell" && Boolean(account) && Boolean(tokenAddress) && Boolean(swapRouter),
    },
  });
  const allowance = (allowanceRead.data as bigint | undefined) ?? 0n;

  const { data: currentBlock } = useBlockNumber({ watch: true });
  const restricted =
    pool.restrictionsEndBlock !== undefined &&
    currentBlock !== undefined &&
    pool.restrictionsEndBlock > currentBlock;

  const slippageBps = Math.max(0, Math.round(Number(slippagePct || "0") * 100));
  const estimate = quote.amountOutEstimate;
  const hasQuote = estimate > 0n;
  const minOut = quote.minAmountOut(slippageBps);
  // Gate on the per-token router being resolved too: without it we cannot build
  // a safe approve/swap, so the button stays disabled until the read lands.
  const canSwap =
    pool.exists && hasQuote && Boolean(account) && Boolean(swapRouter) && busy === "";

  const inSymbol = side === "buy" ? "WETH" : "Token";
  const outSymbol = side === "buy" ? "Token" : "WETH";

  async function submitSwap() {
    if (
      !account ||
      !tokenAddress ||
      !swapRouter ||
      pool.poolFeePpm === undefined ||
      pool.isToken0 === undefined ||
      amountIn <= 0n
    ) {
      return;
    }
    try {
      setBusy("swap");

      // A token whose router wants the with-deadline overload gets a far-future
      // deadline (now + 20 min); the live default (false) passes `undefined`,
      // keeping the exact no-deadline call the Anvil round-trip proved.
      const deadline = pool.routerRequiresDeadline
        ? BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
        : undefined;

      // 1. Fresh price: re-read slot0 and recompute the min-out from the
      // CURRENT tick. Never price against the stale polled quote.
      const fresh = (await quote.refetch()) as
        | { data?: readonly [bigint, ...unknown[]] }
        | undefined;
      const freshSqrt = fresh?.data?.[0];
      if (freshSqrt === undefined || freshSqrt <= 0n) {
        notify("Could not read a fresh price — swap aborted.", "error");
        return;
      }
      const freshEstimate = spotAmountOut({
        sqrtPriceX96: freshSqrt,
        isToken0: pool.isToken0,
        tokenInIsPaired: side === "buy",
        amountIn,
        poolFeePpm: pool.poolFeePpm,
      });
      const freshMinOut = applySlippage(freshEstimate, slippageBps);
      // Belt-and-braces: never submit a zero minimum-out even if a fresh read
      // somehow returns a degenerate price.
      if (freshMinOut <= 0n) {
        notify("Quote unavailable — refusing to swap with a zero minimum out.", "error");
        return;
      }

      let hash: `0x${string}`;
      if (side === "sell") {
        // 2. Approve the EXACT amountIn, only if the standing allowance is
        // short. exactInputSingle then consumes exactly amountIn — no residual.
        if (allowance < amountIn) {
          const approveHash = await writeContractAsync({
            address: tokenAddress,
            abi: tokenAbi,
            functionName: "approve",
            args: [swapRouter, amountIn],
          });
          // viem's waitForTransactionReceipt RESOLVES (never throws) for a
          // reverted tx — it only rejects on timeout/replacement. So a reverted
          // approve must be caught by its `status`, or we would fall through and
          // submit a swap that then reverts on transferFrom.
          const approveReceipt = await waitForTransactionReceipt(config, { hash: approveHash });
          if (approveReceipt.status !== "success") {
            notify("Approval reverted — swap not submitted.", "error");
            return;
          }
          await allowanceRead.refetch();
        }
        hash = await writeContractAsync(
          buildSellCall({
            router: swapRouter,
            weth,
            token: tokenAddress,
            poolFee: pool.poolFeePpm,
            seller: account,
            amountIn,
            minAmountOut: freshMinOut,
            deadline,
          }),
        );
      } else {
        hash = await writeContractAsync(
          buildBuyCall({
            router: swapRouter,
            weth,
            token: tokenAddress,
            poolFee: pool.poolFeePpm,
            recipient: account,
            amountIn,
            minAmountOut: freshMinOut,
            deadline,
          }),
        );
      }

      // Same caveat as the approve above: a reverted swap RESOLVES here with
      // status "reverted" (realistic — the price can move past our fresh
      // minAmountOut between the client check and block inclusion). Only a
      // "success" status is a real trade: never show a success toast, invalidate
      // queries, or clear the input for a reverted swap that moved no funds.
      const swapReceipt = await waitForTransactionReceipt(config, { hash });
      if (swapReceipt.status !== "success") {
        notify("Swap failed (reverted) — no funds moved. The price may have moved past your slippage.", "error");
        return;
      }
      notify("Swap complete", "ok");

      // Reflect the new trade without a manual refresh; B's own indexing fills
      // the rest in asynchronously on its own schedule.
      queryClient.invalidateQueries({ queryKey: ["trades", tokenAddress] });
      queryClient.invalidateQueries({ queryKey: ["holders", tokenAddress] });
      queryClient.invalidateQueries({ queryKey: ["token", tokenAddress] });
      // A SELL consumes the exact allowance it approved; refetch it so a second
      // same-mount sell re-reads the now-zero allowance and re-approves instead
      // of skipping the approve and reverting on transferFrom.
      void allowanceRead.refetch();
      setAmount("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/user rejected|denied|rejected the request/i.test(message)) {
        notify("Transaction rejected.", "info");
      } else {
        notify("Swap failed — it may have reverted or the price moved past your slippage.", "error");
      }
      // eslint-disable-next-line no-console
      console.error("swap failed", err);
    } finally {
      setBusy("");
    }
  }

  if (!tokenAddress) return null;

  // No LaunchFactory resolves for this chain (no deploy, no VITE_FACTORY_ADDRESS,
  // or the wallet is on the wrong network). `useTokenPool` disabled every read
  // rather than throwing, so explain it — and offer the network switch — instead
  // of rendering a panel wired to a factory that doesn't exist.
  if (!pool.factoryConfigured) {
    return (
      <div data-testid="trade-panel" className="h-fit">
        <LaunchpadUnavailableNotice />
      </div>
    );
  }

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

  // The token is a real launch, but its live venue config no longer resolves a
  // pool (an owner repointed the dexId's factory) and we have no stored fallback
  // pool. Explain it instead of rendering a permanently-dead Swap button.
  if (pool.poolUnavailable) {
    return (
      <div
        data-testid="trade-panel"
        className="h-fit rounded border border-slate-700 p-4 text-sm text-amber-400"
      >
        Pool unavailable for this token's venue — trading disabled.
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
      <div className="mb-4 empty:hidden">
        <WrongNetworkBanner />
      </div>

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
        busy={busy}
        busyWhen="swap"
        disabled={!canSwap}
        className="mt-4 w-full rounded bg-sky-600 px-4 py-2 font-semibold disabled:opacity-40"
        onClick={() => void submitSwap()}
      >
        Swap
      </BusyButton>
    </div>
  );
}
