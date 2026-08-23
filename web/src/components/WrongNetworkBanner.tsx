import { useAccount, useSwitchChain } from "wagmi";
import { ROBINHOOD_CHAIN_ID, SUPPORTED_CHAIN_IDS } from "../lib/chains";

export interface NetworkStatus {
  isConnected: boolean;
  chainId: number | undefined;
  /** Connected, but to a chain the app isn't configured for. */
  isWrongNetwork: boolean;
  /** Ask the wallet to switch to Robinhood Chain (4663). */
  switchToRobinhood: () => void;
  isSwitching: boolean;
}

/** Derives connect / wrong-network state from wagmi. `isWrongNetwork` is true
 * only while a wallet is actually connected to an unsupported chain — a
 * disconnected wallet is "not connected", never "wrong network". */
export function useNetworkStatus(): NetworkStatus {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const isWrongNetwork =
    Boolean(isConnected) && chainId !== undefined && !SUPPORTED_CHAIN_IDS.includes(chainId);
  return {
    isConnected: Boolean(isConnected),
    chainId,
    isWrongNetwork,
    switchToRobinhood: () => switchChain({ chainId: ROBINHOOD_CHAIN_ID }),
    isSwitching: isPending,
  };
}

/** Renders a switch-network prompt when the connected wallet is on an
 * unsupported chain, and nothing otherwise (so it's safe to drop at the top of
 * any write surface). This is the fix for a user who "sees no ETH": their
 * wallet is simply on the wrong chain relative to what the app reads. */
export function WrongNetworkBanner() {
  const { isWrongNetwork, switchToRobinhood, isSwitching } = useNetworkStatus();
  if (!isWrongNetwork) return null;
  return (
    <div
      data-testid="wrong-network-banner"
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-200"
    >
      <span>
        Wrong network — switch to <strong>Robinhood Chain</strong> to see your balance and continue.
      </span>
      <button
        type="button"
        onClick={switchToRobinhood}
        disabled={isSwitching}
        className="rounded bg-amber-600 px-3 py-1 font-semibold text-amber-50 disabled:opacity-40"
      >
        {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
      </button>
    </div>
  );
}
