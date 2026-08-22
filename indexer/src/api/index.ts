import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
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

// Never-traded tokens have `lastPrice18 = NULL`. Postgres's default null
// ordering is NULLS FIRST on DESC, which would rank never-traded tokens
// ahead of every real price under `sort=price` — and would make the keyset
// cursor's null->0 mapping (see `cursorValueFor`) inconsistent with what was
// actually ordered on. Coalescing to 0 in both the ORDER BY and the cursor
// comparison keeps ordering and pagination looking at the exact same value,
// with never-traded tokens ranked last (0 is never above a real price).
const priceExpr = sql`coalesce(${tokens.lastPrice18}, 0)`;

app.get("/tokens", async (c) => {
  const sort = parseSort(c.req.query("sort"));
  const limit = clampLimit(c.req.query("limit"));
  const cursor = decodeCursor(c.req.query("cursor"));

  // Cursor comparisons are typed per sort column: holderCount is a Postgres
  // integer (JS number), lastPrice18/launchTimestamp are bigint columns — a
  // single BigInt(...) cast for both would be a type (and value) mismatch.
  //
  // Each branch is a compound keyset condition — `orderColumn < v OR
  // (orderColumn = v AND address < a)` — not a bare `lt(orderColumn, v)`.
  // The ORDER BY is two-column (orderColumn DESC, address DESC), so ties on
  // the primary column are expected (duplicate holderCount, same-second
  // launchTimestamp, duplicate/never-traded price). A single-column `lt`
  // cursor would drop every row tied with the cursor value once they
  // straddle a page boundary, rather than merely reorder them — the tie
  // rows before the cursor's address in the previous page were already
  // returned, but the ones after it would never come back on any later page.
  const cursorCondition = !cursor
    ? undefined
    : sort === "holders"
      ? or(
          lt(tokens.holderCount, Number(cursor.v)),
          and(eq(tokens.holderCount, Number(cursor.v)), lt(tokens.address, cursor.a as `0x${string}`)),
        )
      : sort === "price"
        ? or(
            lt(priceExpr, BigInt(cursor.v)),
            and(eq(priceExpr, BigInt(cursor.v)), lt(tokens.address, cursor.a as `0x${string}`)),
          )
        : or(
            lt(tokens.launchTimestamp, BigInt(cursor.v)),
            and(eq(tokens.launchTimestamp, BigInt(cursor.v)), lt(tokens.address, cursor.a as `0x${string}`)),
          );

  const orderExpr = sort === "price" ? priceExpr : sort === "holders" ? tokens.holderCount : tokens.launchTimestamp;

  const rows = await db
    .select()
    .from(tokens)
    .where(cursorCondition)
    .orderBy(desc(orderExpr), desc(tokens.address))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  function cursorValueFor(row: typeof tokens.$inferSelect): string {
    if (sort === "holders") return String(row.holderCount);
    if (sort === "price") return String(row.lastPrice18 ?? 0n); // consistent with priceExpr's coalesce(…, 0)
    return String(row.launchTimestamp);
  }

  // `nextCursor` is always present as `null` on an exhausted page — never an
  // omitted key. C's zod boundary requires the key (`.nullable()`, not
  // `.optional()`) across every paginated endpoint in this API, and Hono's
  // `c.json` silently drops `undefined` keys from the JSON body, so
  // `undefined` here would fail C's schema parse on the very last page.
  //
  // Carries both the primary sort value (`v`) and the tie-break `address`
  // (`a`) — see `cursorCondition` above for why `v` alone can't correctly
  // resume past a tie on the primary sort column.
  const nextCursor = hasMore && last ? encodeCursor({ v: cursorValueFor(last), a: last.address }) : null;

  return c.json({ items: await attach24hStats(page), nextCursor });
});

export default app;
