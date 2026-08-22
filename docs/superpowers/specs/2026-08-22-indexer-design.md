# Sub-project B — Indexer (Ponder.sh over the pons-v1 launchpad contracts)

**Status:** approved design, 2026-08-22
**Repo:** launchpad-01 · **Chain:** Robinhood Chain (id 4663; testnet 46630); local dev/test on Anvil started with `--chain-id 4663`
**Depends on:** [docs/research/00-digest.md](../../research/00-digest.md) §2–3 · [docs/research/20-indexer-architecture.md](../../research/20-indexer-architecture.md) · [docs/research/01-decomposition.md](../../research/01-decomposition.md) · Sub-project A: [2026-08-22-contracts-design.md](2026-08-22-contracts-design.md) (**DONE, merged**)

## Goal

Watch our own `LaunchFactory` (sub-project A, already built and merged), every Uniswap V3 pool it creates, and every launched token's own ERC-20 `Transfer` log; decode them into a reorg-safe Postgres store; and serve the paginated/sortable/filterable read API sub-project C needs for Explore/Trade/holders/search — none of which any single RPC call answers. Built on **Ponder.sh** so every RPC-hardening lesson the digest documents carries over directly (Ponder is "just" a structured viem program), and reorg-safety/backfill/checkpointing come from the framework, not hand-rolled.

## Scope & non-goals

**In scope — A's actual, shipped v1 shape, not the general two-protocol research doc.** A only builds the pons-v1 model: one atomic `launchToken` call → fixed-supply token + a Uniswap V3 pool that never migrates (confirmed by reading `contracts/src/LaunchFactory.sol` and `packages/shared/abis/*.ts`: there is no bonding curve, no second factory, no graduation state machine anywhere in this repo). So B indexes exactly:

1. `LaunchFactory.TokenLaunched` — our own signature, frozen in `packages/shared/abis/LaunchFactory.ts`.
2. `LaunchFactory.LaunchConfigSet(id)` / `DexConfigSet(id)` — admin config-change notifications (no struct payload; the indexer re-reads `getLaunchConfig(id)`/`getDexConfig(id)` on receipt).
3. Each launched token's own Uniswap V3 pool `Swap` (dynamically registered per `TokenLaunched.pool`).
4. Each launched token's own ERC-20 `Transfer` (dynamically registered per `TokenLaunched.token`).

**Explicitly out of scope — do not build against, do not leave hooks implying "later":**

- v2 bonding-curve `Buy`/`Sell` events, a curve contract, or a `phase`/graduation column — none of this exists in A. `tokens.graduation_threshold` is carried only for schema parity with `LaunchConfig.graduationThreshold` (the contracts spec calls it "inert" in v1); the API never computes a curve-progress percentage from it.
- Uniswap V4 `PoolManager.Swap` / `poolId` attribution, any graduation event, any "post-graduation" trading path.
- Multi-quote-asset support: A's `LaunchConfig.pairToken` is WETH-only (contracts spec, Scope & non-goals). The indexer hardcodes 18-decimal quote pricing; it does not read `pairToken.decimals()` per token.
- Multi-chain fan-out (one deployment indexes one chain at a time; chain id is config, not a loop).
- A push/WebSocket realtime layer. The v0 realtime story is polling `GET /tokens/:address/trades?since=`; a push layer is a documented follow-on, not built here.
- Reconstructing anything from the pool's own `slot0()` or the token's own self-reported getters as **provenance**. Pool identity, `pairedToken`, `isToken0`, `poolFee`, and `restrictionsEndBlock` come exclusively from `LaunchFactory.getLaunchedToken(token)` — never from a value the token or pool contract could lie about. (Reading the token's own `name()/symbol()/decimals()/logo()/description()/socials()` is fine — those are cosmetic, and it is the same immutable, factory-deployed contract the indexer just watched being created, not a self-report about *who launched it*.)

## Events indexed (exact ABIs — frozen A→B interface in `packages/shared`)

```solidity
// packages/shared/abis/LaunchFactory.ts — our own signature, LaunchFactory.sol
event TokenLaunched(
    address indexed token,
    address indexed deployer,
    address pool,
    uint256 launchConfigId,
    uint256 dexId,
    uint256 supply,
    uint256 initialBuyAmount
);
event LaunchConfigSet(uint256 indexed id);   // no struct payload — re-read getLaunchConfig(id)
event DexConfigSet(uint256 indexed id);      // no struct payload — re-read getDexConfig(id)
```

```solidity
// packages/shared/abis/UniswapV3Pool.ts — standard Uniswap V3 pool event,
// registered per-pool via the factory pattern keyed on TokenLaunched.pool
event Swap(
    address indexed sender,
    address indexed recipient,
    int256 amount0,
    int256 amount1,
    uint160 sqrtPriceX96,
    uint128 liquidity,
    int24 tick
);
```

```solidity
// packages/shared/abis/ERC20.ts — standard ERC-20 Transfer, registered
// per-token via the factory pattern keyed on TokenLaunched.token
event Transfer(address indexed from, address indexed to, uint256 value);
```

Note what `TokenLaunched` does **not** carry: no `name`/`symbol`/`logo`/`description`/`socials` (those live in `TokenParams`, which is a call argument, not event data) and no dev-buy recipient address. The `TokenLaunched` handler therefore always issues one batched `context.client.multicall` read (§ RPC hardening) against `LaunchFactory.getLaunchedToken(token)` (authoritative provenance: `pairedToken`, `isToken0`, `poolFee`, `positionId`, `restrictionsEndBlock`) plus the token's own metadata getters (`name`, `symbol`, `decimals`, `logo`, `description`, `socials` — from `packages/shared/abis/Token.ts`) plus `balanceOf(pool)` (see "Known limitation" below) in a single round trip.

**Known limitation, accepted:** the token constructor's own mint (`Transfer(0x0 → factory)`) and the atomic launch's pool-seed/dev-buy transfers land at **earlier log indices in the same transaction** than `TokenLaunched` itself (`Token` is deployed and seeded before the factory emits its own event). Whether Ponder's factory-pattern registration retroactively captures same-transaction logs that precede the announcing log is verified empirically in Task 10, not assumed. To not depend on the answer, the `TokenLaunched` handler seeds the pool's `holders` row directly from a live `balanceOf(pool)` read (always correct, one extra multicall entry, no extra round trip) rather than waiting to observe a `Transfer` for it. The one balance this does **not** cover is the dev-buy recipient's initial balance when `initialBuyAmount > 0` (the event has no recipient field, so the indexer cannot resolve it without either catching the real `Transfer` log or decoding the launch transaction's calldata) — accepted as a bounded, documented gap affecting exactly one address until its own next transfer; not silently ignored, and if Task 10 shows the log is missed, decoding `TokenParams.feeWallet` from `event.transaction.input` is the concrete follow-up (recorded, not implemented speculatively here).

## Data model (Postgres via Ponder `onchainTable`)

All wei-scale amounts are `bigint` (Ponder maps this to Postgres `numeric`, never a float). Prices are stored as **fixed-point `bigint` scaled by 1e18** ("`price18`"), computed once from `sqrtPriceX96` (§ below) — never as a float and never as a pre-formatted string in storage; formatting to a decimal string happens only at the API response boundary.

### `tokens` — one row per launch
| column | type | notes |
|---|---|---|
| `address` | `hex` (PK) | the launched token |
| `deployer` | `hex` | from `TokenLaunched` |
| `name`, `symbol` | `text` | from `Token.name()/symbol()` |
| `decimals` | `integer` | from `Token.decimals()` (always 18 in practice, read live anyway) |
| `logo`, `description` | `text` | from `Token.logo()/description()` |
| `socials` | `json` `{twitter,telegram,discord,website,farcaster}` | from `Token.socials()` |
| `poolAddress` | `hex` | from `TokenLaunched.pool` |
| `pairedToken` | `hex` | from `getLaunchedToken` (always WETH in practice) |
| `isToken0` | `boolean` | from `getLaunchedToken` — required to interpret every `Swap`'s signed amounts |
| `poolFee` | `integer` | from `getLaunchedToken` |
| `launchConfigId`, `dexId` | `bigint` | from `TokenLaunched` |
| `supply`, `initialBuyAmount` | `bigint` | from `TokenLaunched` |
| `restrictionsEndBlock` | `bigint` | from `getLaunchedToken` — anti-snipe window, contract-visible block number |
| `graduationThreshold` | `bigint` | from `getLaunchConfig(launchConfigId)`; **inert** (documented, never surfaced as a progress bar) |
| `launchBlock`, `launchTimestamp` | `bigint` | from the log's block |
| `launchTxHash` | `hex` | |
| `lastPrice18` | `bigint`, nullable | denormalized, set by the trade handler; null until the first `Swap` |
| `lastTradeAt` | `bigint`, nullable | |
| `holderCount` | `integer` | denormalized, maintained by the `Transfer` handler (crossing 0 ⇄ >0) |

Indexes: `deployer`, `symbol`, `launchTimestamp` (news/newest sort).

### `pools` — one row per token's trading venue
In v1 this is always exactly a 1:1 relationship with `tokens` (no migration), but it is kept as its own table — not columns on `tokens` — so `trades.pool_address` has a clean FK target and the schema does not need reshaping if a future v2 track adds a second venue per token.

| column | type | notes |
|---|---|---|
| `address` | `hex` (PK) | the Uniswap V3 pool |
| `tokenAddress` | `hex` | FK → `tokens.address` |
| `pairedToken` | `hex` | |
| `poolFee` | `integer` | |
| `createdBlock`, `createdTxHash` | `bigint` / `hex` | |

### `trades` — one row per decoded `Swap`
| column | type | notes |
|---|---|---|
| `id` | `text` (PK) | `` `${txHash}-${logIndex}` `` |
| `tokenAddress` | `hex` | FK → `tokens.address` |
| `poolAddress` | `hex` | FK → `pools.address` |
| `blockNumber`, `blockTimestamp` | `bigint` | |
| `txHash` | `hex` | |
| `logIndex` | `integer` | |
| `side` | `text` (`'buy' \| 'sell'`) | derived from the signed amount of the launched token — negative (pool paid out) ⇒ buy |
| `traderAddress` | `hex` | `event.args.recipient` — the beneficiary of the swap, not `sender` (which is often a router contract) |
| `tokenAmountRaw`, `quoteAmountRaw` | `bigint` | absolute values, base units |
| `price18` | `bigint` | fixed-point quote-per-token at this trade, scaled 1e18 |

### `candles` — precomputed OHLCV, materialized incrementally on trade arrival
| column | type | notes |
|---|---|---|
| `id` | `text` (PK) | `` `${tokenAddress}-${interval}-${bucketStart}` `` |
| `tokenAddress` | `hex` | |
| `interval` | `text` (`'1m'\|'5m'\|'1h'\|'1d'`) | |
| `bucketStart` | `bigint` | unix seconds, floor of `blockTimestamp` to the interval |
| `open`, `high`, `low`, `close` | `bigint` (`price18`) | |
| `volumeToken`, `volumeQuote` | `bigint` | |
| `tradeCount` | `integer` | |

### `holders` — running balances from `Transfer`
| column | type | notes |
|---|---|---|
| `id` | `text` (PK) | `` `${tokenAddress}-${holderAddress}` `` |
| `tokenAddress` | `hex` | |
| `holderAddress` | `hex` | |
| `balance` | `bigint` | never negative in a correct trace; a negative result is a bug, not a valid state, and is asserted against in tests |

### `launch_configs` / `dex_configs` — mirror of the factory's structs
Keyed by `id` (`bigint`, PK); columns mirror `LaunchConfig`/`DexConfig` verbatim (`pairToken, graduationThreshold, initialTick, supply, maxWalletBps, maxTxBps, restrictionBlocks, reservedFee, enabled, routerRequiresDeadline` / `name, factory, positionManager, swapRouter, poolFee, tickSpacing, enabled`). Refreshed by a live `getLaunchConfig(id)`/`getDexConfig(id)` read whenever `LaunchConfigSet(id)`/`DexConfigSet(id)` fires — **not** assumed static, matching the digest's explicit warning.

### sync/checkpoint state
Framework-owned. Ponder tracks per-chain sync progress and reorg-safe checkpoints internally (its own internal tables); this project defines no `sync_state` table of its own.

## API surface

Read-only HTTP, served by a Hono app Ponder mounts alongside its generated SQL-over-HTTP/GraphQL endpoints. All list endpoints are cursor-paginated (opaque base64 JSON cursor, never a raw offset) with a `limit` query param (default 25, capped at 100).

| Endpoint | Params | Response |
|---|---|---|
| `GET /tokens` | `sort` = `newest\|price\|holders` (default `newest`), `limit`, `cursor` | `{ items: TokenSummary[], nextCursor }` — each item: address, name, symbol, logo, `price` (formatted decimal string), `volume24h`, `priceChange24hBps`, `holderCount`, `launchTimestamp` |
| `GET /tokens/:address` | — | full `TokenSummary` + `poolAddress`, `pairedToken`, `poolFee`, `restrictionsEndBlock`, `graduationThreshold` (labeled inert), socials |
| `GET /tokens/:address/candles` | `interval` = `1m\|5m\|1h\|1d` (required), `from`, `to` (unix seconds) | `{ interval, items: Candle[] }` (open/high/low/close as decimal strings, volumes as decimal strings) |
| `GET /tokens/:address/trades` | `limit`, `cursor` | `{ items: Trade[], nextCursor }`, newest first |
| `GET /tokens/:address/holders` | `limit`, `cursor` | `{ items: Holder[], nextCursor }`, balance desc |
| `GET /tokens/:address/holders/count` | — | `{ count }` — reads the denormalized `tokens.holderCount`, no aggregation query |
| `GET /search` | `q` | `{ items: TokenSummary[] }` — exact address match short-circuits; otherwise `ilike` on `name`/`symbol` |
| `GET /stats` | — | `{ tokensLaunched, totalVolumeQuote, totalTrades }` global counters |

`volume24h`/`priceChange24hBps` on `/tokens` are **not** denormalized columns — they are computed at query time from the last 24 hourly `candles` rows per token (indexed, bounded per-page cost; avoids a second incrementally-maintained aggregate that could drift from the source-of-truth candles).

## Consuming `packages/shared`

`indexer/ponder.config.ts` imports `launchFactoryAbi`, `tokenAbi`, `uniswapV3PoolAbi`, `erc20Abi`, and `addresses` from `@launchpad/shared`. **Handling the not-yet-deployed factory:** `addresses[chainId].factory` is `null` until A's `Deploy.s.sol` actually broadcasts (confirmed by reading `packages/shared/addresses/4663.json`). The config resolves the factory address as `process.env.PONDER_FACTORY_ADDRESS ?? addresses[chainId].factory`, throwing a clear startup error if neither is set — Task 10's local Anvil deploy sets the env var from its own broadcast log rather than waiting on `packages/shared` regeneration.

## RPC-hardening requirements (carried over from digest §2/§3)

| Requirement | Where it lives |
|---|---|
| Chunk `eth_getLogs` ≤ ~10k blocks, split-on-refusal | `chains.<name>.ethGetLogsBlockRange = 10_000` in `ponder.config.ts` (Ponder halves and retries internally on a narrower-range refusal) |
| Sequential/Multicall3 reads over concurrency | Every indexing-function read is one batched `context.client.multicall` call, never parallel independent `readContract` calls (enforced by code review / task tests, not a framework flag) |
| Retry transient `-32601/-32603/-32005/-32000` + rate-limit/timeout/busy text | A custom transport wrapper (`indexer/src/lib/rpcTransport.ts`) wraps viem's `http()` and classifies+retries with backoff before rethrowing |
| No batch JSON-RPC assumption | The same transport wrapper disables viem's request batching (`http(url, { batch: false })`) |
| Contract-visible vs RPC block number | `restrictionsEndBlock` (read via `getLaunchedToken`) is stored and compared against **contract-visible** `block.number` semantics — the indexer never derives a restriction-window duration from RPC block height/timestamp deltas |
| Derive pool identity from `TokenLaunched` + factory record, never self-report | `pools`/`tokens.isToken0/pairedToken/poolFee` come from `getLaunchedToken`, never from reading the pool's own `token0()/token1()` speculatively or the token's own getters about itself |

## Testing strategy

1. **Deterministic fixture unit tests (no chain, no Ponder runtime).** All non-trivial logic — signed-amount → side/price derivation, `sqrtPriceX96` → `price18`, OHLCV bucket rollup, holder running-balance arithmetic, cursor encode/decode, sort/filter query building — is extracted into pure functions in `indexer/src/lib/*.ts` and tested by feeding literal known values (a real `sqrtPriceX96`, a real signed `amount0`/`amount1` pair, a sequence of transfers) and asserting exact `bigint` results. This is what "feed known launch/swap/transfer logs and assert the decoded rows/OHLCV buckets/holder balances" means concretely here.
2. **Local Anvil deploy of A.** Task 10 starts `anvil --chain-id 4663` (matching chain 4663 so `packages/shared/addresses/4663.json`'s DEX addresses apply unmodified), runs A's `contracts/script/Deploy.s.sol` with `--broadcast` against it, then drives real `launchToken`/buy/sell/transfer transactions via `cast`. This is the only stage that exercises the real Ponder sync engine, the factory pattern's dynamic registration, and reorg-safe checkpointing end-to-end.
3. **HTTP contract tests independent of a UI.** Task 10 starts the indexer's HTTP server against the synced local-Anvil data and asserts on raw `fetch()` responses (status, shape, values) — no browser, no frontend, no mocked database.
4. **Isolation between runs.** Each test run uses a fresh Ponder `--schema` value (Ponder requires this for isolated instances) and pglite's `directory: "memory://"` mode for CI, so runs never collide or leave state behind.

## Tech

`ponder@0.17.8` (pinned), `viem@2.55.19`, `hono@4.13.3` for custom API routes, Drizzle (bundled with Ponder) for schema + queries. `database.kind: "pglite"` for local dev/test (in-memory for CI, file-backed for iterative local dev), `database.kind: "postgres"` in any shared/staging deployment. Node v24, pnpm 9 (workspace root already pins `packageManager: "pnpm@9"`).

## To re-verify at build time (do not assume from this doc)

- Whether Ponder's factory-pattern child registration captures same-transaction logs at an earlier log index than the announcing event (see "Known limitation" above) — confirm empirically in Task 10.
- The real chain 4663 RPC's actual `eth_getLogs` ceiling and batch-JSON-RPC behavior, once a real endpoint (not local Anvil) is in the loop — the digest's ~10k figure and `batchMaxCount: 1` finding come from `pons-launcher`'s production experience, not from this repo's own measurement yet.
- Whether a paid RPC provider is available for chain 4663 before relying on the public endpoint's flakier behaviors in any non-local deployment.
