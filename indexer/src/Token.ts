import { ponder } from "ponder:registry";
import { holders, tokens } from "ponder:schema";
import { applyTransfer } from "./lib/holders";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

ponder.on("Token:Transfer", async ({ event, context }) => {
  const tokenAddress = event.log.address;
  const { from, to, value } = event.args;
  if (from === to || value === 0n) return;

  const fromId = `${tokenAddress}-${from}`;
  const toId = `${tokenAddress}-${to}`;
  // Two independent LOCAL database reads, not chain RPC calls — the
  // sequential/Multicall3 RPC-hardening rule targets chain reads only.
  const [fromRow, toRow] = await Promise.all([
    from === ZERO_ADDRESS ? Promise.resolve(null) : context.db.find(holders, { id: fromId }),
    context.db.find(holders, { id: toId }),
  ]);

  const delta = applyTransfer(fromRow?.balance, toRow?.balance, value, from === ZERO_ADDRESS);

  if (from !== ZERO_ADDRESS) {
    await context.db
      .insert(holders)
      .values({ id: fromId, tokenAddress, holderAddress: from, balance: delta.fromBalance })
      .onConflictDoUpdate({ balance: delta.fromBalance });
  }
  // Symmetric with the `from` guard above: the zero address is never a
  // tracked holder. No burn path exists on this Token.sol today, but this
  // keeps the invariant future-proof if one is ever added.
  if (to !== ZERO_ADDRESS) {
    await context.db
      .insert(holders)
      .values({ id: toId, tokenAddress, holderAddress: to, balance: delta.toBalance })
      .onConflictDoUpdate({ balance: delta.toBalance });
  }

  // Mirrors the write guard above: the zero address is never a tracked
  // holder, so a hypothetical future burn (to === ZERO_ADDRESS) must not
  // count as a "new holder" crossing even if the raw delta says so.
  const toCounts = to !== ZERO_ADDRESS && delta.toCrossedFromZero;
  if (delta.fromCrossedToZero || toCounts) {
    // The launch-tx transfers (constructor mint, factory→pool seed, optional
    // dev buy) all run before LaunchFactory's TokenLaunched handler inserts
    // the `tokens` row — Ponder dispatches in (block, logIndex) order and
    // those transfers have lower log indices. holderCount is baseline-seeded
    // by buildTokenRow (launch.ts, from a direct balanceOf read) once that
    // row lands, so these pre-launch crossings must NOT adjust it — skip
    // silently when the row isn't there yet rather than crashing.
    const tokenRow = await context.db.find(tokens, { address: tokenAddress });
    if (tokenRow) {
      await context.db.update(tokens, { address: tokenAddress }).set((row) => ({
        holderCount: row.holderCount + (toCounts ? 1 : 0) - (delta.fromCrossedToZero ? 1 : 0),
      }));
    }
  }
});
