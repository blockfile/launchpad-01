import { describe, expect, it } from "vitest";
import { clampLimit, decodeCursor, encodeCursor } from "../src/lib/pagination";

describe("cursor encode/decode", () => {
  it("round-trips a cursor", () => {
    const cursor = { v: "1234" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });
  it("treats a missing cursor as undefined", () => expect(decodeCursor(undefined)).toBeUndefined());
  it("treats a garbage cursor as undefined rather than throwing", () => {
    expect(decodeCursor("not-valid-base64!!!")).toBeUndefined();
  });
});

describe("clampLimit", () => {
  it("defaults when missing", () => expect(clampLimit(undefined)).toBe(25));
  it("caps at the max", () => expect(clampLimit("500")).toBe(100));
  it("rejects zero/negative", () => expect(clampLimit("0")).toBe(25));
  it("floors a fractional value", () => expect(clampLimit("10.9")).toBe(10));
});
