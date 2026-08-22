import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useReadContract, useReadContracts } from "wagmi";
import { fetchLaunchConfigs } from "./indexer/client";
import { usePredictedTokenAddress, useAvailableLaunchConfigs } from "./launchConfig";

// This module talks to two collaborators we don't want live in this unit
// test: wagmi's chain-reading hooks (so we can assert exactly what's passed
// to them, per the brief's Step 1) and the indexer client (so we can force
// the B-unavailable fallback path deterministically).
vi.mock("wagmi", () => ({
  useReadContract: vi.fn(),
  useReadContracts: vi.fn(),
}));
vi.mock("./contracts", () => ({
  resolveAddress: vi.fn(() => "0x1234567890123456789012345678901234567890"),
}));
vi.mock("./indexer/client", () => ({
  fetchLaunchConfigs: vi.fn(),
}));

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

const baseTokenParams = {
  name: "Foo",
  symbol: "FOO",
  logo: "ipfs://logo-a",
  description: "a token",
  socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
  feeWallet: "0x0000000000000000000000000000000000000000",
};

describe("usePredictedTokenAddress", () => {
  it("recomputes the read args when params.logo changes (different CREATE2 preimage)", () => {
    vi.mocked(useReadContract).mockReturnValue({ data: undefined } as never);

    const initialProps = {
      chainId: 4663,
      params: baseTokenParams,
      launchConfigId: 0n,
      dexId: 0n,
      salt: "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
      deployer: "0x000000000000000000000000000000000000dEaD" as `0x${string}`,
    };
    const { rerender } = renderHook((props) => usePredictedTokenAddress(props), { initialProps });

    const firstArgs = vi.mocked(useReadContract).mock.calls.at(-1)?.[0];
    expect((firstArgs?.args?.[0] as typeof baseTokenParams).logo).toBe("ipfs://logo-a");

    rerender({ ...initialProps, params: { ...baseTokenParams, logo: "ipfs://logo-b" } });

    const secondArgs = vi.mocked(useReadContract).mock.calls.at(-1)?.[0];
    expect((secondArgs?.args?.[0] as typeof baseTokenParams).logo).toBe("ipfs://logo-b");
    // The two calls must not share the same (memoized-away) args reference —
    // a changed logo has to reach wagmi's query key so it re-reads on-chain.
    expect(firstArgs?.args).not.toBe(secondArgs?.args);
    expect(firstArgs?.args?.[0]).not.toEqual(secondArgs?.args?.[0]);
  });
});

describe("useAvailableLaunchConfigs", () => {
  it("falls back to an on-chain 0-9 probe when B's /launch-configs errors, keeping only enabled ids", async () => {
    vi.mocked(fetchLaunchConfigs).mockRejectedValue(new Error("indexer down"));

    // 20 entries: [getLaunchConfig(0), getDexConfig(0), getLaunchConfig(1), getDexConfig(1), ...].
    // Only id 0's pair is enabled, per the brief's Step 1.
    const probeData = Array.from({ length: 20 }, (_, i) => ({
      result: { enabled: i === 0 || i === 1 },
    }));
    vi.mocked(useReadContracts).mockReturnValue({ data: probeData } as never);

    const { result } = renderHook(() => useAvailableLaunchConfigs(4663), { wrapper: createWrapper() });

    const call = vi.mocked(useReadContracts).mock.calls.at(-1)?.[0];
    const contracts = (call?.contracts ?? []) as ReadonlyArray<{
      functionName: string;
      args?: readonly unknown[];
    }>;
    expect(contracts).toHaveLength(20);
    expect(contracts.filter((c) => c.functionName === "getLaunchConfig")).toHaveLength(10);
    expect(contracts.filter((c) => c.functionName === "getDexConfig")).toHaveLength(10);
    expect(contracts.map((c) => c.args?.[0])).toEqual(
      Array.from({ length: 10 }, (_, i) => BigInt(i)).flatMap((id) => [id, id]),
    );

    await waitFor(() => expect(result.current).toEqual({ launchConfigIds: [0], dexIds: [0] }));
  });
});
