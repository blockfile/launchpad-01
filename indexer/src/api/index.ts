import { and, asc, desc, eq, gte, ilike, lte, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "ponder:api";
import { candles, dexConfigs, holders, launchConfigs, tokens, trades } from "ponder:schema";
import { isAddressLike, parseInterval, parseSort, toSummary } from "./helpers";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination";
import { formatPrice18 } from "../lib/price";
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

app.get("/tokens/:address", async (c) => {
  const address = c.req.param("address").toLowerCase() as `0x${string}`;
  const [row] = await db.select().from(tokens).where(eq(tokens.address, address)).limit(1);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    ...toSummary(row),
    deployer: row.deployer,
    poolAddress: row.poolAddress,
    pairedToken: row.pairedToken,
    poolFee: row.poolFee,
    dexId: row.dexId.toString(),
    launchConfigId: row.launchConfigId.toString(),
    supply: row.supply.toString(),
    restrictionsEndBlock: row.restrictionsEndBlock.toString(),
    graduationThreshold: row.graduationThreshold.toString(),
    graduationThresholdNote: "inert in v1 — never surfaced as a progress bar",
    description: row.description,
    socials: row.socials,
  });
});

app.get("/tokens/:address/candles", async (c) => {
  const address = c.req.param("address").toLowerCase() as `0x${string}`;
  const interval = parseInterval(c.req.query("interval"));
  if (!interval) return c.json({ error: "interval must be one of 1m,5m,1h,1d" }, 400);
  const conditions = [eq(candles.tokenAddress, address), eq(candles.interval, interval)];
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from) conditions.push(gte(candles.bucketStart, BigInt(from)));
  if (to) conditions.push(lte(candles.bucketStart, BigInt(to)));

  const rows = await db.select().from(candles).where(and(...conditions)).orderBy(asc(candles.bucketStart));
  return c.json({
    interval,
    items: rows.map((r) => ({
      bucketStart: r.bucketStart.toString(),
      open: formatPrice18(r.open),
      high: formatPrice18(r.high),
      low: formatPrice18(r.low),
      close: formatPrice18(r.close),
      volumeToken: r.volumeToken.toString(),
      volumeQuote: r.volumeQuote.toString(),
      tradeCount: r.tradeCount,
    })),
  });
});

// Compound keyset cursor: order is (blockNumber DESC, logIndex DESC), and on
// this chain contract-visible `block.number` ticks only ~every 16s, so trades
// routinely cluster many-per-block. A single-column `lt(blockNumber, v)`
// cursor would drop every trade tied with the cursor's blockNumber once they
// straddle a page boundary — see Task 7's `/tokens` cursorCondition note for
// the general shape of this bug. logIndex is a Postgres integer (JS number).
app.get("/tokens/:address/trades", async (c) => {
  const address = c.req.param("address").toLowerCase() as `0x${string}`;
  const limit = clampLimit(c.req.query("limit"));
  const cursor = decodeCursor(c.req.query("cursor"));
  const where = !cursor
    ? eq(trades.tokenAddress, address)
    : and(
        eq(trades.tokenAddress, address),
        or(
          lt(trades.blockNumber, BigInt(cursor.v)),
          and(eq(trades.blockNumber, BigInt(cursor.v)), lt(trades.logIndex, Number(cursor.l))),
        ),
      );

  const rows = await db.select().from(trades).where(where).orderBy(desc(trades.blockNumber), desc(trades.logIndex)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ v: String(last.blockNumber), l: String(last.logIndex) }) : null; // always present, never omitted — see /tokens' note above
  return c.json({
    items: page.map((r) => ({
      txHash: r.txHash,
      logIndex: r.logIndex,
      side: r.side,
      traderAddress: r.traderAddress,
      tokenAmountRaw: r.tokenAmountRaw.toString(),
      quoteAmountRaw: r.quoteAmountRaw.toString(),
      price: formatPrice18(r.price18),
      blockTimestamp: r.blockTimestamp.toString(),
    })),
    nextCursor,
  });
});

// Compound keyset cursor: order is (balance DESC, holderAddress DESC), and
// balances can tie (same reasoning as /trades above) — a single-column
// `lt(balance, v)` cursor would drop every holder tied with the cursor's
// balance once they straddle a page boundary.
app.get("/tokens/:address/holders", async (c) => {
  const address = c.req.param("address").toLowerCase() as `0x${string}`;
  const limit = clampLimit(c.req.query("limit"));
  const cursor = decodeCursor(c.req.query("cursor"));
  const where = !cursor
    ? eq(holders.tokenAddress, address)
    : and(
        eq(holders.tokenAddress, address),
        or(
          lt(holders.balance, BigInt(cursor.v)),
          and(eq(holders.balance, BigInt(cursor.v)), lt(holders.holderAddress, cursor.a as `0x${string}`)),
        ),
      );

  // `supply`/`holderCount` are one extra row lookup against the already-
  // denormalized `tokens` columns — not a new aggregation query — used to
  // compute each holder's `pct` and the page's `totalHolders` (C's zod
  // schema wants both; both are cheap given data already on hand).
  const [token] = await db.select({ supply: tokens.supply, holderCount: tokens.holderCount }).from(tokens).where(eq(tokens.address, address)).limit(1);
  const rows = await db.select().from(holders).where(where).orderBy(desc(holders.balance), desc(holders.holderAddress)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ v: String(last.balance), a: last.holderAddress }) : null; // always present, never omitted
  const supply = token?.supply ?? 0n;
  return c.json({
    items: page.map((r) => ({
      address: r.holderAddress,
      balance: r.balance.toString(),
      pct: supply > 0n ? Number((r.balance * 1_000_000n) / supply) / 10_000 : 0,
    })),
    nextCursor,
    totalHolders: token?.holderCount ?? 0,
  });
});

app.get("/tokens/:address/holders/count", async (c) => {
  const address = c.req.param("address").toLowerCase() as `0x${string}`;
  const [row] = await db.select({ holderCount: tokens.holderCount }).from(tokens).where(eq(tokens.address, address)).limit(1);
  return c.json({ count: row?.holderCount ?? 0 });
});

app.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ items: [] });

  if (isAddressLike(q)) {
    const [row] = await db.select().from(tokens).where(eq(tokens.address, q.toLowerCase() as `0x${string}`)).limit(1);
    return c.json({ items: row ? [toSummary(row)] : [] });
  }

  const rows = await db
    .select()
    .from(tokens)
    .where(or(ilike(tokens.name, `%${q}%`), ilike(tokens.symbol, `%${q}%`)))
    .orderBy(desc(tokens.launchTimestamp))
    .limit(25);
  return c.json({ items: rows.map(toSummary) });
});

app.get("/stats", async (c) => {
  const [tokenStats] = await db.select({ tokensLaunched: sql<number>`count(*)` }).from(tokens);
  const [tradeStats] = await db
    .select({
      totalTrades: sql<number>`count(*)`,
      totalVolumeQuote: sql<string>`coalesce(sum(${trades.quoteAmountRaw}), 0)`,
    })
    .from(trades);
  return c.json({
    tokensLaunched: Number(tokenStats?.tokensLaunched ?? 0),
    totalTrades: Number(tradeStats?.totalTrades ?? 0),
    totalVolumeQuote: String(tradeStats?.totalVolumeQuote ?? "0"),
  });
});

app.get("/launch-configs", async (c) => {
  const [enabledLaunchConfigs, enabledDexConfigs] = await Promise.all([
    db.select({ id: launchConfigs.id }).from(launchConfigs).where(eq(launchConfigs.enabled, true)),
    db.select({ id: dexConfigs.id }).from(dexConfigs).where(eq(dexConfigs.enabled, true)),
  ]);
  return c.json({
    launchConfigIds: enabledLaunchConfigs.map((r) => Number(r.id)),
    dexIds: enabledDexConfigs.map((r) => Number(r.id)),
  });
});

// Compound keyset cursor: order is (balance DESC, tokenAddress DESC) — a
// wallet can hold multiple tokens with equal balances (most commonly two
// zero-ish dust balances, but not limited to that), and a single-column
// `lt(balance, v)` cursor would drop every holding tied with the cursor's
// balance once they straddle a page boundary, same reasoning as
// /tokens/:address/holders above.
app.get("/wallets/:address/holdings", async (c) => {
  const wallet = c.req.param("address").toLowerCase() as `0x${string}`;
  const limit = clampLimit(c.req.query("limit"));
  const cursor = decodeCursor(c.req.query("cursor"));
  const where = cursor
    ? and(
        eq(holders.holderAddress, wallet),
        gte(holders.balance, 1n),
        or(
          lt(holders.balance, BigInt(cursor.v)),
          and(eq(holders.balance, BigInt(cursor.v)), lt(holders.tokenAddress, cursor.a as `0x${string}`)),
        ),
      )
    : and(eq(holders.holderAddress, wallet), gte(holders.balance, 1n));

  const rows = await db
    .select({
      tokenAddress: holders.tokenAddress,
      balance: holders.balance,
      name: tokens.name,
      symbol: tokens.symbol,
      logo: tokens.logo,
      lastPrice18: tokens.lastPrice18,
      decimals: tokens.decimals,
    })
    .from(holders)
    .innerJoin(tokens, eq(tokens.address, holders.tokenAddress))
    .where(where)
    .orderBy(desc(holders.balance), desc(holders.tokenAddress))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ v: String(last.balance), a: last.tokenAddress }) : null;

  return c.json({
    items: page.map((r) => ({
      tokenAddress: r.tokenAddress,
      name: r.name,
      symbol: r.symbol,
      logo: r.logo,
      balance: r.balance.toString(),
      // Divides by the token's own `decimals`, not a hardcoded 1e18 — price18
      // already normalizes decimals out, but `balance` is raw (10^decimals-
      // scaled), so hardcoding 1e18 would silently misprice any non-18-decimal
      // token's holdings, matching the marketCap fix in `toSummary`.
      valueEth: r.lastPrice18 !== null ? formatPrice18((r.balance * r.lastPrice18) / 10n ** BigInt(r.decimals)) : null,
    })),
    nextCursor,
  });
});

export default app;
