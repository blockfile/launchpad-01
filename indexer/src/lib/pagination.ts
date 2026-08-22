export interface Cursor {
  [key: string]: string;
}

export function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    // A tampered/malformed cursor can decode to valid-but-wrong-shaped JSON
    // (e.g. base64url of `"5"` parses to the number 5, not an object). Only
    // a plain, non-array object whose every value is a string satisfies
    // `Cursor` — anything else must restart from the beginning rather than
    // let a caller like `BigInt(cursor.v)` throw on `undefined` and 500.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    if (!Object.values(parsed).every((value) => typeof value === "string")) return undefined;
    return parsed as Cursor;
  } catch {
    return undefined; // an invalid/tampered cursor restarts from the beginning, never throws
  }
}

export function clampLimit(raw: string | undefined, fallback = 25, max = 100): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
