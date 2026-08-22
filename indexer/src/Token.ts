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

  const delta = applyTransfer(fromRow?.balance, toRow?.balance, value);

  if (from !== ZERO_ADDRESS) {
    await context.db
      .insert(holders)
      .values({ id: fromId, tokenAddress, holderAddress: from, balance: delta.fromBalance })
      .onConflictDoUpdate({ balance: delta.fromBalance });
  }
  await context.db
    .insert(holders)
    .values({ id: toId, tokenAddress, holderAddress: to, balance: delta.toBalance })
    .onConflictDoUpdate({ balance: delta.toBalance });

  if (delta.fromCrossedToZero || delta.toCrossedFromZero) {
    await context.db.update(tokens, { address: tokenAddress }).set((row) => ({
      holderCount: row.holderCount + (delta.toCrossedFromZero ? 1 : 0) - (delta.fromCrossedToZero ? 1 : 0),
    }));
  }
});
