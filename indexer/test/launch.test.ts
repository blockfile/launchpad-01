import { describe, expect, it } from "vitest";
import { buildTokenRow } from "../src/lib/launch";

const ARGS = {
  token: "0x1111111111111111111111111111111111111111" as const,
  deployer: "0x2222222222222222222222222222222222222222" as const,
  pool: "0x3333333333333333333333333333333333333333" as const,
  launchConfigId: 0n,
  dexId: 0n,
  supply: 1_000_000_000n * 10n ** 18n,
  initialBuyAmount: 0n,
};

const LAUNCHED_TOKEN = {
  pairedToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const, // real WETH, chain 4663
  isToken0: false,
  poolFee: 10_000,
  restrictionsEndBlock: 8_991_120n,
};

const METADATA = {
  name: "Test Token",
  symbol: "TEST",
  decimals: 18,
  logo: "ipfs://logo",
  description: "a test token",
  socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
};

describe("buildTokenRow", () => {
  it("maps the event + reads into the tokens insert row", () => {
    const row = buildTokenRow(
      ARGS,
      LAUNCHED_TOKEN,
      METADATA,
      4_200_000_000_000_000_000n,
      ARGS.supply, // no dev buy: the whole supply sits in the pool
      { blockNumber: 8_991_118n, blockTimestamp: 1_755_800_000n, txHash: "0xaaaa" as `0x${string}` },
    );
    expect(row.address).toBe(ARGS.token);
    expect(row.poolAddress).toBe(ARGS.pool);
    expect(row.isToken0).toBe(false);
    expect(row.supply).toBe(ARGS.supply);
    expect(row.holderCount).toBe(1); // the pool is the one known holder pre-dev-buy
    expect(row.lastPrice18).toBeNull();
  });

  it("holderCount is 0 in the degenerate case of an empty pool balance", () => {
    const row = buildTokenRow(ARGS, LAUNCHED_TOKEN, METADATA, 0n, 0n, {
      blockNumber: 1n,
      blockTimestamp: 1n,
      txHash: "0xbbbb" as `0x${string}`,
    });
    expect(row.holderCount).toBe(0);
  });
});
