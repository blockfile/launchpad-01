import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseEther,
  type Log,
} from "viem";
import { launchFactoryAbi } from "@launchpad/shared";

// --- Deterministic collaborators ------------------------------------------
// This is the irreversible Launch flow. The three load-bearing safety
// properties (modal freezes the request body, value == launchFee + devBuy
// EXACTLY, decode-then-navigate) are proved here against fully mocked chain
// I/O so the assertions are exact and no chain is required.
const FACTORY = getAddress("0x" + "f0".repeat(20)) as `0x${string}`;
const CONNECTED = getAddress("0x" + "11".repeat(20)) as `0x${string}`;
const PREDICTED = getAddress("0x" + "22".repeat(20)) as `0x${string}`;
const DEPLOYED = getAddress("0x" + "de".repeat(20)) as `0x${string}`;
const POOL = getAddress("0x" + "c0".repeat(20)) as `0x${string}`;
const LAUNCH_FEE = parseEther("0.01");

const h = vi.hoisted(() => ({
  writeContract: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
  reset: vi.fn(),
  state: {
    hash: undefined as `0x${string}` | undefined,
    receipt: undefined as { status?: string; logs?: unknown[] } | undefined,
    writeError: undefined as unknown,
    receiptError: undefined as unknown,
  },
  predicted: { current: undefined as string | undefined },
  launchFee: { current: 0n as bigint | undefined },
  // The optional (render-path) factory resolution. `undefined` ⇒ no factory
  // configured for this chain ⇒ the page shows its "not available" notice.
  factory: { current: undefined as `0x${string}` | undefined },
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: CONNECTED, isConnected: true, chainId: 4663 }),
  useChainId: () => 4663,
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  // Display-only balance behind the dev-buy "Max"/available helper. No
  // behavioral assertion depends on it; a fixed value keeps the read defined.
  useBalance: () => ({ data: { value: parseEther("10"), decimals: 18, symbol: "ETH" } }),
  useReadContract: () => ({ data: h.launchFee.current }),
  useWriteContract: () => ({
    writeContract: h.writeContract,
    data: h.state.hash,
    isPending: false,
    error: h.state.writeError,
    reset: h.reset,
  }),
  useWaitForTransactionReceipt: () => ({
    data: h.state.receipt,
    // Faithful to viem: a mined-but-reverted receipt RESOLVES with
    // status "reverted" (not isSuccess). A receipt with no status field is a
    // legacy success fixture.
    isSuccess: Boolean(h.state.receipt) && h.state.receipt?.status !== "reverted",
    isError: Boolean(h.state.receiptError),
    error: h.state.receiptError,
    isLoading: false,
  }),
}));

vi.mock("../lib/contracts", () => ({
  resolveAddress: () => FACTORY,
  resolveAddressOptional: () => h.factory.current,
}));

vi.mock("../lib/launchConfig", () => ({
  usePredictedTokenAddress: () => ({ data: h.predicted.current }),
  useAvailableLaunchConfigs: () => ({
    launchConfigIds: [0],
    dexIds: [0],
    factoryConfigured: Boolean(h.factory.current),
  }),
}));

vi.mock("../lib/toast", () => ({
  notify: (...args: unknown[]) => h.notify(...args),
}));

vi.mock("react-router", async (orig) => ({
  ...(await orig<typeof import("react-router")>()),
  useNavigate: () => h.navigate,
}));

// LogoField owns a whole IPFS-pin flow with its own test; here it's a plain
// stub whose button sets the (opaque, already-pinned) logo uri.
vi.mock("../components/LogoField", () => ({
  LogoField: ({ onChange }: { onChange: (uri: string) => void }) => (
    <button type="button" onClick={() => onChange("ipfs://logo")}>
      set-logo
    </button>
  ),
}));

import Launch from "./Launch";

/** Builds a real, decodable TokenLaunched log so the component's own
 * parseEventLogs runs for real (nothing about the decode path is mocked). */
function tokenLaunchedLog(token: `0x${string}`, deployer: `0x${string}`): Log {
  const topics = encodeEventTopics({
    abi: launchFactoryAbi,
    eventName: "TokenLaunched",
    args: { token, deployer },
  });
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [POOL, 0n, 0n, 1_000_000n, 0n],
  );
  return {
    address: FACTORY,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
    data,
    blockNumber: 1n,
    blockHash: `0x${"0".repeat(64)}`,
    logIndex: 0,
    transactionHash: `0x${"0".repeat(64)}`,
    transactionIndex: 0,
    removed: false,
  };
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Drive the form to a valid, armed, reviewed state and open the modal. */
function fillValidForm({ name = "Frozen Coin", symbol = "FRZ", devBuyEth = "1" } = {}) {
  fill(/^name/i, name);
  fill(/ticker/i, symbol);
  fireEvent.click(screen.getByRole("button", { name: /set-logo/i }));
  fill(/developer buy/i, devBuyEth);
}

beforeEach(() => {
  h.writeContract.mockReset();
  // Default: the write records a hash but no receipt (so the success/navigate
  // effect stays dormant for the freeze/value assertions).
  h.writeContract.mockImplementation(() => {
    h.state.hash = `0x${"a".repeat(64)}`;
  });
  h.navigate.mockReset();
  h.notify.mockReset();
  h.reset.mockReset();
  h.state.hash = undefined;
  h.state.receipt = undefined;
  h.state.writeError = undefined;
  h.state.receiptError = undefined;
  h.predicted.current = PREDICTED;
  h.launchFee.current = LAUNCH_FEE;
  h.factory.current = FACTORY;
});

describe("Launch", () => {
  it("renders a friendly 'not available on this network' notice (never a blank screen or dead form) when no factory resolves", () => {
    // The default local-dev state: no deploy and no VITE_FACTORY_ADDRESS, so the
    // optional render-path resolution yields undefined. Pre-fix, the throwing
    // resolveAddress blanked the whole app; now the page explains itself.
    h.factory.current = undefined;
    render(<Launch />);

    expect(screen.getByTestId("network-notice")).toBeInTheDocument();
    expect(screen.getByText(/not available on this network/i)).toBeInTheDocument();
    expect(screen.getByText(/VITE_FACTORY_ADDRESS/)).toBeInTheDocument();
    // The dead form must NOT render.
    expect(screen.queryByLabelText(/^name/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("launch-cta")).not.toBeInTheDocument();
  });

  it("shows the predicted address only once name, symbol and logo are all set", async () => {
    render(<Launch />);
    expect(screen.queryByTestId("predicted-address")).not.toBeInTheDocument();

    fill(/^name/i, "Frozen Coin");
    fill(/ticker/i, "FRZ");
    expect(screen.queryByTestId("predicted-address")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /set-logo/i }));

    const predicted = await screen.findByTestId("predicted-address");
    expect(predicted).toHaveTextContent(PREDICTED);
  });

  it("keeps the primary Launch action disabled until the arm switch is checked", async () => {
    render(<Launch />);
    fillValidForm();

    const review = screen.getByTestId("launch-cta");
    await waitFor(() => expect(review).toBeDisabled());

    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));
    await waitFor(() => expect(review).toBeEnabled());
  });

  it("freezes the request body at Review: a later field edit changes neither the modal nor the write args", async () => {
    render(<Launch />);
    fillValidForm({ name: "Frozen Coin", devBuyEth: "1" });
    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));

    const review = screen.getByTestId("launch-cta");
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);

    // Modal is open and shows the frozen name. Assertions are scoped to the
    // dialog: the live "Your token" preview intentionally mirrors the still-
    // editable form, so the name also appears outside the modal.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Frozen Coin")).toBeInTheDocument();

    // Edit the underlying fields AFTER the modal opened.
    fill(/^name/i, "Changed Name");
    fill(/developer buy/i, "9");

    // The frozen modal still shows the original name, never the post-open edit.
    expect(within(dialog).getByText("Frozen Coin")).toBeInTheDocument();
    expect(within(dialog).queryByText("Changed Name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /launch token/i }));

    expect(h.writeContract).toHaveBeenCalledTimes(1);
    const call = h.writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("launchToken");
    expect(call.args[0].name).toBe("Frozen Coin");
    // Frozen dev buy of 1 ETH, not the post-open 9.
    expect(call.value).toBe(LAUNCH_FEE + parseEther("1"));
  });

  it("passes value === launchFee + parseEther(devBuyEth) exactly to the write", async () => {
    render(<Launch />);
    fillValidForm({ devBuyEth: "0.5" });
    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));

    const review = screen.getByTestId("launch-cta");
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    fireEvent.click(await screen.findByRole("button", { name: /launch token/i }));

    const call = h.writeContract.mock.calls[0][0];
    expect(call.value).toBe(LAUNCH_FEE + parseEther("0.5"));
    expect(call.value).toBe(parseEther("0.51"));
  });

  it("on success decodes TokenLaunched and navigates to the DECODED token (matching predicted → no warning)", async () => {
    h.predicted.current = DEPLOYED; // predicted equals what the chain deployed
    h.writeContract.mockImplementation(() => {
      h.state.hash = `0x${"a".repeat(64)}`;
      h.state.receipt = { logs: [tokenLaunchedLog(DEPLOYED, CONNECTED)] };
    });

    render(<Launch />);
    fillValidForm();
    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));
    const review = screen.getByTestId("launch-cta");
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    fireEvent.click(await screen.findByRole("button", { name: /launch token/i }));

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith(`/token/${DEPLOYED}`));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("warns and still navigates to the decoded token when the deployed address differs from predicted", async () => {
    h.predicted.current = PREDICTED; // predicted != what the chain deployed (DEPLOYED)
    h.writeContract.mockImplementation(() => {
      h.state.hash = `0x${"a".repeat(64)}`;
      h.state.receipt = { logs: [tokenLaunchedLog(DEPLOYED, CONNECTED)] };
    });

    render(<Launch />);
    fillValidForm();
    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));
    const review = screen.getByTestId("launch-cta");
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    fireEvent.click(await screen.findByRole("button", { name: /launch token/i }));

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith(`/token/${DEPLOYED}`));
    expect(h.notify).toHaveBeenCalled();
  });

  it("surfaces a write-time revert (LaunchConfigDisabled): error toast, no navigation, form reset", async () => {
    // The node rejects/simulates-reverts before broadcast: no hash, a decodable
    // custom error surfaces on useWriteContract. Pre-fix this closed the modal
    // and did nothing — no toast, no re-enabled form.
    h.writeContract.mockImplementation(() => {
      h.state.writeError = new Error(
        'The contract function "launchToken" reverted.\n\nError: LaunchConfigDisabled()',
      );
    });

    render(<Launch />);
    fillValidForm();
    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));
    const review = screen.getByTestId("launch-cta");
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    fireEvent.click(await screen.findByRole("button", { name: /launch token/i }));

    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith(
        expect.stringMatching(/launch config is disabled/i),
        "error",
      ),
    );
    expect(h.navigate).not.toHaveBeenCalled();
    // Write state reset so the stale hash no longer disables Launch — retryable.
    expect(h.reset).toHaveBeenCalled();
  });

  it("treats a mined-but-reverted receipt as a failure: error toast, no false success, no navigation", async () => {
    // viem RESOLVES a reverted tx's receipt with status "reverted" (never
    // throws), so the success/navigate path must not fire.
    h.writeContract.mockImplementation(() => {
      h.state.hash = `0x${"a".repeat(64)}`;
      h.state.receipt = { status: "reverted", logs: [] };
    });

    render(<Launch />);
    fillValidForm();
    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));
    const review = screen.getByTestId("launch-cta");
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    fireEvent.click(await screen.findByRole("button", { name: /launch token/i }));

    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/reverted|failed/i), "error"),
    );
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
