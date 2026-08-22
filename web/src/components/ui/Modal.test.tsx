import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal, Fact } from "./Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<Modal open={false} title="t" onConfirm={() => {}} onCancel={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("applies the danger class when danger is true", () => {
    render(<Modal open danger title="Launch" onConfirm={() => {}} onCancel={() => {}}><Fact label="Fee">0.0005 ETH</Fact></Modal>);
    expect(screen.getByRole("dialog")).toHaveClass("is-danger");
    expect(screen.getByText("Fee")).toBeInTheDocument();
    expect(screen.getByText("0.0005 ETH")).toBeInTheDocument();
  });
  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    render(<Modal open title="t" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
