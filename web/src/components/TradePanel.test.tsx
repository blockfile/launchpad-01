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
    // The token's OWN per-dexId router (getDexConfig.swapRouter) — DISTINCT
    // from anything resolveAddress returns, so a test can prove the swap path
    // targets THIS router, never a chain-wide default.
    SWAP_ROUTER: addr("55"),
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
    routerRequiresDeadline: false,
    // slot0: sqrtPriceX96 = 2 * 2^96 ⇒ price = 4 (token1 per token0)
    slot0: [2n * Q96, 0, 0, 0, 0, 0, true] as const,
    refetch: vi.fn(),
    writeContractAsync: vi.fn(),
    waitForReceipt: vi.fn(),
    notify: vi.fn(),
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
            launchConfigId: 0n,
            restrictionsEndBlock: h.restrictionsEndBlock,
            isToken0: h.isToken0,
            poolFee: 10_000,
            exists: h.exists,
          },
        };
      case "getDexConfig":
        return { ...base, data: { factory: h.DEX_FACTORY, swapRouter: h.SWAP_ROUTER } };
      case "getLaunchConfig":
        return { ...base, data: { routerRequiresDeadline: h.routerRequiresDeadline } };
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

vi.mock("../lib/toast", () => ({
  notify: h.notify,
}));

import { TradePanel } from "./TradePanel";

// Observe post-swap cache invalidation without swapping out the real client.
const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");

beforeEach(() => {
  h.refetch.mockReset();
  h.refetch.mockResolvedValue({ data: h.slot0 });
  h.writeContractAsync.mockReset();
  h.writeContractAsync.mockResolvedValue(("0x" + "ab".repeat(32)) as `0x${string}`);
  h.waitForReceipt.mockReset();
  h.waitForReceipt.mockResolvedValue({ status: "success" });
  h.notify.mockReset();
  invalidateSpy.mockClear();
  h.account = ("0x" + "11".repeat(20)) as `0x${string}`;
  h.blockNumber = 100n;
  h.restrictionsEndBlock = 1000n;
  h.exists = true;
  h.isToken0 = true;
  h.routerRequiresDeadline = false;
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
    // A confirmed (status "success") receipt ⇒ success toast + invalidation.
    await waitFor(() => expect(h.notify).toHaveBeenCalledWith("Swap complete", "ok"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["trades", h.TOKEN] });
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
    // EXACT amount to the token's OWN per-dexId router — never max/infinite,
    // never the chain default.
    expect(approve.args[0]).toBe(h.SWAP_ROUTER);
    expect(approve.args[1]).toBe(parseEther("1"));

    expect(swap.functionName).toBe("multicall");
    expect(swap.value).toBe(0n);
    expect(swap.args[0]).toHaveLength(2);
    // The approve receipt is awaited between the two writes.
    expect(h.waitForReceipt).toHaveBeenCalled();
  });

  it("BUY: routes to the token's per-dexId getDexConfig.swapRouter, not a chain-wide default", async () => {
    // The mocked getDexConfig returns SWAP_ROUTER (distinct from FACTORY, which
    // is all resolveAddress ever yields here). A per-dexId-aware panel MUST send
    // the swap to SWAP_ROUTER; the pre-fix code would have used the chain
    // default (FACTORY), which is the wrong-venue / pool-interception bug.
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    fireEvent.change(amountInput(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /swap/i }));

    await waitFor(() => expect(h.writeContractAsync).toHaveBeenCalledTimes(1));
    const call = h.writeContractAsync.mock.calls[0][0];
    expect(call.address).toBe(h.SWAP_ROUTER);
    expect(call.address).not.toBe(h.FACTORY);
  });

  it("SELL: approve AND multicall both target the per-dexId router", async () => {
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: /sell/i }));
    fireEvent.change(amountInput(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /swap/i }));

    await waitFor(() => expect(h.writeContractAsync).toHaveBeenCalledTimes(2));
    const approve = h.writeContractAsync.mock.calls[0][0];
    const swap = h.writeContractAsync.mock.calls[1][0];
    expect(approve.args[0]).toBe(h.SWAP_ROUTER); // allowance granted to the real router
    expect(swap.address).toBe(h.SWAP_ROUTER); // multicall sent to the real router
    expect(swap.address).not.toBe(h.FACTORY);
  });

  it("uses the no-deadline overload for the live default (routerRequiresDeadline=false)", async () => {
    // 0x04e45aaf is the SwapRouter02 no-deadline exactInputSingle selector; the
    // buy call must encode against it when the token's config wants no deadline.
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    fireEvent.change(amountInput(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /swap/i }));

    await waitFor(() => expect(h.writeContractAsync).toHaveBeenCalledTimes(1));
    const call = h.writeContractAsync.mock.calls[0][0];
    // The no-deadline params object has no `deadline` key.
    expect(call.args[0]).not.toHaveProperty("deadline");
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

  // --- Reverted receipts (viem resolves — never throws — on revert) --------

  it("BUY whose swap reverts on-chain: error toast, NO success toast, NO query invalidation", async () => {
    // waitForTransactionReceipt RESOLVES with status "reverted" for a reverted
    // tx — the panel must treat that as a failure, not a false success.
    h.waitForReceipt.mockResolvedValue({ status: "reverted" });
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    fireEvent.change(amountInput(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /swap/i }));

    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/reverted/i), "error"),
    );
    expect(h.notify).not.toHaveBeenCalledWith("Swap complete", "ok");
    // A trade that moved no funds must not invalidate the trade/holder caches.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["trades", h.TOKEN] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["holders", h.TOKEN] });
  });

  it("SELL whose APPROVE reverts: does NOT submit the swap", async () => {
    // The approve receipt (the only waitForTransactionReceipt before the swap)
    // resolves reverted ⇒ the swap write must never fire.
    h.waitForReceipt.mockResolvedValue({ status: "reverted" });
    renderPanel(<TradePanel tokenAddress={h.TOKEN} />);
    fireEvent.click(screen.getByRole("button", { name: /sell/i }));
    fireEvent.change(amountInput(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /swap/i }));

    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith(expect.stringMatching(/approval reverted/i), "error"),
    );
    // Only the approve was ever written — no swap followed the failed approval.
    expect(h.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(h.writeContractAsync.mock.calls[0][0].functionName).toBe("approve");
    expect(h.notify).not.toHaveBeenCalledWith("Swap complete", "ok");
  });
});
