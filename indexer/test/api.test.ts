import { describe, expect, it } from "vitest";
import { parseSort } from "../src/api/helpers";

describe("parseSort", () => {
  it("defaults to newest for an unrecognized value", () => expect(parseSort("bogus")).toBe("newest"));
  it("accepts price and holders", () => {
    expect(parseSort("price")).toBe("price");
    expect(parseSort("holders")).toBe("holders");
  });
});
