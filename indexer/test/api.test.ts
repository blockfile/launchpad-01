import { describe, expect, it } from "vitest";
import { parseInterval, parseSort } from "../src/api/helpers";

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
