import { addresses, type ChainAddresses } from "@launchpad/shared";

const ENV_OVERRIDES: Partial<Record<keyof ChainAddresses, string | undefined>> = {
  factory: import.meta.env.VITE_FACTORY_ADDRESS,
  locker: import.meta.env.VITE_LOCKER_ADDRESS,
};

/** Human-readable contract names for error messages: `factory`/`locker` are our
 * own contracts (LaunchFactory / Locker); the rest are the DEX venue's. */
const CONTRACT_LABELS: Record<keyof ChainAddresses, string> = {
  factory: "LaunchFactory",
  locker: "Locker",
  weth: "WETH",
  uniswapV3Factory: "UniswapV3Factory",
  positionManager: "PositionManager",
  swapRouter: "SwapRouter",
};

/** Resolves one contract address for a chain: a `VITE_*` env override (set for
 * local-Anvil dev/test) wins over `packages/shared`'s committed address, which
 * is `null` until a real deploy has happened. Throws with a clear message
 * rather than silently returning `null` into a downstream `useReadContract`. */
export function resolveAddress(chainId: number, key: keyof ChainAddresses): `0x${string}` {
  const chain = addresses[chainId];
  if (!chain) throw new Error(`No address config for chain ${chainId}`);
  const override = ENV_OVERRIDES[key];
  const resolved = override || chain[key];
  if (!resolved) {
    throw new Error(
      `No ${CONTRACT_LABELS[key]} address for chain ${chainId}. Set VITE_${key.toUpperCase()}_ADDRESS for local dev (e.g. a local-Anvil deploy), or wait for a real deploy to populate packages/shared/addresses/${chainId}.json.`,
    );
  }
  // Defensive: this address feeds irreversible swap/router writes. A zero
  // address in the JSON (or a blanked env override) must never flow through —
  // it would send funds/allowances to address(0). Reject it as loudly as a
  // missing one.
  if (/^0x0{40}$/i.test(resolved)) {
    throw new Error(
      `${CONTRACT_LABELS[key]} address for chain ${chainId} is the zero address — refusing to use it for a contract call. Fix packages/shared/addresses/${chainId}.json or the VITE_${key.toUpperCase()}_ADDRESS override.`,
    );
  }
  return resolved as `0x${string}`;
}
