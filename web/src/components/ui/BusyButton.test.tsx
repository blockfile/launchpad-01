import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BusyButton } from "./BusyButton";

describe("BusyButton", () => {
  it("is enabled and shows its label when idle", () => {
    render(
      <BusyButton busy="" busyWhen="launch" onClick={() => {}}>
        Launch
      </BusyButton>
    );
    const button = screen.getByRole("button", { name: /launch/i });
    expect(button).not.toBeDisabled();
  });

  it("disables itself and marks aria-busy only when busy matches its own key", () => {
    render(
      <BusyButton busy="launch" busyWhen="launch" onClick={() => {}}>
        Launch
      </BusyButton>
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("stays enabled and clickable while a sibling button's key is the one that's busy", () => {
    const onClick = vi.fn();
    render(
      <BusyButton busy="approve" busyWhen="launch" onClick={onClick}>
        Launch
      </BusyButton>
    );
    const button = screen.getByRole("button", { name: /launch/i });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
