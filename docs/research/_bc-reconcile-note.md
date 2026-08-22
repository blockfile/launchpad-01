# B/C API interface reconciliation — 2026-08-22

Reconciles sub-project B's (indexer) actual served API against sub-project C's
(frontend) actual consumed API, across all four planning documents:

- B spec: `docs/superpowers/specs/2026-08-22-indexer-design.md`
- B plan: `docs/superpowers/plans/2026-08-22-indexer.md`
- C spec: `docs/superpowers/specs/2026-08-22-frontend-design.md`
- C plan: `docs/superpowers/plans/2026-08-22-frontend.md`

No app code was touched — only the four plan/spec files above.

## Mismatch table (before reconciliation)

| # | Endpoint | B produced | C consumed | Mismatch |
|---|---|---|---|---|
| 1 | `/launch-configs` | did not exist | `fetchLaunchConfigs()` → `array<{launchConfigId, dexId}>` | endpoint missing entirely |
| 2 | `/wallets/:address/holdings` | did not exist | `fetchHoldings(wallet)` → `{items:[{tokenAddress,symbol,name,logoUrl,balance,valueEth}]}` | endpoint missing entirely |
| 3 | `/tokens` item | `logo`, `price`, `volume24h`, `priceChangeBps24h` (bps int), `holderCount`, `launchTimestamp` (string); no `marketCap`/`poolAddress` | `logoUrl`, `priceEth`, `volume24hEth`, `change24hPct` (percent), `holders`, `launchedAt`; expected `marketCapEth`, `poolAddress` | every field renamed; B had no market-cap field at all though C's own frontend spec §2.1 requires one on Explore; C wrongly expected `poolAddress` on the list row |
| 4 | `/tokens/:address` | added `poolAddress/pairedToken/poolFee/supply/restrictionsEndBlock/graduationThreshold(+note)/socials`; no `deployer`/`dexId`/`launchConfigId`/`feeWallet` | added `description/socials/deployer/feeWallet/supply/dexId/launchConfigId/restrictionsEndBlock` | `deployer`/`dexId`/`launchConfigId` were indexed but not surfaced by B; `feeWallet` isn't derivable by B at all (its own "Known limitation" — no recipient in `TokenLaunched`), yet C's schema demanded it |
| 5 | `/tokens/:address/candles` item | `bucketStart` (string), `open/high/low/close` (decimal strings), `volumeToken`/`volumeQuote` (strings), `tradeCount` (number) | `time` (number), `open/high/low/close` (number), `volume` (number, singular) | field names differ, and number vs. string typing on every OHLC field |
| 6 | `/tokens/:address/trades` item | `traderAddress`, `tokenAmountRaw`, `quoteAmountRaw`, `price`, `blockTimestamp` (string) | `trader`, `amountToken`, `amountEth`, `priceEth`, `blockTimestamp` (number) | field renames + timestamp type mismatch |
| 7 | `/tokens/:address/holders` | item `{address, balance}`, no `pct`; page has no `totalHolders` | item `{address, balance, pct}`; page has `totalHolders` | C expected a `pct`-of-supply field and a rollup count B didn't produce |
| 8 | `/search` | `{ items: TokenSummary[] }` (object) | `z.array(...)` (bare array) | wire-shape disagreement — C's client would throw on every real B response |
| 9 | `/stats` | `{tokensLaunched, totalVolumeQuote, totalTrades}` (all-time) | `{totalTokens, totalVolume24hEth, totalLaunches24h}` (24h-windowed) | different names **and** different semantics — B never computed a 24h stats window |
| 10 | pagination | `nextCursor: undefined` when exhausted (Hono drops the key) | zod `.nullable()` (requires the key present as `null`) | a finished page would fail C's schema parse — a real bug |
| 11 | spec vs. its own plan | spec's table said `priceChange24hBps`; the plan's shipped code named the field `priceChangeBps24h` | — | B's own two documents disagreed before C even entered the picture |

## What changed, per file

### B spec (`2026-08-22-indexer-design.md`)
- Rewrote the "API surface" section: added a wire-format contract note (bigint-backed columns → decimal strings; small integers stay numbers; `nextCursor` always present, `null` on the last page).
- Fixed the `/tokens` row to match the plan's actual field name (`priceChangeBps24h`) and added `marketCap` (computed, `price × supply / 1e18`).
- Added `deployer`, `dexId`, `launchConfigId` to the `/tokens/:address` row (already-indexed data, just not previously surfaced).
- Documented candles/trades string-vs-number typing explicitly, and noted C converts to numbers client-side only for chart rendering.
- Added `pct` and `totalHolders` to the `/tokens/:address/holders` row.
- Added two new rows: `GET /launch-configs` (`{launchConfigIds, dexIds}`, two independent enabled-id lists) and `GET /wallets/:address/holdings` (cursor-paginated, `valueEth` mark-to-market).
- Added a note to the existing "Known limitation" paragraph making explicit that `feeWallet` is intentionally not an API field (undeliverable by B, unused by C).

### B plan (`2026-08-22-indexer.md`)
- Task 7: added `marketCap` to `toSummary`/`TokenSummaryRow`; fixed `/tokens`'s `nextCursor` to always emit `null` instead of `undefined`.
- Task 8: added `deployer`/`dexId`/`launchConfigId`/`description` to `/tokens/:address`; fixed `/trades` and `/holders` cursor-null bug; added `pct` + `totalHolders` to `/holders` (one extra cheap lookup against `tokens.supply`/`tokens.holderCount`, not a new aggregation).
- Task 9 (retitled to include the two new endpoints): added implementation steps for `GET /launch-configs` and `GET /wallets/:address/holdings`, plus integration-test assertions appended to Task 10's `anvil.integration.test.ts` (a `SENDER_ADDRESS`/`RECIPIENT` constant pair and two new `it(...)` blocks), and a new `/tokens` list assertion confirming `marketCap` is populated and `nextCursor` is never omitted.
- Self-review section updated to mention the two added endpoints and their provenance.

### C spec (`2026-08-22-frontend-design.md`)
- §7 ("Consuming packages/shared + B's API"): replaced the "provisional, not yet documented" framing with a full account of the agreed contract per endpoint (wire typing, pagination, and every renamed/added/removed field), matching B's spec verbatim.
- §9: marked the `/launch-configs`/`/wallets/:address/holdings` open item resolved, with a pointer to §7.
- §2.2/§2.4: removed "provisional"/"not yet confirmed" language for the two endpoints now that B specifies them; updated the `/launch-configs` description to the two-independent-id-lists shape.

### C plan (`2026-08-22-frontend.md`)
- Global Constraints: updated to state the schema now mirrors B's field-for-field, not a guess.
- Task 5: rewrote `schema.ts` end-to-end to match B's contract — renamed almost every field (`logoUrl→logo`, `priceEth→price`, `marketCapEth→marketCap` (now real), `volume24hEth→volume24h`, `change24hPct→priceChangeBps24h`, `holders→holderCount`, `launchedAt→launchTimestamp`, trades' `trader/amountToken/amountEth/priceEth→traderAddress/tokenAmountRaw/quoteAmountRaw/price`), switched candle/trade/amount fields from `z.number()` to decimal-string `z.string()`, dropped `feeWallet` and list-level `poolAddress` from the schemas, added `deployer`/`poolFee`/`pairedToken`/`graduationThreshold` to the detail schema, made `/search` an `{items:[...]}` object schema, corrected `/stats` to B's all-time counters, changed `launchConfigsSchema` to `{launchConfigIds, dexIds}`, added pagination (`nextCursor`) to `holdingsSchema`, and added a `Candle`/`ChartCandle` type split (wire strings vs. chart-ready numbers). Updated `client.ts`'s `fetchHoldings`/`fetchLaunchConfigs`/`search` accordingly, and expanded the fixture set to include `holdings.json`/`launch-configs.json`.
- Task 6 (Explore): clarified that `price`/`marketCap`/`volume24h` are already human-decimal strings from B (not wei), so `formatEth` doesn't apply to them; `formatPct`/`formatAge` still convert `priceChangeBps24h`/`launchTimestamp`.
- Task 7: rewrote `useAvailableLaunchConfigs`'s fallback probe to return the same `{launchConfigIds, dexIds}` shape B's endpoint returns (previously produced a paired-array shape that didn't match).
- Task 10: added a `toChartCandles` conversion function (wire decimal strings → the plain numbers `lightweight-charts` needs) and updated `PriceChart`'s field references (`bucketStart` instead of `time`, etc.).
- Self-review section updated to record the reconciliation.

## Final agreed endpoint list

| Endpoint | Params | Response |
|---|---|---|
| `GET /tokens` | `sort`, `limit`, `cursor` | `{ items: TokenSummary[], nextCursor }` — `address, name, symbol, logo, price, marketCap, volume24h, priceChangeBps24h, holderCount, launchTimestamp` |
| `GET /tokens/:address` | — | `TokenSummary` + `deployer, poolAddress, pairedToken, poolFee, dexId, launchConfigId, supply, restrictionsEndBlock, graduationThreshold(+note), description, socials` |
| `GET /tokens/:address/candles` | `interval`, `from`, `to` | `{ interval, items: Candle[] }` — `bucketStart, open, high, low, close, volumeToken, volumeQuote, tradeCount` |
| `GET /tokens/:address/trades` | `limit`, `cursor` | `{ items: Trade[], nextCursor }` — `txHash, logIndex, side, traderAddress, tokenAmountRaw, quoteAmountRaw, price, blockTimestamp` |
| `GET /tokens/:address/holders` | `limit`, `cursor` | `{ items: Holder[], nextCursor, totalHolders }` — `address, balance, pct` |
| `GET /tokens/:address/holders/count` | — | `{ count }` |
| `GET /search` | `q` | `{ items: TokenSummary[] }` |
| `GET /stats` | — | `{ tokensLaunched, totalVolumeQuote, totalTrades }` (all-time) |
| `GET /launch-configs` (new) | — | `{ launchConfigIds: number[], dexIds: number[] }` |
| `GET /wallets/:address/holdings` (new) | `limit`, `cursor` | `{ items: Holding[], nextCursor }` — `tokenAddress, name, symbol, logo, balance, valueEth` |

**Wire-format rules (both plans now state this identically):** every `bigint`-backed column (amounts, prices, supply, block numbers/timestamps) serializes as a decimal string, uint256-safe; small bounded integers (`holderCount`, `tradeCount`, `logIndex`, `poolFee`, bps values) stay JSON numbers; every list endpoint's `nextCursor` is always present, `null` on the last page, and the cursor itself is the same opaque base64url `{v: string}` shape everywhere.
