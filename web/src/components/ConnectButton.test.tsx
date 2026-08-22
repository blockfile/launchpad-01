import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/providers";
import { ConnectButton } from "./ConnectButton";

describe("ConnectButton", () => {
  it("renders a Connect Wallet control when disconnected", () => {
    renderWithProviders(<ConnectButton />);
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
  });
});
