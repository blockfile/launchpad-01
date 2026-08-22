import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { parseEther } from "viem";

// --- Deterministic chain reads --------------------------------------------
// The whole `wagmi` surface is mocked so the REAL `useTokenPool`/`useSpotQuote`
// run end-to-end against a fixed `slot0` fixture: this proves the panel turns a
// live price into a real, non-zero estimate and gates the Swap on it (never a
// min-out of 0). `useReadContract` is dispatched by `functionName` — each of
// the reads the hooks issue (getLaunchedToken / getDexConfig / getPool / slot0)
// plus the panel's own balanceOf and allowance has a distinct name.
const h = vi.hoisted(() => {
  const addr = (b: string) => ("0x" + b.repeat(20)) as `0x${string}`;
  const Q96 = 2n ** 96n;
  const E = 10n ** 18n;
  return {
    FACTORY: addr("f0"),
    DEX_FACTORY: addr("da"),
    POOL: addr("c0"),
    PAIRED: addr("ee"),
    TOKEN: addr("70"),
    ZERO: ("0x" + "00".repeat(20)) as `0x${string}`,
    account: addr("11") as `0x${string}` | undefined,
    balance: 8n * E, // 8 WETH / 8 tokens
    allowance: 0n,
    blockNumber: 100n as bigint | undefined,
    restrictionsEndBlock: 1000n,
    exists: true,
    isToken0: true,
    // slot0: sqrtPriceX96 = 2 * 2^96 ⇒ price = 4 (token1 per token0)
    slot0: [2n * Q96, 0, 0, 0, 0, 0, true] as const,
    refetch: vi.fn(),
    writeContractAsync: vi.fn(),
    waitForReceipt: vi.fn(),
  };
});

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: h.account }),
  useChainId: () => 4663,
  useConfig: () => ({}),
  useWriteContract: () => ({ writeContractAsync: h.writeContractAsync }),
  useBlockNumber: () => ({ data: h.blockNumber }),
  useReadContract: (cfg: { functionName?: string; query?: { enabled?: boolean } }) => {
    const enabled = cfg?.query?.enabled ?? true;
    const base = { refetch: h.refetch, isLoading: false };
    if (!enabled) return { ...base, data: undefined };
    switch (cfg?.functionName) {
      case "getLaunchedToken":
        return {
          ...base,
          data: {
            token: h.TOKEN,
            deployer: h.account,
            pairedToken: h.PAIRED,
            dexId: 0n,
            restrictionsEndBlock: h.restrictionsEndBlock,
            isToken0: h.isToken0,
            poolFee: 10_000,
            exists: h.exists,
          },
        };
      case "getDexConfig":
        return { ...base, data: { factory: h.DEX_FACTORY } };
      case "getPool":
        return { ...base, data: h.POOL };
      case "slot0":
        return { ...base, data: h.slot0 };
      case "balanceOf":
        return { ...base, data: h.balance };
      case "allowance":
        return { ...base, data: h.allowance };
      default:
        return { ...base, data: undefined };
    }
  },
}));

vi.mock("wagmi/actions", () => ({
  waitForTransactionReceipt: h.waitForReceipt,
}));

vi.mock("../lib/contracts", () => ({
  resolveAddress: () => h.FACTORY,
}));

import { TradePanel } from "./TradePanel";

beforeEach(() => {
  h.refetch.mockReset();
  h.refetch.mockResolvedValue({ data: h.slot0 });
  h.writeContractAsync.mockReset();
  h.writeContractAsync.mockResolvedValue(("0x" + "ab".repeat(32)) as `0x${string}`);
  h.waitForReceipt.mockReset();
  h.waitForReceipt.mockResolvedValue({ status: "success" });
  h.account = ("0x" + "11".repeat(20)) as `0x${string}`;
  h.blockNumber = 100n;
  h.restrictionsEndBlock = 1000n;
  h.exists = true;
  h.isToken0 = true;
  h.balance = 8n * 10n ** 18n;
  h.allowance = 0n;
});

// TradePanel now uses `useQueryClient` (post-swap cache invalidation), so every
// render needs a QueryClientProvider ancestor. wagmi itself is mocked, so the
// real wagmi provider stack is intentionally NOT mounted here.
function renderPanel(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function amountInput() {
  return screen.getByLabelText(/amount/i) as HTMLInputElement;
}

describe("TradePanel", () => {
  it("turns a typed amount into a real, non-zero estimated output", () => {
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);

    // No amount yet ⇒ no estimate.
    expect(screen.getByTestId("estimate-out")).toHaveTextContent("—");

    // 1 WETH in, fee 1%, price 4 ⇒ netIn 0.99 / 4 = 0.2475 tokens out.
    fireEvent.change(amountInput(), { target: { value: "1" } });
    expect(screen.getByTestId("estimate-out")).toHaveTextContent("0.2475");
  });

  it("fills the amount from a fraction of the wallet balance via the %-buttons", () => {
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);

    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    expect(amountInput().value).toBe("8");

    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(amountInput().value).toBe("4");

    fireEvent.click(screen.getByRole("button", { name: "25%" }));
    expect(amountInput().value).toBe("2");
  });

  it("defaults slippage to 1% and lets it be adjusted", () => {
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    const slippage = screen.getByLabelText(/slippage/i) as HTMLInputElement;
    expect(slippage.value).toBe("1");

    fireEvent.change(slippage, { target: { value: "2" } });
    expect(slippage.value).toBe("2");
  });

  it("shows the restriction-window banner while restrictionsEndBlock is in the future", () => {
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    expect(screen.getByTestId("restriction-banner")).toBeInTheDocument();
  });

  it("hides the restriction banner once the window has passed", () => {
    h.restrictionsEndBlock = 50n; // current block is 100 ⇒ window already ended
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    expect(screen.queryByTestId("restriction-banner")).not.toBeInTheDocument();
  });

  it("keeps Swap disabled until a quote resolves, then enables it (no min-0 send path)", () => {
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    const swap = screen.getByRole("button", { name: /swap/i });
    expect(swap).toBeDisabled();

    fireEvent.change(amountInput(), { target: { value: "1" } });
    expect(swap).toBeEnabled();
  });

  it("refuses to trade a token that fails provenance (exists=false)", () => {
    h.exists = false;
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    expect(screen.queryByLabelText(/amount/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/not a launched token|cannot be traded|provenance/i),
    ).toBeInTheDocument();
  });

  // --- Write flow (Task 12) ------------------------------------------------

  it("BUY: refetches a fresh price, then sends exactInputSingle with native value and a REAL min-out", async () => {
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    fireEvent.change(amountInput(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /swap/i }));

    await waitFor(() => expect(h.writeContractAsync).toHaveBeenCalledTimes(1));
    // A fresh slot0 read happened before pricing the swap.
    expect(h.refetch).toHaveBeenCalled();

    const call = h.writeContractAsync.mock.calls[0][0];
    expect(call.functionName).toBe("exactInputSingle");
    expect(call.value).toBe(parseEther("1")); // native msg.value = amountIn
    expect(call.args[0].recipient).toBe(h.account);
    expect(call.args[0].tokenOut).toBe(h.TOKEN);
    expect(call.args[0].amountOutMinimum).toBeGreaterThan(0n); // never a zero floor
    await waitFor(() => expect(h.waitForReceipt).toHaveBeenCalled());
  });

  it("SELL with no standing allowance: approves the EXACT amountIn first, then multicalls", async () => {
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: /sell/i }));
    fireEvent.change(amountInput(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /swap/i }));

    await waitFor(() => expect(h.writeContractAsync).toHaveBeenCalledTimes(2));
    const approve = h.writeContractAsync.mock.calls[0][0];
    const swap = h.writeContractAsync.mock.calls[1][0];

    expect(approve.functionName).toBe("approve");
    // EXACT amount to the router — never max/infinite.
    expect(approve.args[0]).toBe(h.FACTORY); // router (resolveAddress mocked → FACTORY)
    expect(approve.args[1]).toBe(parseEther("1"));

    expect(swap.functionName).toBe("multicall");
    expect(swap.value).toBe(0n);
    expect(swap.args[0]).toHaveLength(2);
    // The approve receipt is awaited between the two writes.
    expect(h.waitForReceipt).toHaveBeenCalled();
  });

  it("SELL with sufficient allowance: skips approve, multicalls directly", async () => {
    h.allowance = 10n ** 30n; // plenty
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: /sell/i }));
    fireEvent.change(amountInput(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /swap/i }));

    await waitFor(() => expect(h.writeContractAsync).toHaveBeenCalledTimes(1));
    expect(h.writeContractAsync.mock.calls[0][0].functionName).toBe("multicall");
  });
});
