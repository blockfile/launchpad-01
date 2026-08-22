# Sub-project C — Frontend (pons v1 launchpad clone)

**Status:** approved design, 2026-08-22
**Repo:** launchpad-01 · **Chain:** Robinhood Chain (id 4663; testnet 46630)
**Depends on research:** [docs/research/00-digest.md](../../research/00-digest.md) §4 (frontend) + §1 (on-chain) + §2 (chain infra); [docs/research/30-frontend-architecture.md](../../research/30-frontend-architecture.md); [docs/research/01-decomposition.md](../../research/01-decomposition.md) (sub-project C's interface); [docs/research/50-tech-stack-and-monorepo.md](../../research/50-tech-stack-and-monorepo.md) §4
**Depends on (frozen, merged):** Sub-project A — [2026-08-22-contracts-design.md](2026-08-22-contracts-design.md), `packages/shared/{abis,addresses}`
**Depends on (in progress, parallel):** Sub-project B — indexer read API. Not frozen yet; this spec defines a **provisional** client + schema C owns until B publishes its own (see §7).

## Goal

The non-custodial dapp: Explore the board, Launch a token, Trade any token, view a
Portfolio. The visitor's own wallet signs every launch and every swap — this is a
public trading site, the structural opposite of `pons-launcher` (a private operator
console where a server-held key signs behind an `x-api-key` gate). C reads live
token/pool state and sends transactions directly against A's contracts; it reads
lists, history, and aggregates from B.

## Scope & non-goals

**In scope:**
- Four routes: `/` Explore, `/create` Launch, `/token/:address` Trade, `/portfolio`.
- The full stack in §3, wired to chain 4663 and to `packages/shared`.
- A typed client + zod schemas for B's read API, developed against fixed JSON
  fixtures (§7, §8) since B is not guaranteed to be running.
- The IPFS logo-pinning proxy (a tiny server-side route, §6).
- A vitest + `@testing-library/react` component-test harness (this repo has none yet
  — C establishes it) and a local-Anvil write-flow test mode for Launch/Swap (§8).

**Out of scope (this spec):**
- **SSR / per-token OG images.** `50-tech-stack-and-monorepo.md` §4 and this spec both
  land on a Vite SPA precisely because every dynamic value on every page comes from
  B's API or a live chain read, never from a server-rendered page. Documented as a
  **future enhancement** (a small dedicated edge function for image generation only,
  revisited if per-token social-preview cards become a real requirement) — not a
  gap in this build.
- **v2 bonding-curve trading UI, graduated Uniswap V4 pools.** Sub-project A is v1
  only (`2026-08-22-contracts-design.md`, "Out (later track): the v2 bonding-curve
  model"). There is no curve, no graduation event, no v4 pool anywhere in this
  system yet — a curve-vs-pool branch would be speculative code against contracts
  that don't exist. If v2 is scoped in later, the branch-at-the-page-level pattern
  documented in `30-frontend-architecture.md` §3/§6.3 is the intended seam.
- **Creator-adjustable fee split, "holder fee-sharing" toggle, snipe-tax exemption
  list.** These appear in pons's own richer create form (`30-frontend-architecture.md`
  §1) but have **no counterpart in A's frozen ABI** — `TokenParams` carries only
  `name/symbol/logo/description/socials/feeWallet`; the 70/30 creator/protocol split
  is fixed and snapshotted by `Locker`, not chosen per-launch; there is no exemption
  list in a v1 launch. The Launch form renders exactly what `TokenParams` +
  `launchConfigId`/`dexId`/`salt` need, nothing pons's site has that ours can't back
  with a real call.
- **Limit orders / order book UI**, multi-quote-asset pairing (A is WETH-only),
  protocol filter / graduation-progress bar on Explore (every token launched by A is
  v1-shaped; there is nothing to filter between).
- B's own implementation (indexer internals, schema authority) — out of scope for
  this document; C only defines what it needs from B and how it survives B's
  absence.

## 1. Trust model

A **non-custodial wallet-signing dapp**. Every mutating action — `launchToken`,
`approve`, `exactInputSingle` — is a transaction the visitor's own connected wallet
signs and broadcasts; C's own code never holds a key and never proxies a signed
transaction through a server. Contrast, explicitly, with `pons-launcher/frontend`:
that app's `api.js` (`x-api-key`-gated `fetch`, server-held keystore) is the right
shape for an *operator* tool and the wrong shape for this site. What transfers from
that repo is **UI convention only** — the IPFS-upload flow, the config-echo pattern,
the two-step arm-switch + confirm-modal, the named-`busy` state, the global toast
bus (§4 of `30-frontend-architecture.md`) — never its money-moving plumbing.

Because Robinhood Chain is sequencer-ordered with no public mempool
(`00-digest.md` §2), there is no mempool-frontrunning surface for C to defend
against client-side; the anti-snipe cap is entirely `Token._update`'s job (already
built, already tested in A). C's only trust-relevant responsibilities are: (a) never
computing a zero `minAmountOut` for a real trade (the atomic dev-buy's `0` is A's
reviewed exception, not a pattern to imitate here), (b) never leaving a standing
ERC-20 allowance, and (c) always deriving "is this one of ours" from
`getLaunchedToken(...).exists`, never from a token's self-reported claims.

## 2. Pages & flows

Each page states what it reads from **chain** (direct viem/wagmi, always current),
what it reads from **B** (history/aggregates, may lag), and what it **writes**.

### 2.1 `/` — Explore

- **Reads (B):** `GET /tokens` — paginated, sortable (newest / market cap / 24h
  volume / 24h change), each row: logo, name, symbol, price, market cap, 24h
  volume, 24h change %, holders, age. `GET /search?q=` for the `⌘K`-style lookup.
- **Reads (chain):** none — a list of "every token that ever launched" is exactly
  the query no single RPC call answers; this page is 100% B.
- **Writes:** none. Row click → `/token/:address`.

### 2.2 `/create` — Launch

- **Reads (chain):** `factory.launchFee()`, `factory.getLaunchConfig(id)` /
  `factory.getDexConfig(id)` for the config picker's echoed rules (max wallet %, max
  tx %, restriction blocks, pool fee, pair token), `factory.predictTokenAddress(
  params, launchConfigId, dexId, salt, deployer)` recomputed on every relevant
  keystroke (name/symbol/logo/description/socials/feeWallet all feed the CREATE2
  preimage — the digest's "logo cannot be empty, baked in forever" applies to every
  field here, not just the logo), `factory.canLaunch(address)` as the single launch
  gate.
- **Reads (B):** `GET /launch-configs` — the enabled `launchConfigId`s and enabled
  `dexId`s that have ever been set, as two independent id lists (`{launchConfigIds,
  dexIds}`), derived from A's `LaunchConfigSet`/`DexConfigSet` events. **"Which ids
  exist" is a history question B answers; "what does id 0 enforce right now" is
  always the live chain read above** — the config picker's option list comes from B,
  but every value it displays and every value submitted is re-read live, never
  cached from B. The factory has no on-chain config-enumeration function, so if B is
  unreachable the picker degrades to a small fixed probe range (§7, §9).
- **Writes:** `factory.launchToken(params, launchConfigId, dexId, salt) payable`,
  `value = launchFee + devBuyEth` exactly (`FeeMath.splitValue`'s own contract-side
  invariant — a mismatched value reverts). Logo upload happens first (via the IPFS
  pin proxy, §6), its returned URI feeds `params.logo` before any predicted-address
  read fires. Arm-switch + confirm-modal freezes the exact request body the moment
  the dialog opens (ported convention, §1); on receipt, decode the `TokenLaunched`
  event log and use its `token` field for the redirect to `/token/:token` — **not**
  the predicted address blindly trusted, even though they must match (the digest's
  own caution: CREATE2 prediction is cross-checked against the real deploy, not
  assumed).

### 2.3 `/token/:address` — Trade

- **Reads (chain, always-current — this is the hybrid rule's core case):**
  `factory.getLaunchedToken(address)` (authoritative provenance — `exists` gates
  everything else on this page; a token failing this check is refused, never
  trusted on its own `name()`/`symbol()`), `factory.getDexConfig(dexId)` (the real
  V3 factory/positionManager/swapRouter addresses for this token's venue — **never
  hardcoded**, per the digest's "custom V3 deployment" warning),
  `IUniswapV3Factory(dexConfig.factory).getPool(token, pairedToken, poolFee)` (pool
  address is **derived**, not stored in `LaunchedToken` — see §5), `pool.slot0()`
  (current `sqrtPriceX96` → spot price, polled/refetched on an interval and
  refetched again immediately before every quote), `token.balanceOf(connectedWallet)`
  and `token.allowance(connectedWallet, swapRouter)`, `token.pairPool()` /
  `token.launchBlock()` / `token.restrictionsEndBlock()` (restriction-window status
  — surfaced plainly per the digest's "don't let a trade silently return less than
  the quote implied").
- **Reads (B):** `GET /tokens/:addr` (description, socials, supply, deployer — the
  slower-changing half of the info panel), `GET /tokens/:addr/candles?interval=`
  (chart history), `GET /tokens/:addr/trades?cursor=` (recent trades), `GET
  /tokens/:addr/holders` (+`/count`).
- **Writes:** ERC-20 `approve(swapRouter, exactAmount)` only when a sell's current
  allowance is insufficient (never a standing/infinite approval); then
  `SwapRouter02.exactInputSingle(...)` (buy: `recipient = connected wallet`) or
  `SwapRouter02.multicall([exactInputSingle(...), unwrapWETH9(0, connected wallet)])`
  (sell: `recipient` inside the swap params is the **router's own address**, a
  literal, never `address(0)` — passing `address(0)` reverts `"TF"` on this exact
  deployment, verified in `pons-launcher/backend/src/evm/router.js`). Every write's
  `amountOutMinimum` is **real and non-zero**, derived from a `slot0()` read taken
  immediately before the write (§5). No on-chain Quoter exists on this chain
  (confirmed, `00-digest.md` §2) — the quote is computed from `slot0()` directly.

### 2.4 `/portfolio`

- **Reads (B):** `GET /wallets/:address/holdings` — every token this launchpad has
  indexed that the connected wallet holds a nonzero balance of (derived from ERC-20
  `Transfer` events, per `30-frontend-architecture.md` §6.4), cursor-paginated like
  every other B list endpoint; each item includes a `valueEth` mark computed from
  the token's own last traded price (nullable pre-first-trade). Specified in B's
  spec/plan as of the 2026-08-22 reconciliation pass (§7).
- **Reads (chain):** a manual "add token by address" fallback reads `balanceOf`
  directly for any single token/wallet pair B hasn't indexed yet or doesn't cover —
  cheap, single-token, always-fresh, and exactly the kind of read the hybrid rule
  reserves for direct chain access rather than waiting on an index.
- **Writes:** none — a read-only page. Links out to each held token's `/token/:address`.

## 3. Stack (locked)

| Layer | Choice | Note |
|---|---|---|
| Framework | **React + Vite**, TypeScript | SPA; every dynamic value is B or chain, never a server-owned datastore Next.js's SSR would help with. |
| Chain layer | **viem** | Typed, tree-shakeable; already what A's own tests and `pons-launcher` use. |
| React chain hooks | **wagmi v2** + **TanStack Query v5** | `useReadContract`/`useReadContracts` (multicall), `useWriteContract` + `useWaitForTransactionReceipt`. **Do not upgrade to wagmi v3** without re-checking RainbowKit compatibility first — RainbowKit's current stable release peer-depends on `wagmi ^2.9.0` (verified against the published package manifest), not v3. |
| Wallet connect | **RainbowKit** | One-line "Connect wallet" CTA, matches pons's own site. |
| Charting | **lightweight-charts v5** | **v4→v5 breaking change:** `chart.addSeries(CandlestickSeries, {...})`, not `chart.addCandlestickSeries({...})`. Any v4-era example code must be translated, not copied. |
| Styling | **Tailwind CSS v4** (+ Radix primitives where a modal/dropdown/tabs primitive is needed) | **v4 is a different setup than most v3-era tutorials show**: no `tailwind.config.js`/PostCSS plugin by default — `@tailwindcss/vite` as a Vite plugin, `@import "tailwindcss";` in one CSS entry file. Treat this the same way as the lightweight-charts gotcha: a real, documented "don't reach for the old pattern" note. |
| Forms/validation | **React Hook Form + Zod** (`@hookform/resolvers`) | Validates the Launch form against **live-fetched** factory config (max wallet/tx bps, launch fee), never a hardcoded client-side ceiling. |
| Routing | **react-router** (declarative/SPA mode) | Four routes, no file-based/data-router ceremony needed. |
| IPFS pinning | A pinning provider (Pinata) **behind a tiny server route**, never a browser-embedded key | §6. |
| Testing | **vitest** + **@testing-library/react** + **MSW** (mocks B's HTTP API) | This repo has no frontend test harness yet — C establishes the minimal one. |

Exact package versions are pinned in the implementation plan's Global Constraints
(checked against the published npm registry at design time, not guessed).

## 4. The hybrid data rule (load-bearing)

> The price you are about to pay, and the transaction itself, are **always
> direct-from-chain**. A stale index can never cause a bad fill.

Concretely:
- **Direct chain reads** for: a single token's live state on its own trade page
  (`slot0`, `balanceOf`, `allowance`, restriction-window status); the **quote** step
  (must reflect the current block); the **write** itself (`launchToken`,
  `exactInputSingle`, `approve`). These never go through B, ever, on any page.
- **B's API** for: the Explore table, chart/candle history, recent trades, holders,
  search, portfolio holdings — every one of these is fundamentally a query over
  *historical* event data that no single RPC call answers, and every one of them is
  allowed to be a few seconds stale without consequence.
- The seam is drawn **at the page level, per data point** — a single Trade page
  legitimately reads from both sources in the same render, and that is correct, not
  a smell: the chart is B's, the price you're about to pay is chain's.

## 5. Trade execution specifics (no Quoter on this chain)

There is no `Quoter`/`QuoterV2` deployed at any known address on Robinhood Chain
(`00-digest.md` §2 — the canonical addresses hold unrelated contracts). The quote is
computed directly:

1. Resolve the pool: `getLaunchedToken(token)` → `dexId`, `pairedToken`, `poolFee`,
   `isToken0`. `getDexConfig(dexId)` → the real `factory`/`swapRouter` addresses for
   that venue. `IUniswapV3Factory(dexConfig.factory).getPool(token, pairedToken,
   poolFee)` → pool address. (The pool address is **derived**, not read off
   `LaunchedToken` — that struct doesn't carry it; `TokenLaunched`'s `pool` field is
   an indexer convenience, not something the live trade page depends on.)
2. `pool.slot0()` → `sqrtPriceX96`. Both sides of every pool here are 18-decimal
   (WETH and every A-launched token), so the spot price is pure ratio math, no
   decimal-adjustment term: `priceX192 = sqrtPriceX96 * sqrtPriceX96` represents
   (token1 per token0) at Q192 fixed point. Orient by `isToken0` to get "tokens per
   WETH" or "WETH per token" as the trade direction requires.
3. **This is a spot-price quote, not a curve-integrated one** — there is no
   Quoter to walk ticks with, and reimplementing full V3 swap math (tick-by-tick,
   `@uniswap/v3-sdk`-depth) is out of scope for this build. This is an **accepted
   approximation**, load-bearing enough to state explicitly: the safety net is that
   `amountOutMinimum` is still enforced **on-chain** regardless of how the frontend
   derived its estimate, so an imprecise quote produces a **safely reverted
   transaction**, never a bad fill. Apply the pool's own fee (`poolFee/1e6`, e.g. 1%)
   to the input before the ratio, then apply the user's slippage tolerance
   (default ~1%, adjustable, matching pons's own confirmed UI) to get
   `minAmountOut`. If reverts under normal trade sizes turn out to be common in
   practice, revisit toward a real tick-walking quote — not a day-one requirement.
4. **Buy** (ETH → token): `tokenIn = pairedToken (WETH)`, `value = amountIn` sent as
   native ETH — `SwapRouter02` treats `msg.value` as pre-deposited WETH for a
   WETH-input swap, no separate wrap step. `recipient = connected wallet`.
5. **Sell** (token → ETH): requires `approve` first if allowance is insufficient
   (exact amount, every time — no standing allowance). The swap's `recipient` must
   be the **router's own literal address** (passing `address(0)` reverts `"TF"` on
   this deployment — verified, not theoretical), bundled via the router's own
   `multicall([exactInputSingle(...), unwrapWETH9(minOut, connectedWallet)])` so the
   proceeds land as native ETH in one transaction. This exact two-call shape is
   already validated against the live router in `pons-launcher/backend/src/evm/
   router.js` — C's implementation should match it, not rediscover it.
6. The router has **two `exactInputSingle` shapes** (with/without `deadline`),
   selected by `getDexConfig(dexId).routerRequiresDeadline` (live = `false`
   today) — branch on this flag, don't assume one shape.

## 6. IPFS logo pinning

Never pin from the browser with an embedded provider key. A tiny server-side route
(framework-agnostic Node handler — mountable as Vite dev-server middleware locally
and deployable as whatever serverless/Node target production uses, without changing
the handler itself) accepts the raw file, forwards it to the pinning provider using
a server-only credential, and returns `{ cid, gatewayUrl }`. The browser's
`LogoField` component (ported convention from `pons-launcher/frontend/src/
components/LogoField.jsx`: accept list `image/png|jpeg|webp|gif`, 5 MB ceiling, a
mandatory moderation-acknowledgement checkbox gating the picker, immediate
`URL.createObjectURL` preview, upload-in-flight disables the Launch page's arm
switch, a failed upload clears the value and the thumbnail together) only ever
talks to this one same-origin route, never to the pinning provider directly.

## 7. Consuming `packages/shared` + B's API

**From `packages/shared` (frozen, A's interface):** `launchFactoryAbi`, `tokenAbi`,
`lockerAbi`, plus the addresses map (`addresses[4663]` — `factory`/`locker` are
currently `null`; a real deploy fills them, and until then C's dev/test config
layers a `VITE_FACTORY_ADDRESS`/`VITE_LOCKER_ADDRESS` env override on top, so local
work never depends on a real mainnet deploy existing). **Gap identified during this
design pass:** `packages/shared`'s existing `uniswapV3PoolAbi` and `erc20Abi`
exports are event-only fragments written for **B's indexing needs** (`Swap`,
`Transfer`) — they carry no `slot0`/`token0`/`token1` functions and no
`balanceOf`/`allowance`/`approve`. C additionally needs, and does not yet have:
pool read functions, `IUniswapV3Factory.getPool`, and the `SwapRouter02` write
shapes (`exactInputSingle` ×2, `multicall`, `unwrapWETH9` — the latter two exist in
**no** compiled artifact anywhere in this repo yet, since A's own contracts never
call them). The implementation plan's Task 2 extends `packages/shared`'s generator
to publish these as additive exports — existing exports (what B already consumes)
are untouched. `tokenAbi` is already complete for reading/writing against a
specific launched token (it's the full compiled `Token` ABI, ERC-20 surface
included) — no separate generic ERC-20 ABI is needed for token-side calls.

**From B (reconciled 2026-08-22):** the decomposition doc's target end-state is that
B publishes response types into `packages/shared`, zod-validated at the C boundary.
B is still being built in parallel, so C's client + zod schema
(`web/src/lib/indexer/`) remains **provisional against fixed fixtures** (§8) — but
its *shape* is no longer a guess: a reconciliation pass against
[`2026-08-22-indexer-design.md`](2026-08-22-indexer-design.md)'s API surface table
resolved every field/name/type difference to one agreed contract, and B's own plan
now includes the two endpoints C's pages need that weren't originally documented —
**`GET /launch-configs`** (§2.2) and **`GET /wallets/:address/holdings`** (§2.4) —
both now specified in B's plan Task 9. The agreed contract, in full, per endpoint:

- **Every `bigint`-backed value is a decimal string** on the wire (amounts, prices,
  supply, block numbers/timestamps) — never a JSON number, never a float. Only
  genuinely small integer fields (`holderCount`, `tradeCount`, `logIndex`, `poolFee`,
  bps values) are plain JSON numbers. C's zod schemas (§8, Task 5 of the plan) are
  typed accordingly — including `candlesResponseSchema`'s OHLC/volume fields, which
  are strings on the wire and parsed to numbers only inside `fetchCandles`/
  `PriceChart` for `lightweight-charts`, which needs plain floats.
- **Pagination is uniform:** every list endpoint returns `{ items, nextCursor }`
  with `nextCursor` **always present, explicitly `null` on the last page** — never
  an omitted key. C's zod schemas use `.nullable()` (not `.optional()`) for every
  `nextCursor` for exactly this reason.
- `/tokens` (list) items: `address, name, symbol, logo, price, marketCap,
  volume24h, priceChangeBps24h, holderCount, launchTimestamp` — no `poolAddress`
  (that's detail-only). `marketCap` is a field B's original draft didn't have; added
  during reconciliation because this spec's own §2.1 lists it as a required Explore
  column.
- `/tokens/:addr` (detail) additionally carries `deployer`, `dexId`, `launchConfigId`
  (all already indexed, just not previously surfaced) — but **not** `feeWallet`:
  B's indexer cannot derive it from any event it handles (see B spec's "Known
  limitation, accepted"), and no C page actually reads it back from B, so it was
  dropped from C's `tokenDetailSchema` rather than left as a field B can't fill.
- `/tokens/:addr/holders` items add `pct` (holder's share of supply, 0-100); the
  page response adds `totalHolders` — both cheap additions over data B already has
  on hand, closing a gap in C's original schema.
- `/search` returns `{ items: [...] }` (an object, matching every other list
  endpoint), not a bare array — C's original `searchResultsSchema` was a bare
  `z.array(...)`, which would have thrown on every real B response.
- `/stats` is `{ tokensLaunched, totalVolumeQuote, totalTrades }` — **all-time**
  counters, not a 24h window. C's original schema invented a windowed shape
  (`totalVolume24hEth`, `totalLaunches24h`) with no basis in B's design; corrected
  to match B's actual (and more useful, given B already has `/tokens/:addr/candles`
  for windowed data) all-time counters.
- `/launch-configs` returns `{ launchConfigIds: number[], dexIds: number[] }` — two
  independent id lists (B's `launch_configs`/`dex_configs` tables are independent,
  not pre-paired), not the `{launchConfigId, dexId}[]` pairs C's original draft
  assumed. The config picker (plan Task 7) presents/cross-multiplies them and, per
  this spec's own rule, always re-reads `getLaunchConfig`/`getDexConfig` live for
  the values it displays — this endpoint only answers "which ids exist."
- `/wallets/:address/holdings` returns `{ items: [{tokenAddress, name, symbol, logo,
  balance, valueEth}], nextCursor }` — cursor-paginated like every other list
  endpoint (C's original draft had no pagination on this one), `logo` not `logoUrl`
  (matching B's field name everywhere else), and `valueEth` is nullable (mirrors
  `price`'s nullability: null until the token's first trade).

When B ships past the mocked-fixture stage, the intent is still a one-file swap
(re-point the client's import) — the reconciliation pass is exactly what makes that
swap safe, since C's zod schemas now assert the shape B actually produces rather
than a shape nobody had agreed to yet.

## 8. Testing approach

Two independent, both required, neither blocking the other:

1. **Mocked-B component tests** (vitest + `@testing-library/react` + MSW): every
   Explore/Trade/Portfolio view is rendered against **fixed JSON fixtures**
   (`web/src/lib/indexer/fixtures/*.json`) intercepted at the HTTP layer by MSW, so
   these tests need no live indexer, no live chain, and no wallet. Chain-dependent
   UI (wallet connect state, live `slot0` price, predicted address) is tested by
   mocking wagmi's hooks/connectors (wagmi ships a `mock` connector purpose-built
   for this) rather than requiring a real provider.
2. **Local-Anvil write-flow tests** for the two irreversible actions (Launch,
   Swap): `anvil --fork-url https://rpc.mainnet.chain.robinhood.com` (chain id
   inherited from the fork, 4663) gives a local chain with the **real** live
   Uniswap V3 deployment already at its real addresses; A's existing
   `contracts/script/Deploy.s.sol` (`forge script ... --broadcast --rpc-url
   http://localhost:8545`) deploys `LaunchFactory`/`Locker` on top of that fork
   using an Anvil default account, exactly as A's own fork tests already do. These
   tests call the real contracts with plain viem clients (bypassing React) to
   prove the calldata/value/approval sequence actually succeeds end-to-end; a
   separate, smaller RTL-level test asserts the **React layer** builds that exact
   calldata/value given a mocked `useWriteContract`. `pnpm build` gates every task.

Every task in the implementation plan is independently testable under one of these
two modes — no task ships untested, and no task's tests require both a live B *and*
a live chain simultaneously.

## 9. Open questions / to reconcile once B firms up

- ~~**`GET /launch-configs`** (§2.2) and **`GET /wallets/:address/holdings`**
  (§2.4) are not in B's currently-documented API surface.~~ **Resolved
  2026-08-22:** both are now specified in B's spec (API surface table) and plan
  (Task 9), with the exact response shapes given in §7 above. C still builds
  against fixed fixtures (§8) until B actually ships and runs, but the shape is
  agreed, not provisional.
- **Config-picker degradation:** absent a real B deployment to query, the Launch page's config
  picker has no on-chain enumeration to fall back to (`getLaunchConfig`/
  `getDexConfig` are direct-by-id lookups only) and must probe a small fixed id
  range (e.g. 0–9) via multicall, filtering for `enabled`. Fine today (only id 0 is
  wired by A's `Deploy.s.sol`), but worth resolving properly once B exists.
- **Realtime trades/candles:** `00-digest.md` §3 mentions a WS/SSE push or
  short-poll option for new trades. This spec defaults to TanStack Query short-poll
  (`refetchInterval`, 10–30s) for v1 — a list/chart, not a livestream — and treats a
  push channel as an enhancement, not a launch requirement.
- **Spot-price quote accuracy** (§5): revisit toward a tick-walking quote if
  real-world testnet trading shows meaningful revert rates from slippage
  under-estimation on larger trades.
