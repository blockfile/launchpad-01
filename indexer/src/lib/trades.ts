import { sqrtPriceX96ToPrice18 } from "./price";

export interface SwapArgs {
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
}

export interface TradeDerivation {
  side: "buy" | "sell";
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
  price18: bigint;
}

/** Derives trade side + amounts from a Uniswap V3 Swap's signed deltas. Sign
 * convention: a signed amount is the POOL's own balance delta — negative
 * means the pool paid that token out. The launched token flowing out of the
 * pool is therefore a buy; flowing in is a sell. */
export function deriveTrade(
  args: SwapArgs,
  isToken0: boolean,
  tokenDecimals: number,
  quoteDecimals: number,
): TradeDerivation {
  const tokenAmountSigned = isToken0 ? args.amount0 : args.amount1;
  const quoteAmountSigned = isToken0 ? args.amount1 : args.amount0;
  const side: "buy" | "sell" = tokenAmountSigned < 0n ? "buy" : "sell";
  return {
    side,
    tokenAmountRaw: tokenAmountSigned < 0n ? -tokenAmountSigned : tokenAmountSigned,
    quoteAmountRaw: quoteAmountSigned < 0n ? -quoteAmountSigned : quoteAmountSigned,
    price18: sqrtPriceX96ToPrice18(args.sqrtPriceX96, isToken0, tokenDecimals, quoteDecimals),
  };
}
