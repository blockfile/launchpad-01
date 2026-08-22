export interface BalanceDelta {
  fromBalance: bigint;
  toBalance: bigint;
  fromCrossedToZero: boolean;
  toCrossedFromZero: boolean;
}

/** Pure running-balance update for one Transfer. Throws instead of silently
 * underflowing — a negative balance means an upstream bug (a missed event, a
 * bad reorg replay), never a valid on-chain state. */
export function applyTransfer(
  fromExistingBalance: bigint | undefined,
  toExistingBalance: bigint | undefined,
  value: bigint,
): BalanceDelta {
  const fromPrev = fromExistingBalance ?? 0n;
  const toPrev = toExistingBalance ?? 0n;
  const fromBalance = fromPrev - value;
  const toBalance = toPrev + value;
  // An undefined fromExistingBalance means "no holders row exists" — for the
  // zero address (the mint side of a constructor Transfer) that's expected
  // and not a real debit, so only a *defined* existing balance going negative
  // is treated as the underflow bug this guard exists to catch.
  if (fromExistingBalance !== undefined && fromBalance < 0n) {
    throw new Error(`holders.applyTransfer: negative balance (${fromBalance}) — sender had ${fromPrev}, sent ${value}`);
  }
  return {
    fromBalance,
    toBalance,
    fromCrossedToZero: fromPrev > 0n && fromBalance === 0n,
    toCrossedFromZero: toPrev === 0n && toBalance > 0n,
  };
}
