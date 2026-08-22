import { encodeFunctionData, type Abi, type AbiFunction } from "viem";
import { swapRouter02Abi } from "@launchpad/shared";

// -------------------------------------------------------------------------
// Overload pinning (load-bearing safety)
// -------------------------------------------------------------------------
// `swapRouter02Abi` carries BOTH exactInputSingle overloads (Task 2): the
// 7-field no-deadline shape AND the 8-field with-deadline shape. The live
// SwapRouter02 (Deploy.s.sol wires dexId 0 with routerRequiresDeadline=false)
// uses the NO-deadline one. If we handed the full ABI to viem and let it pick
// the overload from the args, a future viem change or ABI reordering could
// resolve to the 8-field shape — which on-chain would slot `amountIn` into the
// `deadline` field and move a user's funds against a garbage min-out. So we
// select the exact 7-field item HERE, once, by structure (a single tuple input
// with exactly 7 components), independent of array order, and encode only
// against it. viem then has a single candidate and cannot mis-resolve.
const exactInputSingleNoDeadline = (swapRouter02Abi as readonly AbiFunction[]).find(
  (item) =>
    item.type === "function" &&
    item.name === "exactInputSingle" &&
    item.inputs.length === 1 &&
    item.inputs[0].type === "tuple" &&
    (item.inputs[0] as { components?: readonly unknown[] }).components?.length === 7,
);
if (!exactInputSingleNoDeadline) {
  throw new Error(
    "swapRouter02Abi is missing the no-deadline exactInputSingle (7-field) overload — cannot build a swap safely.",
  );
}

/** A single-item ABI pinned to the no-deadline `exactInputSingle` overload.
 * Exported so the write path (and its tests) encode against exactly this. */
export const exactInputSingleAbi = [exactInputSingleNoDeadline] as unknown as Abi;

/** The 7-field `exactInputSingle` params, in the exact struct-field order the
 * live router expects (no `deadline`). */
export interface ExactInputSingleParams {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  recipient: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
}

/** The exact object `writeContract` needs for a BUY. */
export interface BuyCall {
  address: `0x${string}`;
  abi: Abi;
  functionName: "exactInputSingle";
  args: readonly [ExactInputSingleParams];
  value: bigint;
}

/** The exact object `writeContract` needs for a SELL (a router multicall). */
export interface SellCall {
  address: `0x${string}`;
  abi: typeof swapRouter02Abi;
  functionName: "multicall";
  args: readonly [readonly `0x${string}`[]];
  value: bigint;
}

/**
 * BUY = `exactInputSingle(WETH -> token)` with the connected wallet as the
 * recipient and the WETH input supplied as native `msg.value` (SwapRouter02
 * wraps it — no separate deposit). `amountOutMinimum` is the caller's REAL,
 * slippage-floored minimum (never 0 on the live path — enforced by the panel);
 * this builder passes it through verbatim. `sqrtPriceLimitX96 = 0` (no limit).
 */
export function buildBuyCall(args: {
  router: `0x${string}`;
  weth: `0x${string}`;
  token: `0x${string}`;
  poolFee: number;
  recipient: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
}): BuyCall {
  const params: ExactInputSingleParams = {
    tokenIn: args.weth,
    tokenOut: args.token,
    fee: args.poolFee,
    recipient: args.recipient,
    amountIn: args.amountIn,
    amountOutMinimum: args.minAmountOut,
    sqrtPriceLimitX96: 0n,
  };
  return {
    address: args.router,
    abi: exactInputSingleAbi,
    functionName: "exactInputSingle",
    args: [params],
    // Native value IS the WETH input; equals amountIn exactly (no leftover to
    // refund).
    value: args.amountIn,
  };
}

/**
 * SELL = `multicall([ exactInputSingle(token -> WETH, recipient = the router
 * itself), unwrapWETH9(0, seller) ])`.
 *
 * The swap's recipient MUST be the router literal, NEVER `address(0)`: passing
 * `address(0)` reverts "TF" on this exact deployment. The WETH stays parked in
 * the router until the second call unwraps it to native ETH for the seller.
 *
 * `unwrapWETH9`'s `amountMinimum = 0` is safe — NOT a skipped slippage floor:
 * `exactInputSingle`'s own `amountOutMinimum` (the caller's REAL min-out)
 * already bounds the WETH balance being unwrapped. Because `exactInputSingle`
 * consumes exactly `amountIn`, no token allowance is left standing afterward.
 */
export function buildSellCall(args: {
  router: `0x${string}`;
  weth: `0x${string}`;
  token: `0x${string}`;
  poolFee: number;
  seller: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
}): SellCall {
  const swapParams: ExactInputSingleParams = {
    tokenIn: args.token,
    tokenOut: args.weth,
    fee: args.poolFee,
    recipient: args.router, // the router itself — never address(0)
    amountIn: args.amountIn,
    amountOutMinimum: args.minAmountOut,
    sqrtPriceLimitX96: 0n,
  };
  const swapCalldata = encodeFunctionData({
    abi: exactInputSingleAbi,
    functionName: "exactInputSingle",
    args: [swapParams],
  });
  const unwrapCalldata = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "unwrapWETH9",
    args: [0n, args.seller],
  });
  return {
    address: args.router,
    abi: swapRouter02Abi,
    functionName: "multicall",
    args: [[swapCalldata, unwrapCalldata]],
    value: 0n,
  };
}
