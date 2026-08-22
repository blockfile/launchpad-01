import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Toaster } from "./Toaster";
import { notify } from "../../lib/toast";

describe("Toaster", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a notice dispatched via the toast bus, with status/live-region semantics", () => {
    render(<Toaster />);
    act(() => {
      notify("Launched", "ok");
    });
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("Launched");
  });

  it("auto-dismisses a plain notice after 4.5s", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      notify("Launched", "ok");
    });
    expect(screen.getByText("Launched")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.queryByText("Launched")).not.toBeInTheDocument();
  });

  it("keeps an error toast around for 8s, longer than an ok toast", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      notify("Boom", "error");
    });
    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.queryByText("Boom")).not.toBeInTheDocument();
  });
});
