import { describe, expect, it } from "vitest";
import { isAddressLike, parseInterval, parseSort } from "../src/api/helpers";

describe("parseSort", () => {
  it("defaults to newest for an unrecognized value", () => expect(parseSort("bogus")).toBe("newest"));
  it("accepts price and holders", () => {
    expect(parseSort("price")).toBe("price");
    expect(parseSort("holders")).toBe("holders");
  });
});

describe("parseInterval", () => {
  it("accepts each valid interval", () => {
    for (const v of ["1m", "5m", "1h", "1d"] as const) expect(parseInterval(v)).toBe(v);
  });
  it("rejects anything else, including missing", () => {
    expect(parseInterval("2h")).toBeUndefined();
    expect(parseInterval(undefined)).toBeUndefined();
  });
});

describe("isAddressLike", () => {
  it("accepts a well-formed 40-hex-char address", () => {
    expect(isAddressLike("0x1111111111111111111111111111111111111111")).toBe(true);
  });
  it("rejects a name/symbol query", () => {
    expect(isAddressLike("PEPE")).toBe(false);
    expect(isAddressLike("0x123")).toBe(false); // too short
  });
});
