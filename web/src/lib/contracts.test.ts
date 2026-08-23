import { describe, expect, it, vi } from "vitest";

// A fully controlled address map so we can assert every branch of
// `resolveAddress` — including a zero-address entry, which must be rejected as
// loudly as a missing one (it feeds irreversible swap/router writes).
vi.mock("@launchpad/shared", () => ({
  addresses: {
    999: {
      factory: "0x00000000000000000000000000000000000000A1",
      locker: null,
      weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      uniswapV3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
      positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
      // Deliberately the zero address — a misconfigured committed JSON.
      swapRouter: "0x0000000000000000000000000000000000000000",
    },
  },
}));

import { resolveAddress, resolveAddressOptional } from "./contracts";

describe("resolveAddress", () => {
  it("returns a valid configured address", () => {
    expect(resolveAddress(999, "weth")).toBe("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
  });

  it("throws for an unknown chain", () => {
    expect(() => resolveAddress(12345, "weth")).toThrow(/No address config for chain/i);
  });

  it("throws for a missing (null) address", () => {
    expect(() => resolveAddress(999, "locker")).toThrow(/No Locker address/i);
  });

  it("rejects the zero address so it can never flow into a swap/router call", () => {
    expect(() => resolveAddress(999, "swapRouter")).toThrow(/zero address/i);
  });
});

describe("resolveAddressOptional", () => {
  it("returns a valid configured address, same as the throwing variant", () => {
    expect(resolveAddressOptional(999, "weth")).toBe(
      "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    );
  });

  it("returns undefined (never throws) for an unknown chain — a render path must not blank the app", () => {
    expect(resolveAddressOptional(12345, "weth")).toBeUndefined();
  });

  it("returns undefined for a missing (null) address instead of throwing", () => {
    expect(resolveAddressOptional(999, "locker")).toBeUndefined();
  });

  it("rejects the zero address by returning undefined (same guard as the throwing variant, minus the throw)", () => {
    expect(resolveAddressOptional(999, "swapRouter")).toBeUndefined();
  });
});
