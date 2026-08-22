import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
  state: { hash: undefined as `0x${string}` | undefined, receipt: undefined as unknown },
  predicted: { current: undefined as string | undefined },
  launchFee: { current: 0n as bigint | undefined },
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: CONNECTED }),
  useChainId: () => 4663,
  useReadContract: () => ({ data: h.launchFee.current }),
  useWriteContract: () => ({
    writeContract: h.writeContract,
    data: h.state.hash,
    isPending: false,
    reset: vi.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    data: h.state.receipt,
    isSuccess: Boolean(h.state.receipt),
    isLoading: false,
  }),
}));

vi.mock("../lib/contracts", () => ({
  resolveAddress: () => FACTORY,
}));

vi.mock("../lib/launchConfig", () => ({
  usePredictedTokenAddress: () => ({ data: h.predicted.current }),
  useAvailableLaunchConfigs: () => ({ launchConfigIds: [0], dexIds: [0] }),
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
  fill(/^symbol/i, symbol);
  fireEvent.click(screen.getByRole("button", { name: /set-logo/i }));
  fill(/dev buy/i, devBuyEth);
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
  h.state.hash = undefined;
  h.state.receipt = undefined;
  h.predicted.current = PREDICTED;
  h.launchFee.current = LAUNCH_FEE;
});

describe("Launch", () => {
  it("shows the predicted address only once name, symbol and logo are all set", async () => {
    render(<Launch />);
    expect(screen.queryByTestId("predicted-address")).not.toBeInTheDocument();

    fill(/^name/i, "Frozen Coin");
    fill(/^symbol/i, "FRZ");
    expect(screen.queryByTestId("predicted-address")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /set-logo/i }));

    const predicted = await screen.findByTestId("predicted-address");
    expect(predicted).toHaveTextContent(PREDICTED);
  });

  it("keeps the primary Launch action disabled until the arm switch is checked", async () => {
    render(<Launch />);
    fillValidForm();

    const review = screen.getByRole("button", { name: /review launch/i });
    await waitFor(() => expect(review).toBeDisabled());

    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));
    await waitFor(() => expect(review).toBeEnabled());
  });

  it("freezes the request body at Review: a later field edit changes neither the modal nor the write args", async () => {
    render(<Launch />);
    fillValidForm({ name: "Frozen Coin", devBuyEth: "1" });
    fireEvent.click(screen.getByRole("checkbox", { name: /arm/i }));

    const review = screen.getByRole("button", { name: /review launch/i });
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);

    // Modal is open and shows the frozen name.
    expect(await screen.findByText("Frozen Coin")).toBeInTheDocument();

    // Edit the underlying fields AFTER the modal opened.
    fill(/^name/i, "Changed Name");
    fill(/dev buy/i, "9");

    // The modal still shows the frozen name, never the post-open edit.
    expect(screen.getByText("Frozen Coin")).toBeInTheDocument();
    expect(screen.queryByText("Changed Name")).not.toBeInTheDocument();

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

    const review = screen.getByRole("button", { name: /review launch/i });
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
    const review = screen.getByRole("button", { name: /review launch/i });
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
    const review = screen.getByRole("button", { name: /review launch/i });
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    fireEvent.click(await screen.findByRole("button", { name: /launch token/i }));

    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith(`/token/${DEPLOYED}`));
    expect(h.notify).toHaveBeenCalled();
  });
});
