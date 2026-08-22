import { useReadContract } from "wagmi";
import { launchFactoryAbi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from "@launchpad/shared";
import { resolveAddress } from "./contracts";

const Q96 = 2n ** 96n;
const FEE_DENOMINATOR = 1_000_000n;
const BPS_DENOMINATOR = 10_000n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export type TradeSide = "buy" | "sell";

/** Spot-price-only estimate (no tick-walking — no Quoter exists on this chain).
 * `isToken0`/`tokenInIsPaired` together determine which direction the ratio
 * needs inverting. Both sides are always 18-decimal here (WETH + any
 * A-launched token), so no decimal-adjustment term is needed. */
export function spotAmountOut(args: {
  sqrtPriceX96: bigint;
  isToken0: boolean; // true: our token is token0, paired asset is token1
  tokenInIsPaired: boolean; // true: buying (paired-in, token-out); false: selling
  amountIn: bigint;
  poolFeePpm: number; // e.g. 10_000 == 1%, denominated /1e6 same as Uniswap's `fee`
}): bigint {
  const { sqrtPriceX96, isToken0, tokenInIsPaired, amountIn, poolFeePpm } = args;
  const netIn = (amountIn * (FEE_DENOMINATOR - BigInt(poolFeePpm))) / FEE_DENOMINATOR;
  // priceX192 = (token1 per token0) at Q192 fixed point
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  // "buying with the paired asset while our token is token0" means paired
  // (token1) is the input and our token (token0) is the output: divide by price.
  const pairedIsToken1Input = tokenInIsPaired === isToken0;
  if (pairedIsToken1Input) {
    return (netIn * Q96 * Q96) / priceX192;
  }
  return (netIn * priceX192) / (Q96 * Q96);
}

export function applySlippage(amountOutEstimate: bigint, slippageBps: number): bigint {
  return (amountOutEstimate * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

/** Provenance + pool resolution for one launched token. Chains three reads:
 *  1. our factory's `getLaunchedToken` → `dexId`/`pairedToken`/`poolFee`/`isToken0`
 *     plus `exists` (the provenance gate) and `restrictionsEndBlock`.
 *  2. `getDexConfig(dexId).factory` → the DEX's own Uniswap V3 factory (a token
 *     may target a non-default venue, so this is read, never assumed).
 *  3. `IUniswapV3Factory.getPool(token, pairedToken, poolFee)` → the REAL pool
 *     address. It is derived here, never trusted off the `LaunchedToken` struct
 *     (which doesn't carry it). */
export interface TokenPool {
  pool?: `0x${string}`;
  pairedToken?: `0x${string}`;
  isToken0?: boolean;
  poolFeePpm?: number;
  dexId?: bigint;
  /** The token's OWN venue router, read from `getDexConfig(dexId).swapRouter`.
   * A token launched under a non-default dexId points at a different router —
   * the swap path MUST use this one, never a chain-wide default, or the trade
   * routes through the wrong venue (or an attacker's pre-seeded pool). */
  swapRouter?: `0x${string}`;
  /** `getLaunchConfig(launchConfigId).routerRequiresDeadline` — selects which
   * `exactInputSingle` ABI shape the token's router expects. `false` for the
   * live default deployment (SwapRouter02, no deadline). */
  routerRequiresDeadline?: boolean;
  /** `getLaunchedToken(...).exists` — false ⇒ token failed provenance, refuse to trade. */
  exists: boolean;
  /** True when the token exists but its LIVE `getDexConfig(dexId).factory` no
   * longer derives a pool for it (`getPool` → `address(0)`) AND no immutable
   * fallback pool was supplied. This happens when an owner repoints an in-use
   * dexId's factory (`LaunchedToken` does not snapshot `factory`/`swapRouter`).
   * Callers MUST surface a clear "trading disabled" state rather than render a
   * silently-dead Swap button. */
  poolUnavailable: boolean;
  restrictionsEndBlock?: bigint;
  isLoading: boolean;
}

interface LaunchedTokenStruct {
  pairedToken: `0x${string}`;
  dexId: bigint;
  launchConfigId: bigint;
  restrictionsEndBlock: bigint;
  isToken0: boolean;
  poolFee: number;
  exists: boolean;
}

interface DexConfigStruct {
  factory: `0x${string}`;
  swapRouter: `0x${string}`;
}

interface LaunchConfigStruct {
  routerRequiresDeadline: boolean;
}

export function useTokenPool(
  tokenAddress: `0x${string}` | undefined,
  chainId: number,
  /** B's stored `poolAddress` for this token (from `fetchToken`), immutable from
   * the launch event. Used ONLY to fill a live `getPool` zero when the DEX
   * config drifted — never to override a live pool. */
  fallbackPool?: `0x${string}`,
): TokenPool {
  const factory = resolveAddress(chainId, "factory");

  const launched = useReadContract({
    address: factory,
    abi: launchFactoryAbi,
    functionName: "getLaunchedToken",
    args: [tokenAddress ?? ZERO_ADDRESS],
    query: { enabled: Boolean(tokenAddress) },
  });
  const token = launched.data as LaunchedTokenStruct | undefined;
  const exists = Boolean(token?.exists);

  const dexConfig = useReadContract({
    address: factory,
    abi: launchFactoryAbi,
    functionName: "getDexConfig",
    args: [token?.dexId ?? 0n],
    query: { enabled: exists && token?.dexId !== undefined },
  });
  const dexConfigData = dexConfig.data as DexConfigStruct | undefined;
  const dexFactory = dexConfigData?.factory;
  // The token's OWN router — same per-dexId read as the factory above. Never
  // fall back to a chain-wide default: a differing router means a differing
  // (possibly hostile) venue.
  const swapRouter = dexConfigData?.swapRouter;

  // `routerRequiresDeadline` lives on the token's LaunchConfig, not its
  // DexConfig — read it so the swap builders can select the matching
  // exactInputSingle overload (false for the live SwapRouter02 default).
  const launchConfig = useReadContract({
    address: factory,
    abi: launchFactoryAbi,
    functionName: "getLaunchConfig",
    args: [token?.launchConfigId ?? 0n],
    query: { enabled: exists && token?.launchConfigId !== undefined },
  });
  const routerRequiresDeadline = (launchConfig.data as LaunchConfigStruct | undefined)
    ?.routerRequiresDeadline;

  const poolRead = useReadContract({
    address: dexFactory,
    abi: uniswapV3FactoryAbi,
    functionName: "getPool",
    args: [
      tokenAddress ?? ZERO_ADDRESS,
      token?.pairedToken ?? ZERO_ADDRESS,
      token?.poolFee ?? 0,
    ],
    query: { enabled: Boolean(dexFactory) && Boolean(tokenAddress) && token?.poolFee !== undefined },
  });
  const poolAddress = poolRead.data as `0x${string}` | undefined;
  const livePool = poolAddress && poolAddress !== ZERO_ADDRESS ? poolAddress : undefined;
  // Fall back to B's immutable stored pool ONLY to fill a live zero (config
  // drift), never to override a live pool the factory still resolves.
  const fallback = fallbackPool && fallbackPool !== ZERO_ADDRESS ? fallbackPool : undefined;
  const pool = livePool ?? (exists ? fallback : undefined);
  // The live `getDexConfig` factory resolved but `getPool` returned zero for an
  // existing token, and there is no fallback pool: the venue config drifted and
  // there is nothing to trade against. Surface it (TradePanel shows a clear
  // "trading disabled" message) rather than leaving a silently-dead Swap button.
  const poolUnavailable =
    exists &&
    Boolean(dexFactory) &&
    !poolRead.isLoading &&
    livePool === undefined &&
    fallback === undefined;

  return {
    pool,
    pairedToken: token?.pairedToken,
    isToken0: token?.isToken0,
    poolFeePpm: token?.poolFee !== undefined ? Number(token.poolFee) : undefined,
    dexId: token?.dexId,
    swapRouter,
    routerRequiresDeadline,
    exists,
    poolUnavailable,
    restrictionsEndBlock: token?.restrictionsEndBlock,
    isLoading:
      launched.isLoading || dexConfig.isLoading || launchConfig.isLoading || poolRead.isLoading,
  };
}

/** Reads the pool's live `slot0().sqrtPriceX96` and turns an `amountIn` into a
 * spot-price estimate. `amountOutEstimate` is `0n` whenever the quote is
 * unresolved (no pool, no price, or a zero/blank input) — callers MUST disable
 * the swap in that case rather than send a min-out of 0. `refetch()` re-reads
 * `slot0` on demand so a write path can price against the CURRENT tick instead
 * of a polled value; the read also polls on an interval for the live display. */
export interface SpotQuote {
  sqrtPriceX96?: bigint;
  amountOutEstimate: bigint;
  minAmountOut: (slippageBps: number) => bigint;
  refetch: () => Promise<unknown>;
  isLoading: boolean;
}

export function useSpotQuote(args: {
  pool: `0x${string}` | undefined;
  isToken0: boolean | undefined;
  poolFeePpm: number | undefined;
  side: TradeSide;
  amountIn: bigint;
}): SpotQuote {
  const { pool, isToken0, poolFeePpm, side, amountIn } = args;

  const slot0 = useReadContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    query: {
      enabled: Boolean(pool),
      // Poll for the live display; the write path calls `refetch()` for a fresh
      // read immediately before pricing (see Task 12).
      refetchInterval: 12_000,
    },
  });

  const slot0Data = slot0.data as readonly [bigint, ...unknown[]] | undefined;
  const sqrtPriceX96 = slot0Data?.[0];

  const resolved =
    sqrtPriceX96 !== undefined &&
    sqrtPriceX96 > 0n &&
    isToken0 !== undefined &&
    poolFeePpm !== undefined &&
    amountIn > 0n;

  const amountOutEstimate = resolved
    ? spotAmountOut({
        sqrtPriceX96,
        isToken0,
        tokenInIsPaired: side === "buy",
        amountIn,
        poolFeePpm,
      })
    : 0n;

  return {
    sqrtPriceX96,
    amountOutEstimate,
    minAmountOut: (slippageBps: number) => applySlippage(amountOutEstimate, slippageBps),
    refetch: () => slot0.refetch(),
    isLoading: slot0.isLoading,
  };
}
