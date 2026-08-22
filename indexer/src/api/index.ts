import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "ponder:api";
import { candles, tokens } from "ponder:schema";
import { parseSort, toSummary } from "./helpers";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination";
import { priceChangeBps } from "../lib/stats";

async function attach24hStats(rows: (typeof tokens.$inferSelect)[]) {
  const windowStart = BigInt(Math.floor(Date.now() / 1000)) - 24n * 3600n;
  return Promise.all(
    rows.map(async (row) => {
      const hourly = await db
        .select()
        .from(candles)
        .where(and(eq(candles.tokenAddress, row.address), eq(candles.interval, "1h"), gte(candles.bucketStart, windowStart)))
        .orderBy(asc(candles.bucketStart));
      const volume24h = hourly.reduce((sum, c) => sum + c.volumeQuote, 0n);
      const first = hourly[0];
      return {
        ...toSummary(row),
        volume24h: volume24h.toString(),
        priceChangeBps24h: first ? priceChangeBps(first.open, row.lastPrice18 ?? first.close) : null,
      };
    }),
  );
}

const app = new Hono();

app.get("/tokens", async (c) => {
  const sort = parseSort(c.req.query("sort"));
  const limit = clampLimit(c.req.query("limit"));
  const cursor = decodeCursor(c.req.query("cursor"));

  // Cursor comparisons are typed per sort column: holderCount is a Postgres
  // integer (JS number), lastPrice18/launchTimestamp are bigint columns — a
  // single BigInt(...) cast for both would be a type (and value) mismatch.
  const cursorCondition = !cursor
    ? undefined
    : sort === "holders"
      ? lt(tokens.holderCount, Number(cursor.v))
      : sort === "price"
        ? lt(tokens.lastPrice18, BigInt(cursor.v))
        : lt(tokens.launchTimestamp, BigInt(cursor.v));

  const orderColumn = sort === "price" ? tokens.lastPrice18 : sort === "holders" ? tokens.holderCount : tokens.launchTimestamp;

  const rows = await db
    .select()
    .from(tokens)
    .where(cursorCondition)
    .orderBy(desc(orderColumn), desc(tokens.address))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  function cursorValueFor(row: typeof tokens.$inferSelect): string {
    if (sort === "holders") return String(row.holderCount);
    if (sort === "price") return String(row.lastPrice18 ?? 0n);
    return String(row.launchTimestamp);
  }

  // `nextCursor` is always present as `null` on an exhausted page — never an
  // omitted key. C's zod boundary requires the key (`.nullable()`, not
  // `.optional()`) across every paginated endpoint in this API, and Hono's
  // `c.json` silently drops `undefined` keys from the JSON body, so
  // `undefined` here would fail C's schema parse on the very last page.
  const nextCursor = hasMore && last ? encodeCursor({ v: cursorValueFor(last) }) : null;

  return c.json({ items: await attach24hStats(page), nextCursor });
});

export default app;
