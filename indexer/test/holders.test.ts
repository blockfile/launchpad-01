import { describe, expect, it } from "vitest";
import { applyTransfer } from "../src/lib/holders";

describe("applyTransfer", () => {
  it("mints from the zero address: only the recipient's balance moves", () => {
    const delta = applyTransfer(undefined, undefined, 1_000n, true);
    expect(delta.fromBalance).toBe(-1_000n);
    expect(delta.toBalance).toBe(1_000n);
    expect(delta.fromCrossedToZero).toBe(false);
    expect(delta.toCrossedFromZero).toBe(true);
  });

  it("moves balance between two known holders", () => {
    const delta = applyTransfer(500n, 100n, 200n, false);
    expect(delta.fromBalance).toBe(300n);
    expect(delta.toBalance).toBe(300n);
    expect(delta.fromCrossedToZero).toBe(false);
  });

  it("flags a holder crossing to exactly zero", () => {
    const delta = applyTransfer(200n, 0n, 200n, false);
    expect(delta.fromBalance).toBe(0n);
    expect(delta.fromCrossedToZero).toBe(true);
  });

  it("throws rather than silently going negative", () => {
    expect(() => applyTransfer(50n, 0n, 200n, false)).toThrow(/negative balance/);
  });

  it("throws for a non-mint transfer from a completely untracked sender", () => {
    expect(() => applyTransfer(undefined, 0n, 200n, false)).toThrow(/negative balance/);
  });
});
