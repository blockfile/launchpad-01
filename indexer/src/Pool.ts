import { ponder } from "ponder:registry";
import { candles, pools, tokens, trades } from "ponder:schema";
import { INTERVALS, applyTradeToCandle, bucketStart } from "./lib/candles";
import { deriveTrade } from "./lib/trades";

const QUOTE_DECIMALS = 18; // A's LaunchConfig.pairToken is WETH-only (contracts spec)

ponder.on("Pool:Swap", async ({ event, context }) => {
  const poolAddress = event.log.address;
  const pool = await context.db.find(pools, { address: poolAddress });
  if (!pool) return; // defensive: the factory pattern only invokes this for a registered pool
  const token = await context.db.find(tokens, { address: pool.tokenAddress });
  if (!token) return;

  const trade = deriveTrade(
    { amount0: event.args.amount0, amount1: event.args.amount1, sqrtPriceX96: event.args.sqrtPriceX96 },
    token.isToken0,
    token.decimals,
    QUOTE_DECIMALS,
  );

  await context.db.insert(trades).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    tokenAddress: token.address,
    poolAddress,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    side: trade.side,
    traderAddress: event.args.recipient, // the swap's beneficiary — `sender` is often a router
    tokenAmountRaw: trade.tokenAmountRaw,
    quoteAmountRaw: trade.quoteAmountRaw,
    price18: trade.price18,
  });

  await context.db
    .update(tokens, { address: token.address })
    .set({ lastPrice18: trade.price18, lastTradeAt: event.block.timestamp });

  for (const interval of Object.keys(INTERVALS) as Array<keyof typeof INTERVALS>) {
    const bucket = bucketStart(event.block.timestamp, interval);
    const candleId = `${token.address}-${interval}-${bucket}`;
    const existing = await context.db.find(candles, { id: candleId });
    const updated = applyTradeToCandle(existing ?? undefined, {
      price18: trade.price18,
      tokenAmountRaw: trade.tokenAmountRaw,
      quoteAmountRaw: trade.quoteAmountRaw,
    });
    await context.db
      .insert(candles)
      .values({ id: candleId, tokenAddress: token.address, interval, bucketStart: bucket, ...updated })
      .onConflictDoUpdate(updated);
  }
});
