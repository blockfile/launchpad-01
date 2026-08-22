import { useReadContract, useReadContracts } from "wagmi";
import { launchFactoryAbi } from "@launchpad/shared";
import { useQuery } from "@tanstack/react-query";
import { resolveAddress } from "./contracts";
import { fetchLaunchConfigs } from "./indexer/client";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Live-reads the CREATE2-predicted token address for the in-progress Launch
 * form. `args.params` is the `TokenParams` tuple the form is building (kept
 * `unknown` here — this hook doesn't need to know its shape, only that it's
 * one of `predictTokenAddress`'s inputs), so any field change — including
 * `params.logo` — flows straight into `useReadContract`'s `args`, which is
 * part of wagmi's query key: the read recomputes on every such change, it is
 * never memoized away. Disabled until a `deployer` (the connected wallet) is
 * known, since the factory's CREATE2 salt is derived from it. */
export function usePredictedTokenAddress(args: {
  chainId: number;
  params: unknown; // TokenParams tuple, built by the Launch form
  launchConfigId: bigint;
  dexId: bigint;
  salt: `0x${string}`;
  deployer: `0x${string}` | undefined;
}) {
  const factory = resolveAddress(args.chainId, "factory");
  return useReadContract({
    address: factory,
    abi: launchFactoryAbi,
    functionName: "predictTokenAddress",
    args: [
      // Cast only this element: `params` is deliberately `unknown` here (this
      // hook doesn't own the `TokenParams` shape, the Launch form does), but
      // wagmi's generated `args` tuple type expects the exact struct — `never`
      // is assignable to any expected type without loosening the rest of the
      // (correctly bigint/hex-typed) tuple.
      args.params as never,
      args.launchConfigId,
      args.dexId,
      args.salt,
      args.deployer ?? ZERO_ADDRESS,
    ] as const,
    query: { enabled: Boolean(args.deployer) },
  });
}

/** Shape matches B's `/launch-configs` exactly: two independent enabled-id
 * lists (the config/dex id spaces are not pre-paired — a launch picks any
 * enabled `launchConfigId` together with any enabled `dexId`). The on-chain
 * probe fallback below produces the identical `{launchConfigIds, dexIds}`
 * shape so callers never branch on which source answered. */
export interface AvailableLaunchConfigs {
  launchConfigIds: number[];
  dexIds: number[];
}

const PROBE_IDS = Array.from({ length: 10 }, (_, i) => BigInt(i));

/** Tries B's indexed `/launch-configs` first (cheap, one HTTP round trip); it
 * falls back to a direct fixed 0-9 on-chain probe of the factory's
 * `getLaunchConfig`/`getDexConfig` (id space is capped at 10 by convention —
 * there is no on-chain "how many configs exist" accessor to page through),
 * keeping only the `enabled` ones. Both paths return the identical
 * `AvailableLaunchConfigs` shape.
 *
 * Crucially the probe fires not only when B *errors* but also when B answers
 * successfully with an EMPTY list in either dimension: B's `/launch-configs`
 * returns 200 `{launchConfigIds:[], dexIds:[]}` whenever its tables are empty
 * — the normal state in the deploy→index-lag window and after every resync.
 * Treating that empty-but-successful answer as "no options" froze the Launch
 * form's ids at 0n and made every submit revert; instead we fall through to the
 * on-chain probe and prefer its non-empty result over B's empty one. */
export function useAvailableLaunchConfigs(chainId: number): AvailableLaunchConfigs {
  const indexed = useQuery({ queryKey: ["launch-configs"], queryFn: fetchLaunchConfigs, retry: false });
  const factory = resolveAddress(chainId, "factory");

  const indexedData = indexed.data;
  // B "has nothing to offer" if it errored OR resolved with an empty list in
  // either dimension (a launch needs BOTH an enabled launchConfigId and an
  // enabled dexId, so an empty either side is unusable).
  const indexedUsable =
    !!indexedData && indexedData.launchConfigIds.length > 0 && indexedData.dexIds.length > 0;

  const probe = useReadContracts({
    contracts: PROBE_IDS.flatMap(
      (id) =>
        [
          { address: factory, abi: launchFactoryAbi, functionName: "getLaunchConfig", args: [id] },
          { address: factory, abi: launchFactoryAbi, functionName: "getDexConfig", args: [id] },
        ] as const,
    ),
    query: { enabled: indexed.isError || !indexedUsable },
  });

  // B's answer wins only when it is actually usable (non-empty in both lists).
  if (indexedUsable) return indexedData;

  // Otherwise prefer the on-chain probe's result, but only once it has resolved
  // to something non-empty — until then fall back to B's (possibly empty) data.
  if (probe.data) {
    const probed: AvailableLaunchConfigs = {
      launchConfigIds: PROBE_IDS.filter((_, i) => probe.data?.[i * 2]?.result?.enabled).map(Number),
      dexIds: PROBE_IDS.filter((_, i) => probe.data?.[i * 2 + 1]?.result?.enabled).map(Number),
    };
    if (probed.launchConfigIds.length > 0 || probed.dexIds.length > 0) return probed;
  }

  return indexedData ?? { launchConfigIds: [], dexIds: [] };
}
