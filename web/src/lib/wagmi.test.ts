import { describe, expect, it } from "vitest";
import { robinhoodChain, robinhoodTestnet } from "./wagmi";
import { resolveAddress } from "./contracts";

describe("wagmi chain config", () => {
  it("defines Robinhood Chain mainnet as id 4663", () => {
    expect(robinhoodChain.id).toBe(4663);
  });
  it("defines the testnet as id 46630", () => {
    expect(robinhoodTestnet.id).toBe(46630);
  });
});

describe("resolveAddress", () => {
  it("falls back to packages/shared's committed DEX addresses", () => {
    expect(resolveAddress(4663, "weth")).toBe("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
  });
  it("throws a clear error when factory is null and no env override is set", () => {
    expect(() => resolveAddress(4663, "factory")).toThrowError(/no LaunchFactory address/i);
  });
});
