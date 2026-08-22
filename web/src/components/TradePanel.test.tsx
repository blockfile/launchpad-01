import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// --- Deterministic chain reads --------------------------------------------
// The whole `wagmi` surface is mocked so the REAL `useTokenPool`/`useSpotQuote`
// run end-to-end against a fixed `slot0` fixture: this proves the panel turns a
// live price into a real, non-zero estimate and gates the Swap on it (never a
// min-out of 0). `useReadContract` is dispatched by `functionName` — each of
// the four reads the hooks issue (getLaunchedToken / getDexConfig / getPool /
// slot0) plus the panel's own balanceOf has a distinct name.
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
    blockNumber: 100n as bigint | undefined,
    restrictionsEndBlock: 1000n,
    exists: true,
    isToken0: true,
    // slot0: sqrtPriceX96 = 2 * 2^96 ⇒ price = 4 (token1 per token0)
    slot0: [2n * Q96, 0, 0, 0, 0, 0, true] as const,
    refetch: vi.fn(),
  };
});

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: h.account }),
  useChainId: () => 4663,
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
      default:
        return { ...base, data: undefined };
    }
  },
}));

vi.mock("../lib/contracts", () => ({
  resolveAddress: () => h.FACTORY,
}));

import { TradePanel } from "./TradePanel";

beforeEach(() => {
  h.refetch.mockReset();
  h.account = ("0x" + "11".repeat(20)) as `0x${string}`;
  h.blockNumber = 100n;
  h.restrictionsEndBlock = 1000n;
  h.exists = true;
  h.isToken0 = true;
  h.balance = 8n * 10n ** 18n;
});

function amountInput() {
  return screen.getByLabelText(/amount/i) as HTMLInputElement;
}

describe("TradePanel", () => {
  it("turns a typed amount into a real, non-zero estimated output", () => {
    render(<TradePanel tokenAddress={h.TOKEN} />);

    // No amount yet ⇒ no estimate.
    expect(screen.getByTestId("estimate-out")).toHaveTextContent("—");

    // 1 WETH in, fee 1%, price 4 ⇒ netIn 0.99 / 4 = 0.2475 tokens out.
    fireEvent.change(amountInput(), { target: { value: "1" } });
    expect(screen.getByTestId("estimate-out")).toHaveTextContent("0.2475");
  });

  it("fills the amount from a fraction of the wallet balance via the %-buttons", () => {
    render(<TradePanel tokenAddress={h.TOKEN} />);

    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    expect(amountInput().value).toBe("8");

    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(amountInput().value).toBe("4");

    fireEvent.click(screen.getByRole("button", { name: "25%" }));
    expect(amountInput().value).toBe("2");
  });

  it("defaults slippage to 1% and lets it be adjusted", () => {
    render(<TradePanel tokenAddress={h.TOKEN} />);
    const slippage = screen.getByLabelText(/slippage/i) as HTMLInputElement;
    expect(slippage.value).toBe("1");

    fireEvent.change(slippage, { target: { value: "2" } });
    expect(slippage.value).toBe("2");
  });

  it("shows the restriction-window banner while restrictionsEndBlock is in the future", () => {
    render(<TradePanel tokenAddress={h.TOKEN} />);
    expect(screen.getByTestId("restriction-banner")).toBeInTheDocument();
  });

  it("hides the restriction banner once the window has passed", () => {
    h.restrictionsEndBlock = 50n; // current block is 100 ⇒ window already ended
    render(<TradePanel tokenAddress={h.TOKEN} />);
    expect(screen.queryByTestId("restriction-banner")).not.toBeInTheDocument();
  });

  it("keeps Swap disabled until a quote resolves, then enables it (no min-0 send path)", () => {
    render(<TradePanel tokenAddress={h.TOKEN} />);
    const swap = screen.getByRole("button", { name: /swap/i });
    expect(swap).toBeDisabled();

    fireEvent.change(amountInput(), { target: { value: "1" } });
    expect(swap).toBeEnabled();
  });

  it("refuses to trade a token that fails provenance (exists=false)", () => {
    h.exists = false;
    render(<TradePanel tokenAddress={h.TOKEN} />);
    expect(screen.queryByLabelText(/amount/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not a launched token|cannot be traded|provenance/i)).toBeInTheDocument();
  });
});
