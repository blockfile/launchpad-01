import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArmSwitch } from "./ArmSwitch";

describe("ArmSwitch", () => {
  it("starts unarmed and calls onChange(true) when toggled", () => {
    const onChange = vi.fn();
    render(<ArmSwitch armed={false} onChange={onChange} />);
    const checkbox = screen.getByRole("checkbox", { name: /arm/i });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
