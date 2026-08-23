import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// wagmi is mocked so this unit can drive every connect/chain permutation
// without a live provider stack.
const h = vi.hoisted(() => ({
  isConnected: false,
  chainId: undefined as number | undefined,
  switchChain: vi.fn(),
  isPending: false,
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: h.isConnected, chainId: h.chainId }),
  useSwitchChain: () => ({ switchChain: h.switchChain, isPending: h.isPending }),
}));

import { WrongNetworkBanner } from "./WrongNetworkBanner";

beforeEach(() => {
  h.isConnected = false;
  h.chainId = undefined;
  h.switchChain.mockReset();
  h.isPending = false;
});

describe("WrongNetworkBanner", () => {
  it("renders nothing when the wallet is disconnected (that's 'not connected', never 'wrong network')", () => {
    h.isConnected = false;
    h.chainId = 1;
    const { container } = render(<WrongNetworkBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing on a supported chain (4663)", () => {
    h.isConnected = true;
    h.chainId = 4663;
    const { container } = render(<WrongNetworkBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing on the supported testnet chain (46630)", () => {
    h.isConnected = true;
    h.chainId = 46630;
    const { container } = render(<WrongNetworkBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("prompts a switch when connected to an unsupported chain, and switches to 4663 on click", () => {
    h.isConnected = true;
    h.chainId = 1; // Ethereum mainnet — not configured in this app
    render(<WrongNetworkBanner />);

    expect(screen.getByRole("alert")).toHaveTextContent(/wrong network/i);
    fireEvent.click(screen.getByRole("button", { name: /switch to robinhood chain/i }));
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: 4663 });
  });

  it("disables the switch button while a switch is pending", () => {
    h.isConnected = true;
    h.chainId = 1;
    h.isPending = true;
    render(<WrongNetworkBanner />);
    expect(screen.getByRole("button", { name: /switching/i })).toBeDisabled();
  });
});
