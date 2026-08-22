export const INTERVALS = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 } as const;
export type Interval = keyof typeof INTERVALS;

export function bucketStart(timestampSeconds: bigint, interval: Interval): bigint {
  const size = BigInt(INTERVALS[interval]);
  return (timestampSeconds / size) * size;
}

export interface CandleAccumulator {
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volumeToken: bigint;
  volumeQuote: bigint;
  tradeCount: number;
}

export interface TradeForCandle {
  price18: bigint;
  tokenAmountRaw: bigint;
  quoteAmountRaw: bigint;
}

/** Materializes one trade into a candle bucket incrementally — no re-scan of
 * `trades` ever needed to keep OHLCV current. */
export function applyTradeToCandle(existing: CandleAccumulator | undefined, trade: TradeForCandle): CandleAccumulator {
  if (!existing) {
    return {
      open: trade.price18, high: trade.price18, low: trade.price18, close: trade.price18,
      volumeToken: trade.tokenAmountRaw, volumeQuote: trade.quoteAmountRaw, tradeCount: 1,
    };
  }
  return {
    open: existing.open,
    high: trade.price18 > existing.high ? trade.price18 : existing.high,
    low: trade.price18 < existing.low ? trade.price18 : existing.low,
    close: trade.price18,
    volumeToken: existing.volumeToken + trade.tokenAmountRaw,
    volumeQuote: existing.volumeQuote + trade.quoteAmountRaw,
    tradeCount: existing.tradeCount + 1,
  };
}
