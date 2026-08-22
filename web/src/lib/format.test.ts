import { describe, expect, it } from "vitest";
import { formatAge, formatEth, formatPct, shortAddress } from "./format";

describe("format", () => {
  it("shortens an address to 6+4", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
  it("formats wei as ETH with up to 4 significant decimals", () => {
    expect(formatEth(1_500_000_000_000_000_000n)).toBe("1.5 ETH");
  });
  it("formats a signed percent with a sign", () => {
    expect(formatPct(4.2)).toBe("+4.20%");
    expect(formatPct(-1.1)).toBe("-1.10%");
  });
  it("formats age from a past timestamp", () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    expect(formatAge(oneHourAgo)).toBe("1h");
  });
});
