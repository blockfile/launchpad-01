# Indexer / Backend Architecture for a pons-style Launchpad

Design research for the read-side backend that will power an explore/trade
frontend (token list, token detail, charts, trades, holders, search) for a
launchpad recreated in the spirit of pons on Robinhood Chain (chain id 4663).
This file is about **indexing on-chain state into a queryable store** — it is
not about the launch/bundle/trade-execution backend, which `pons-launcher`
already implements and which this doc treats as a reference for chain
behavior, not as something to copy wholesale (that repo is an operator tool
with no public API and no persistent trade/price history at all — see
"What pons-launcher already does, and does not do" below).

---

## 1. Executive summary

- **Index on-chain events, not RPC polling of current state.** The pons docs
  say it plainly and the recommendation here agrees: *"Index the factory's
  `TokenLaunched` event, register each emitted pool, and index its `Swap`
  events. Onchain events are the authoritative source of truth."*
  (docs.ponsfamily.com, fetched 2026-08-22 — see §2 for the exact quote and
  important caveats about trusting this site).
- **The live product is not what the docs describe.** The docs describe one
  simple architecture (a factory that deploys straight into a Uniswap V3
  pool). The chain actually carries **two parallel, structurally different
  launch protocols** (a v1 "straight to Uniswap V3" factory and a v2 "bonding
  curve that graduates into Uniswap v4" factory), and `pons-launcher`'s own
  config comments say the docs' v2 factory address "has never emitted an
  event" — i.e. the docs page for v2 points at a dead deployment
  (`backend/src/config.js:41-45`). **Do not take this docs site as
  authoritative for addresses or architecture.** Anything it says must be
  cross-checked against events actually observed on chain, exactly as
  `pons-launcher` had to do (`backend/src/evm/v2/abi.js:10-14`).
- **Recommendation: a custom Node/TypeScript indexer built on Ponder.sh**,
  not a raw hand-rolled viem polling loop and not a TheGraph subgraph. Reasons
  are in §6; in short: no subgraph exists for this chain today, TheGraph's
  hosted infra assumes a supported chain + a deployed subgraph (neither
  exists here) and adds an operational dependency (a graph-node, IPFS,
  indexing rewards/curation if going decentralized) that buys nothing this
  project needs. A fully hand-rolled indexer re-solves problems (reorg
  handling, backfill checkpointing, RPC-quirk workarounds, schema
  migrations) that a framework already solves well. Ponder sits in the
  middle: it is "just" a TypeScript program using viem under the hood, so
  every RPC lesson `pons-launcher` already paid for (§7) transfers directly,
  while the framework supplies the indexing loop, reorg safety, backfill
  parallelism, and a Postgres-backed query layer for free.
- **Three trade-event shapes must be indexed, not one**: v1 Uniswap V3 pool
  `Swap`, v2 bonding-curve `Buy`/`Sell` (event names unconfirmed — see
  §2.4), and v2-post-graduation Uniswap v4 `PoolManager.Swap` (singleton
  contract, pool identified by `poolId`, not by contract address). A design
  that indexes only "the Swap event" from one ABI will silently miss two of
  the three.

---

## 2. On-chain events to index

### 2.1 What the docs say (verbatim, with source)

Fetched from `docs.ponsfamily.com` on 2026-08-22 via WebFetch:

> "Index the factory's `TokenLaunched` event, register each emitted `pool`,
> and index its `Swap` events. Onchain events are the authoritative source of
> truth."

The same page states the model as: one factory
(`0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`, "start block 8991118"), that
deploys every token into a Uniswap V3 pool against WETH
(`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`) at a fixed 1% fee tier, with a
graduation threshold of 4.2 ETH of paired WETH and **no migration** — "trading
continues in the same pool after graduation. Nothing moves or migrates."

**Caveats before trusting any of this:**

1. The factory address above matches `pons-launcher`'s configured `factoryAddress`
   (`backend/src/config.js:33`, lowercased) — so the *v1* picture is
   plausible. But `pons-launcher` also talks to a **second, live, higher-volume
   factory** — the v2 bonding-curve protocol at
   `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` — which the docs site does not
   describe on this page at all, and which the docs' own `/v2` page gets
   **wrong**: `backend/src/config.js:41-45` explicitly records that the v2
   address published in the docs "has never emitted an event" and is
   "superseded... without a changelog," and that the real address was found
   by scanning the chain for the `TokenLaunched` topic and reading whatever
   verified source actually emitted it. Treat every address and every
   architectural claim from docs.ponsfamily.com as a hypothesis to verify
   on-chain, never as ground truth — this is not a one-off doc bug, it is the
   established, repeated experience of the team that built the reference
   implementation.
2. Any hex/topic values a documentation fetch reports (event topic0 hashes in
   particular) should be **recomputed locally** (`keccak256` of the exact
   canonical event signature, e.g. via `viem`'s `getEventSelector` or
   `ethers`' `Interface.getEvent(name).topicHash`) rather than copy-pasted from
   a page — a summarized fetch of a doc page is not a reliable source for a
   32-byte hash, and topic0 for a launchpad's own `TokenLaunched` is
   protocol-specific (its argument list differs between v1 and v2; see below).
3. "No bonding curve or migration mechanism" is true of v1 but is **not** the
   whole product: v2 is exactly a bonding-curve-then-graduate design, which is
   the more pump.fun-shaped, higher-activity path (`pons-launcher`'s own
   comments describe it as having "thousands of launches", vs. the v1 factory
   note that the doc address is at least real — `backend/src/evm/v2/abi.js:10-14`,
   `backend/src/config.js:37-39`).

**Design implication:** build the indexer against **both** protocols from day
one if this project is recreating what's actually live on chain, not just
what the marketing docs describe. If the new launchpad is a fresh product
that will only ever run the *new* factory it deploys itself, this whole
docs-vs-reality gap still matters as a cautionary example: **whatever the new
factory's own docs/spec say, verify the deployed bytecode's real events before
writing indexing code against them.**

### 2.2 v1 protocol — factory → Uniswap V3 pool directly

- Factory: `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (config default,
  `backend/src/config.js:33`).
- Registry read: `getLaunchedToken(address) view returns (LaunchedToken)` —
  the authoritative "who launched this and what pool/config did it use" record
  (`backend/src/evm/abi.js:31-34`, `backend/src/evm/factory.js:98-117`). Fields:
  `token, deployer, pairedToken, positionManager, positionId, dexId,
  launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee, exists,
  initialBuyAmount`.
- **The v1 `TokenLaunched` event's exact signature is not present anywhere in
  `pons-launcher`** (its `FACTORY_ABI` only lists functions —
  `backend/src/evm/abi.js:36-45` — because the launcher's own code never needs
  to parse the v1 launch event; it always knows the token address it just
  deployed). **Do not guess this signature.** Pull the verified ABI from
  Blockscout (`robinhoodchain.blockscout.com`, see §2.5) for the real v1
  factory address before writing an indexing handler for it.
- Pool: a standard Uniswap V3 pool, one per launch, at a fixed fee tier read
  from the token's `LaunchedToken.poolFee` / the selected `DexConfig.poolFee`
  (`backend/src/evm/abi.js:21-24`; docs say 10000 = 1%). Price is read from
  `slot0().sqrtPriceX96` (`backend/src/evm/pricing.js:28-31`), and pool
  address is derived via `V3Factory.getPool(token, pairToken, fee)` — **never**
  trust a token's self-reported `liquidityPool()` getter for provenance
  (`backend/src/evm/pricing.js:40-58`, `backend/src/evm/factory.js:90-96`
  explains why: a hostile ERC-20 can lie about itself).
- Trade event: the pool's own **standard Uniswap V3 `Swap` event**:
  ```
  event Swap(address indexed sender, address indexed recipient,
              int256 amount0, int256 amount1,
              uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  ```
  This is the one "Swap" the docs' generic guidance is describing for the v1
  path. `amount0`/`amount1` signed deltas give trade direction and size
  directly; sign convention depends on which token is `token0` (`isToken0` in
  the launch record tells you which).
- Graduation: v1 has none — it is a direct-to-pool launch with a restriction
  window (`restrictionsEndBlock`), not a curve-then-graduate design
  (`backend/src/evm/abi.js:31-34` has no graduation fields; the docs'
  "graduationStatus(token)" claim, if real, is worth confirming against the
  verified v1 factory/token source rather than assumed — it does not appear in
  `pons-launcher`'s transcribed ABI at all).

### 2.3 v2 protocol — factory → bonding curve → graduates into Uniswap v4

- Factory (the **real, live one** — not the docs' address):
  `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
  (`backend/src/config.js:44-45`, `backend/src/evm/v2/abi.js:5-14`).
- **`TokenLaunched` event — confirmed, verbatim from the verified source**:
  ```solidity
  event TokenLaunched(
    address indexed token,
    address indexed curve,
    address indexed deployer,
    address pairToken,
    uint256 launchConfigId,
    uint256 graduationThreshold
  );
  ```
  (`backend/src/evm/v2/abi.js:95`). This is the exact event the indexer's
  ingestion handler should decode for v2 launches — three indexed topics
  (`token`, `curve`, `deployer`) plus `pairToken`/`launchConfigId`/
  `graduationThreshold` in the data. Every v2 launch **creates its own curve
  contract** (one per token) rather than a pool — there is no Uniswap
  involvement at all until graduation.
- Registry read: `getLaunchedToken(address) view returns (tuple(address
  token, address curve, address deployer, address creatorFeeRecipient,
  address pairToken, uint256 graduationThreshold, uint24 poolFee, int24
  tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase,
  uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))`
  (`backend/src/evm/v2/abi.js:93`) — note the `phase`, `sweptQuote`,
  `sweptTokens`, `sweptAt` fields: this is the graduation bookkeeping. `phase`
  is almost certainly an enum (pre-graduation / graduated / swept) worth
  decoding once the real values are confirmed from source.
- **Bonding-curve trade events are NOT transcribed anywhere in
  `pons-launcher`.** `CURVE_V2_ABI` only lists the `buy`/`sell`
  *functions* and a long list of view getters (`backend/src/evm/v2/abi.js:115-141`)
  — no `event` at all. Since `pons-launcher` never needs to parse a curve's
  own trade log (it only ever calls `buy`/`sell` itself and reads current
  reserves), **the curve's actual Buy/Sell event ABI is an open question that
  must be pulled from the verified source of `PonsV2BondingCurve` on
  Blockscout before an indexer can decode curve trades.** Do not assume the
  event is named `Swap` — a bonding curve commonly emits something like
  `Buy(address indexed buyer, uint256 quoteIn, uint256 tokensOut, ...)` /
  `Sell(...)`, structurally different from a Uniswap `Swap`. This is the
  single most important unknown to close before writing v2 trade-ingestion
  code; treat it as a first implementation task, not an assumption.
- State needed to compute a curve's live price without an event at all:
  `getReserves() → (quoteReserve, tokenReserve)`, `phantomQuote()` (a virtual
  reserve added to quote-side liquidity — constant-product pricing is done
  against `quoteReserve` which *already includes* the phantom amount, per
  `backend/src/evm/v2/curve.js:41-71` and the worked, chain-verified formula in
  `backend/src/evm/v2/holdings.js:418-450`), `feeBps()`, `creatorTaxBps()`,
  `graduationThreshold()`, `readyToGraduate()`, `graduated()`. An indexer
  should snapshot reserves on every trade event (or recompute via a view call
  keyed to the trade's block) so a price candle can be built even before the
  curve's own event ABI is nailed down.
- Graduation: reaching `graduationThreshold` in quote reserves moves the
  curve to "ready to graduate"; a completed graduation "sweeps" (`sweptQuote`,
  `sweptTokens`, `sweptAt`) into a Uniswap v4 pool
  (`route: 'uniswap-v4'` is the exact term `pons-launcher`'s own sell-router
  selector uses for a graduated v2 token — `backend/src/evm/v2/holdings.js:786`).
  **A graduation event almost certainly exists** (the v2 error ABI names
  `GraduationRescueTooEarly`, `GraduationSeedNotViable`,
  `GraduationStillViable`, `NotReadyToGraduate`, `NothingToGraduate`,
  `WrongGraduationPhase` — `backend/src/evm/v2/abi.js:174-221` — which is
  strong indirect evidence of a graduation state machine with real
  transitions worth capturing as events), but again its exact signature is
  not transcribed anywhere in this codebase and must be pulled from the
  verified curve/factory source.
- Post-graduation trading: **Uniswap v4**, not v3. This is architecturally
  different from the v1 path in a way that matters a lot for an indexer:
  Uniswap v4 uses a **singleton `PoolManager`** contract — there is no
  per-pool contract to watch. Every v4 pool's swaps are emitted from the *same*
  `PoolManager` address, keyed by a `PoolId` (a hash of the pool's
  `PoolKey`), e.g.:
  ```solidity
  event Swap(
    PoolId indexed id, address indexed sender,
    int128 amount0, int128 amount1,
    uint160 sqrtPriceX96, uint128 liquidity,
    int24 tick, uint24 fee
  );
  ```
  (Uniswap v4 core, confirmed via docs.uniswap.org / v4-core source, 2026.)
  An indexer needs to (a) watch `PoolManager.Initialize` to learn which
  `poolId` corresponds to which graduated token, and (b) filter/attribute
  `PoolManager.Swap` logs by `poolId`, not by "the pool's address" — there
  is no such per-pool address in v4. This is the detail most likely to be
  gotten wrong by copying v1/v3-shaped indexing code onto the v2-graduated
  path.

### 2.4 Summary table — what to watch, per protocol

| Protocol | Launch event | Trade event | Contract shape | Confirmed in pons-launcher? |
|---|---|---|---|---|
| v1 | `TokenLaunched` (v1 factory) | Uniswap V3 `Swap` | one pool contract per launch | Launch event: **no** (function-only ABI). Trade event: yes, standard V3. |
| v2 pre-graduation | `TokenLaunched` (v2 factory) | curve `Buy`/`Sell` (name TBD) | one curve contract per launch | Launch event: **yes**, verbatim (`v2/abi.js:95`). Trade event: **no** — must pull from verified curve source. |
| v2 post-graduation | (graduation event, name TBD) | Uniswap v4 `PoolManager.Swap`, keyed by `poolId` | one singleton `PoolManager` for every pool | Neither confirmed in this codebase; inferred from custom-error names and the `route: 'uniswap-v4'` label. |

### 2.5 How to close the open questions before implementation

Robinhood Chain's explorer is Blockscout
(`robinhoodchain.blockscout.com`, confirmed live and chain-specific — see
Blockscout's own announcement of Robinhood Chain support). Concretely:

1. Pull the verified source / ABI for the v1 factory, the v2 curve
   implementation, and the v2 graduation path from Blockscout's contract
   pages (or its API — Blockscout exposes a documented REST + a "Pro" API
   with log/transaction endpoints) rather than trusting docs.ponsfamily.com.
2. Decode one known launch's transaction receipt for each protocol (a v1
   launch tx, a v2 launch tx, one v2 graduation tx) with the verified ABI to
   confirm event names/argument order before writing permanent indexing
   code — this is exactly the discipline `pons-launcher` used to find the
   real v2 factory address (`backend/src/evm/v2/abi.js:10-14`) and to reverse
   the correct sell-quote formula against a live call rather than the docs
   (`backend/src/evm/v2/holdings.js:426-431`, which cross-checked its formula
   against two real on-chain reads to the wei before trusting it).
3. Compute topic0 hashes locally from the confirmed signatures (e.g.
   `ethers.Interface(['event ...']).getEvent(name).topicHash` or viem's
   `toEventSelector`) — never copy a hash from a doc fetch.

---

## 3. Chain-specific realities that shape the indexer

Robinhood Chain (chain id 4663) is an Arbitrum-Orbit L2 settling to Ethereum
with blob data availability, block time ~0.1s. Several things
`pons-launcher` learned the hard way apply directly to indexer design:

- **`block.number` inside a contract is NOT the RPC's block height.**
  Arbitrum-family chains report the *parent chain's* block number to
  `block.number`, so a contract sees it advance roughly every 12-16s even
  though the RPC's own block height climbs ~10x/second
  (`backend/src/evm/blocknumber.js:1-16`, confirms measured ~100ms RPC block
  time vs ~16s contract-visible `block.number`). **Implication for the
  indexer**: cursoring/checkpointing over `eth_getLogs`/`eth_blockNumber`
  ranges is fine (that's RPC-level, moves fast), but anything that
  reconstructs a launch's *contract-relative* timing (e.g. `restrictionsEndBlock`,
  a snipe-tax window measured in blocks) must reason in the slower,
  contract-visible block number, not the RPC height, or duration math will be
  off by roughly 160x.
- **The public RPC load-balances across heterogeneous nodes and is flaky in
  specific, characterized ways**: intermittent spurious `-32601 Method not
  found` on a perfectly valid call, and (separately) a hard 10,000-block
  range cap on `eth_getLogs` from at least one backing node (QuickNode),
  which the launcher discovered because an unbounded backward scan hung a
  production endpoint for hours (`backend/src/evm/provider.js:29-40`,
  `backend/src/evm/v2/holdings.js:94-116`). An indexer's backfill must chunk
  `eth_getLogs` ranges defensively (assume ~10k blocks is the safe ceiling,
  halve-and-retry on refusal) and must retry transient RPC error codes/text
  rather than treating them as fatal.
- **Concurrency hurts, it doesn't help, against this node.** Measured: the
  same `eth_call` took 0.5s alone and 22s issued alongside four concurrent
  others; 8 concurrent `getLogs` calls took 16s vs 0.3s each issued
  sequentially (`backend/src/evm/v2/holdings.js:76-81, 246-266`). **A
  backfill indexer should default to sequential/low-concurrency RPC batches
  against this specific chain**, batching reads via **Multicall3** (deployed
  at the canonical address on this chain — `backend/src/evm/v2/holdings.js:83-90`,
  `backend/src/evm/blocknumber.js:13-21`) rather than firing many small calls
  concurrently.
- **Batch JSON-RPC requests can misbehave.** `pons-launcher` pins
  `batchMaxCount: 1` because "some RH RPC nodes mishandle batch arrays"
  (`backend/src/evm/provider.js:108-113`). If choosing a framework/provider
  that batches JSON-RPC calls by default (viem does, for multicall-style
  batching of `eth_call`), verify this against the real RPC early — it may
  need to be disabled or routed through Multicall3 instead of native
  batching.
- **A dedicated/paid RPC is worth it.** All of the above are public-RPC
  behaviors; a paid provider (Alchemy/QuickNode/etc., if one supports this
  chain) or a self-hosted node removes most of this class of problem and
  should be evaluated before over-engineering around the public endpoint's
  quirks.
- Reorgs: Orbit/Arbitrum-family sequencers are effectively single-writer with
  fast, deterministic ordering; deep reorgs are not the normal failure mode
  they are on probabilistic-finality L1s, but a shallow reorg from a sequencer
  restart/backlog is not impossible. Any indexing framework/pattern chosen
  should still track a small confirmation depth and be able to roll back the
  last N blocks' rows cleanly (Ponder provides this natively — see §6).

---

## 4. Data model

Minimum viable relational schema (Postgres). Names are illustrative, not
final; identifiers throughout should be lower-cased checksummed addresses
stored as `citext`/`bytea` per taste, with raw base-unit amounts kept as
`numeric`/`text` (never a floating type) since token amounts are wei-scale
integers, exactly as `pons-launcher` keeps a `*Raw` string alongside every
formatted amount for arithmetic
(`backend/src/evm/v2/holdings.js:787-795`).

### `tokens`
One row per launched token, across both protocols.

| column | notes |
|---|---|
| `address` (PK) | checksummed token address |
| `protocol` | `'v1' \| 'v2'` |
| `deployer` | from the launch event / registry read |
| `name`, `symbol`, `decimals` | from ERC-20 + launch metadata |
| `logo_uri`, `description`, `socials` (jsonb: twitter/telegram/discord/website/farcaster) | from `TokenParams`/`Socials` at launch (`backend/src/evm/abi.js:7-12`, `v2/abi.js:32-42`) |
| `launch_config_id`, `dex_config_id` (v1) / `pool_fee`, `tick_spacing` (v2) | which config the launch used |
| `pair_token` | quote asset (WETH or another approved pair) |
| `curve_address` (v2 only, nullable) | the bonding curve contract |
| `pool_address` (v1) / `pool_id` (v2 post-graduation, bytes32) | where trades happen |
| `graduation_threshold` | raw units |
| `phase` / `graduated` (bool) / `graduated_at` | current lifecycle state |
| `launch_block`, `launch_tx_hash`, `launch_timestamp` | provenance |
| `restrictions_end_block` (v1) | anti-snipe window |

### `pools`
One row per trading venue a token has had (a v2 token has up to two: the
curve, then the graduated v4 pool — modeling this as its own table rather
than columns on `tokens` avoids losing curve-era history when a token
graduates).

| column | notes |
|---|---|
| `id` (PK) | pool/curve address, or `poolId` for v4 |
| `token_address` (FK) | |
| `kind` | `'uniswap_v3' \| 'bonding_curve' \| 'uniswap_v4'` |
| `venue_address` | the pool contract (v1/curve) or the singleton `PoolManager` (v4) |
| `pair_token` | |
| `fee_bps` / `tick_spacing` | |
| `created_block`, `created_tx_hash` | |
| `retired_at_block` (nullable) | set when a curve is superseded by graduation |

### `trades`
One row per decoded swap/buy/sell, across all three event shapes, normalized.

| column | notes |
|---|---|
| `id` (PK) | `tx_hash` + `log_index` |
| `token_address` (FK), `pool_id` (FK) | |
| `block_number`, `block_timestamp`, `tx_hash`, `log_index` | |
| `side` | `'buy' \| 'sell'` — derived from signed amounts + which side is the launched token |
| `trader_address` | sender/recipient per event semantics |
| `token_amount_raw`, `quote_amount_raw` | as returned on-chain, base units, `numeric`/`text` |
| `price_quote_per_token` | computed at ingest time for convenience (still derivable from the raw amounts, kept for query speed) |
| `fee_bps_applied`, `tax_bps_applied` (v2) | pons v2 charges a decaying snipe tax on the recipient and a creator tax on output (`backend/src/evm/v2/abi.js:24-30`, `holdings.js:439-450`) — worth recording per-trade so a chart can show gross vs. net |

### `candles`
Precomputed OHLCV, one row per `(token_address, interval, bucket_start)`.
Either materialized incrementally as trades arrive (recommended — see §5)
or computed on read from `trades` for long tail intervals. Standard
`open, high, low, close, volume_token, volume_quote, trade_count`.

### `holders`
Either a live materialized view derived from ERC-20 `Transfer` events
(balance = running sum of in/out per holder) or a snapshot table refreshed
periodically. Needed for "holder count" on the explore list and the token
detail page. `Transfer` is on the token contract itself, decoded uniformly
regardless of protocol (`backend/src/evm/erc20.js` already has the base
ERC-20 ABI reference for reads — no Transfer-event tracking exists in
`pons-launcher` today since it only ever reads live `balanceOf`, see §8).

### `launch_configs` / `dex_configs`
Mirror of the factory-level config structs
(`backend/src/evm/abi.js:14-24`, `v2/abi.js:44-46`) — supply, graduation
threshold, fee tier, wallet/tx caps, enabled flag. Read once per config id
and cached; these change rarely (factory-owner-only) but should still be
event- or poll-refreshed rather than assumed static forever.

### `sync_state`
One row per watched contract (or per protocol): `last_indexed_block`,
`last_indexed_log_index`, so the indexer can resume after a restart without
reprocessing or gapping. (A framework like Ponder manages this internally;
still worth understanding as a concept when evaluating any option in §6.)

---

## 5. API surface for the explore/trade frontend

Read-only HTTP API in front of the store above (REST or GraphQL — Ponder can
generate a GraphQL API directly off the schema, see §6; a hand-rolled
indexer would need this layer built explicitly).

- `GET /tokens` — paginated, sortable explore/board list.
  - Sort: newest, market cap / curve progress, 24h volume, 24h price change,
    trade count.
  - Filter: protocol (v1/v2), graduated/not-graduated, search term (name,
    symbol, address — see search below).
  - Each row: address, name, symbol, logo, price, 24h change, 24h volume,
    market cap (or curve progress toward `graduationThreshold` for
    pre-graduation v2 tokens — this "progress bar" is the signature
    pump.fun-style UI element and needs `quoteReserve / graduationThreshold`
    computed cheaply, ideally denormalized onto the `tokens` row and updated
    on every trade rather than computed per request), holder count, age.
- `GET /tokens/:address` — token detail: full metadata/socials, current
  price, curve/pool state (reserves, `graduated`, `readyToGraduate`, phase),
  launch info (deployer, block, tx), links to explorer.
- `GET /tokens/:address/candles?interval=1m|5m|1h|1d&from=&to=` — OHLCV series
  for the chart.
- `GET /tokens/:address/trades?cursor=&limit=` — recent trades feed
  (trader, side, amounts, price, tx hash, timestamp), cursor-paginated for a
  live-updating "recent trades" panel.
- `GET /tokens/:address/holders?cursor=&limit=` — holder list with balances
  and % of supply; `GET /tokens/:address/holders/count` cheap variant for the
  list-page holder count badge.
- `GET /search?q=` — by name/symbol substring and by exact address; should
  hit an index (trigram/`pg_trgm` on name+symbol, direct PK lookup on
  address) rather than a table scan.
- `GET /stats` (optional) — global counters (tokens launched today, total
  volume, total graduated) for a landing-page header.
- Realtime: either WebSocket/SSE push of new trades per token (for a live
  chart/ticker) or short-poll `trades?since=` — a launchpad's defining UX
  feature is the live-updating chart/feed, so this should not be an
  afterthought bolted onto a purely-REST design.

None of this exists in `pons-launcher` today — it has no public API, no
trade history, and no price charts (see §8) — so this surface is being
designed fresh for the new project, informed by what a pump.fun-shaped
explore/trade UI conventionally needs, not ported from the reference repo.

---

## 6. Indexer technology comparison

### Option A: TheGraph subgraph
- **No subgraph exists for this chain today** (confirmed by the docs fetch:
  "No third-party API or indexer service is mentioned" for pons; nothing in
  `pons-launcher` references TheGraph, a subgraph manifest, or a `graph-node`
  anywhere in the codebase).
- Would require either (a) deploying to TheGraph's decentralized network,
  which needs the chain to be supported by their indexer set — not
  guaranteed for a smaller/newer chain like this one — or (b) self-hosting a
  `graph-node` + Postgres + IPFS, which is real infrastructure to operate for
  a chain with no existing tooling/community subgraphs to fork from.
- AssemblyScript mapping logic is more awkward to iterate on than plain
  TypeScript, and local/self-hosted graph-node debugging is a known pain
  point relative to a plain Node process.
- **Verdict: not recommended.** The entire value of TheGraph is riding on
  existing chain support and an ecosystem of existing subgraphs to fork;
  neither is present here, so it is pure infrastructure cost with none of
  its usual payoff.

### Option B: Hand-rolled Node + viem indexer
- Full control, minimal dependencies, and every RPC quirk in §3 can be coded
  around exactly as `pons-launcher` already did for its own read paths
  (retry classification, Multicall3 batching, chunked/backing-off
  `eth_getLogs`).
- But this means **re-implementing**, from scratch and correctly: a
  block-by-block (or log-window) sync loop with checkpointing, reorg
  detection and rollback, backfill-vs-live-tail coordination, a query API
  layer (REST/GraphQL) on top of whatever store is chosen, and schema
  migrations as the model evolves. `pons-launcher`'s own log-scanning code
  (`backend/src/evm/v2/holdings.js:216-367`) is a good illustration of how
  much careful, non-obvious logic a "just call `getLogs`" indexer actually
  needs even for a narrow, bounded, single-purpose scan — a full indexer
  needs all of that plus reorg safety and a permanent store, none of which
  that scan attempts (it is explicitly a bounded, best-effort, non-authoritative
  fallback, not a source of truth store).
- **Verdict: viable but higher-cost.** Reasonable if the team wants zero
  framework dependency or needs indexing logic no framework can express
  cleanly (e.g. the v4 singleton-`PoolManager`/`poolId` attribution in §2.3 is
  slightly unusual and would need custom handling in any option), but it is
  strictly more work than Option C for the same guarantees, since Option C is
  itself "just" a structured way to write this same viem-based logic.

### Option C: Ponder.sh — recommended
- Ponder is a TypeScript framework purpose-built for exactly this shape of
  problem: define contracts + events in `ponder.config.ts`, write indexing
  functions per event in TypeScript, get automatic checkpointed backfill +
  live sync + reorg-safe rollback + a Postgres-backed store, with a
  generated GraphQL API and a documented "SQL over HTTP" query path out of
  the box (ponder.sh, github.com/ponder-sh/ponder — confirmed current as of
  2026).
- It uses viem internally and exposes a **viem client for reads inside
  indexing functions** (`context.client`), so every chain-specific technique
  above (Multicall3 batching, retry-classified providers) is directly
  usable — Ponder does not fight the RPC-quirks knowledge already gained;
  it's a home for it. A custom `transport` can wrap the exact retry/backoff
  behavior `pons-launcher`'s `RetryJsonRpcProvider` encodes
  (`backend/src/evm/provider.js:64-106`), and Ponder's own log-fetching
  respects configurable block ranges, so the 10k-block `eth_getLogs` ceiling
  observed against this chain's public RPC (§3) can be set directly as
  config rather than hand-coded as a splitting recursion.
- Multi-contract, multi-event support out of the box maps directly onto this
  project's actual shape: watch two factories (v1, v2) for `TokenLaunched`,
  dynamically register a new contract per emitted pool/curve (Ponder
  supports factory-pattern dynamic contract registration natively — this is
  precisely "register each emitted pool" from the docs' own guidance in §1),
  and separately watch the v4 `PoolManager` singleton for graduated tokens'
  swaps, filtering by `poolId` in the indexing function.
- Schema is defined once (Ponder's schema file), and both the GraphQL API
  and any custom REST endpoints (Ponder supports adding custom API routes
  alongside the generated GraphQL) can be built from it — this covers §5's
  API surface without a hand-built query layer.
- **Costs of this option**: it is an added framework dependency and a
  specific mental model (indexing functions, not free-form scripts) to
  learn; if the v2 curve's/graduation's exact event ABIs (§2.4 open
  questions) turn out to need unusual decoding, that logic still has to be
  written by hand regardless of framework — Ponder doesn't remove the need
  to reverse-engineer the verified contracts, it only removes the need to
  reverse-engineer a sync engine.
- **Verdict: recommended.** It directly targets "no subgraph, single EVM
  chain, need reorg-safe indexing + a query API," is actively maintained,
  and every RPC-behavior lesson `pons-launcher` already paid for carries over
  cleanly since the substrate is the same (viem/JSON-RPC), rather than being
  locked behind a different framework's abstractions (TheGraph/AssemblyScript)
  or having to be re-earned from zero (hand-rolled).

### Comparison table

| | TheGraph subgraph | Hand-rolled Node+viem | **Ponder.sh** |
|---|---|---|---|
| Chain already supported / subgraphs to fork | No | N/A | N/A (works on any EVM RPC) |
| Reorg handling | Built-in | Must build | Built-in |
| Backfill + checkpointing | Built-in | Must build | Built-in |
| Query API | GraphQL (hosted/self-hosted) | Must build | GraphQL + SQL-over-HTTP built-in, custom routes supported |
| Dynamic "register pool on factory event" | Supported (`templates`) but AssemblyScript | Must build | Supported natively, in TypeScript |
| Reuses pons-launcher's viem/RPC-quirk knowledge | No (different runtime) | Yes | Yes (viem-based) |
| New infra to operate | graph-node + IPFS (self-host) or 3rd-party hosting | Postgres + your process | Postgres + your process |
| Fit for "no subgraph exists, single custom chain" | Poor | OK | **Best** |

---

## 7. Operational lessons to carry over from `pons-launcher`

These are not indexer-specific in origin but every one of them applies
directly to indexer reliability and should be treated as requirements, not
suggestions:

1. **Chunk `eth_getLogs`, assume ~10,000 blocks is the safe ceiling against
   the public RPC, and split-and-retry on refusal** rather than trusting a
   larger window — this was found in production, not in docs
   (`backend/src/evm/v2/holdings.js:96-116, 216-239`).
2. **Prefer sequential or Multicall3-batched reads over many concurrent RPC
   calls** against this specific chain's public endpoint — concurrency was
   measured to be *slower*, not faster (`backend/src/evm/v2/holdings.js:76-81,
   246-266`).
3. **Classify and retry transient RPC errors** (`-32601`, `-32603`, `-32005`,
   `-32000`, and text like "rate limit"/"timeout"/"busy") — the public
   endpoint intermittently misbehaves on perfectly valid calls
   (`backend/src/evm/provider.js:29-40`).
4. **Do not assume batched JSON-RPC works** against this chain's public
   nodes; test it explicitly (`backend/src/evm/provider.js:108-113`).
5. **Reason about time/duration in the chain's own `block.number` semantics,
   not the RPC's wall-clock block height** — they diverge by roughly 160x on
   this Arbitrum-Orbit chain (`backend/src/evm/blocknumber.js:1-33`).
6. **Never trust a token's self-reported getters for provenance** (a
   launched token's own `deployer()`/`liquidityPool()`) — always resolve
   provenance and pool addresses through the factory/dex-factory's own
   records (`backend/src/evm/factory.js:90-96`, `pricing.js:40-58`). The same
   principle applies to indexing: derive pool identity from `TokenLaunched` +
   the dex factory's `getPool`, not from anything the token contract claims
   about itself.
7. **Treat docs.ponsfamily.com as a hypothesis generator, never a source of
   truth**, for both addresses and architecture (§2.1) — verify everything
   against verified source / observed events before indexing against it.

---

## 8. What `pons-launcher` already does, and does not do

For scoping clarity: `pons-launcher` is an **operator-facing launch/bundle/
sell console**, not a public explore/trade product, and it has **no
persistent indexer** today. What it has instead:

- A **bounded, best-effort, non-authoritative log scan**
  (`launchedByDeployer` in `backend/src/evm/v2/holdings.js:277-367`) used only
  as a last-resort fallback to find a specific dev wallet's own launches when
  its local history file has nothing — capped at 20 windows of 10k blocks
  (200k blocks, "recent launches only") and a 10-second budget, explicitly
  documented as truncating with a warning rather than ever promising
  completeness (`holdings.js:92-116, 205-214`). This is not a starting point
  for a real indexer; it is a cautionary tale about what happens without one
  (`backend/src/routes/wallets.js:403`: "the alternative, enumerating
  TokenLaunched over 28.7M blocks, is what hung [production]").
- A **local JSON history file per user** (`data/launches.<user>.json`,
  referenced throughout `holdings.js`'s comments) as the actual primary
  source for "what did I launch" — i.e., the existing system's source of
  truth for a user's own launches is *self-reported local state*, not an
  index, precisely because no index exists.
- **Live `balanceOf`/reserve reads on demand** (via Multicall3) for
  everything the console needs right now (`holdings.js:452-506` for token
  metadata/balances, `curve.js:41-71` for curve state) — there is no stored
  price history, no OHLCV, and no trade log anywhere in this codebase, which
  is exactly the gap this new indexer needs to fill for a trading-frontend
  product.

This confirms the new launchpad's indexer is genuinely new work, not a
refactor of something `pons-launcher` already has — but every hard-won
RPC/chain lesson above transfers directly and should not be re-learned.

---

## Sources

- Local repo, `pons-launcher` (paths relative to `d:\projects\pons-launcher`):
  `backend/src/config.js`, `backend/src/evm/abi.js`, `backend/src/evm/factory.js`,
  `backend/src/evm/pricing.js`, `backend/src/evm/blocknumber.js`,
  `backend/src/evm/provider.js`, `backend/src/evm/erc20.js`,
  `backend/src/evm/v2/abi.js`, `backend/src/evm/v2/factory.js`,
  `backend/src/evm/v2/curve.js`, `backend/src/evm/v2/holdings.js`,
  `backend/src/routes/wallets.js`.
- docs.ponsfamily.com (fetched 2026-08-22 via WebFetch; treat with the
  caveats in §2.1).
- Ponder: https://ponder.sh/ , https://ponder.sh/docs/get-started ,
  https://github.com/ponder-sh/ponder
- Uniswap v4 core (PoolManager singleton, `Swap`/`Initialize` events):
  https://docs.uniswap.org/contracts/v4/concepts/PoolManager ,
  https://github.com/Uniswap/v4-core
- Robinhood Chain (chain id 4663, Arbitrum Orbit, ~0.1s blocks, Blockscout
  explorer): https://robinhoodchain.wiki/ ,
  https://www.blog.blockscout.com/build-on-robinhood-chain-with-the-blockscout-pro-api/ ,
  https://docs.robinhood.com/chain/deploy-smart-contracts
