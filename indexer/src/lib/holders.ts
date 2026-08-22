export interface BalanceDelta {
  fromBalance: bigint;
  toBalance: bigint;
  fromCrossedToZero: boolean;
  toCrossedFromZero: boolean;
}

/** Pure running-balance update for one Transfer. Throws instead of silently
 * underflowing — a negative balance means an upstream bug (a missed event, a
 * bad reorg replay), never a valid on-chain state. `isMint` must be passed
 * explicitly by the caller (true iff `from` is the zero address) — an
 * undefined `fromExistingBalance` is ambiguous on its own: it means either
 * "the zero address, never tracked, not a real debit" (skip the guard) or
 * "a real sender with no holders row at all, i.e. a missed event" (still an
 * underflow bug, must throw). */
export function applyTransfer(
  fromExistingBalance: bigint | undefined,
  toExistingBalance: bigint | undefined,
  value: bigint,
  isMint: boolean,
): BalanceDelta {
  const fromPrev = fromExistingBalance ?? 0n;
  const toPrev = toExistingBalance ?? 0n;
  const fromBalance = fromPrev - value;
  const toBalance = toPrev + value;
  if (!isMint && fromBalance < 0n) {
    throw new Error(`holders.applyTransfer: negative balance (${fromBalance}) — sender had ${fromPrev}, sent ${value}`);
  }
  return {
    fromBalance,
    toBalance,
    fromCrossedToZero: fromPrev > 0n && fromBalance === 0n,
    toCrossedFromZero: toPrev === 0n && toBalance > 0n,
  };
}
