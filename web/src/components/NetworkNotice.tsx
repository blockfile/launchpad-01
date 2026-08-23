import { WrongNetworkBanner } from "./WrongNetworkBanner";

/** The calm, instructive state shown by Launch/Trade when no LaunchFactory
 * address resolves for the target chain (no deploy, no `VITE_FACTORY_ADDRESS`).
 * It replaces the write surface entirely — a form/panel wired to a factory that
 * doesn't exist can only mislead — and folds in the wrong-network switch prompt,
 * since "wrong chain" is the most common reason nothing is configured. */
export function LaunchpadUnavailableNotice() {
  return (
    <div
      data-testid="network-notice"
      role="status"
      className="grid gap-3 rounded border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-200"
    >
      <p className="font-semibold text-amber-100">Not available on this network</p>
      <p className="text-amber-200/90">
        The launchpad isn&apos;t available on this network yet. Switch to a network with a deployed
        factory, or for local development set <code className="rounded bg-slate-800 px-1">VITE_FACTORY_ADDRESS</code>{" "}
        (see the README).
      </p>
      <WrongNetworkBanner />
    </div>
  );
}
