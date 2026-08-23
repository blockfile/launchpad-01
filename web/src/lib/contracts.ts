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

/** Non-throwing counterpart of {@link resolveAddress} for RENDER paths.
 *
 * Returns the resolved address, or `undefined` when the chain is unknown, the
 * committed/overridden address is null/unset, or it is the zero address — the
 * exact three cases {@link resolveAddress} throws on. Same env-override
 * precedence and zero-address rejection, just no throw.
 *
 * A render-time hook (the Launch/Trade contract reads) MUST NOT throw: an
 * uncaught throw during render unmounts the whole React tree, blanking the app.
 * So those hooks resolve with this variant and gate their wagmi reads on the
 * result (`query.enabled`), surfacing a friendly "not available on this
 * network" state instead of crashing. Keep the throwing {@link resolveAddress}
 * for imperative WRITE paths, where a null address must hard-fail loudly before
 * a transaction is ever sent. */
export function resolveAddressOptional(
  chainId: number,
  key: keyof ChainAddresses,
): `0x${string}` | undefined {
  const chain = addresses[chainId];
  if (!chain) return undefined;
  const resolved = ENV_OVERRIDES[key] || chain[key];
  if (!resolved || /^0x0{40}$/i.test(resolved)) return undefined;
  return resolved as `0x${string}`;
}
