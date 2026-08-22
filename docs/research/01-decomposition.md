# 01 — Build Decomposition: Independent Sub-Projects, Dependency Order, Rationale

Companion to `00-digest.md`. This turns the research into a build plan: three sub-projects
(**A Contracts**, **B Indexer**, **C Frontend**) plus a small shared package, each independently
buildable and testable, with clean interfaces so they can progress in parallel once the
interface between them is frozen. Scope assumed: **pons v1 shape** (fixed supply, atomic instant
Uniswap V3 listing, short restriction-window anti-snipe) built as our **own** contracts — the
default the digest recommends pending open questions Q1/Q2. v2's bonding curve is treated as a
later track that slots into the same three-part structure.

The monorepo (`50-tech-stack-and-monorepo.md`): `contracts/` (Foundry, outside the JS graph),
`indexer/` (Ponder), `web/` (React/Vite or Next — Q4), `packages/shared/` (ABIs + addresses +
math + types + zod schemas), pnpm workspaces, Biome, path-filtered GitHub Actions.

---

## The dependency spine

```
                 packages/shared  (ABIs · per-chain addresses · pricing math · domain types/zod)
                       ▲                      ▲                         ▲
                       │ (ABIs + addresses)   │ (ABIs + addresses)      │ (API types)
   A. CONTRACTS  ──────┴──────────►  B. INDEXER  ──────────────────────► C. FRONTEND
   Foundry factory/                  Ponder: events→Postgres→API         Explore · Launch · Trade
   token/locker + tests                                                  (also reads chain direct
                                                                          via A's ABIs/addresses)
```

- **A → B** interface: the **event ABIs** A emits (`TokenLaunched`, the V3 pool `Swap`, ERC-20
  `Transfer`) and the **deployed addresses** (factory, per-chain), published into
  `packages/shared`. B indexes exactly those.
- **A → C** interface: the same **ABIs + addresses** — C reads live token/pool state and sends
  launch/swap transactions directly against A's contracts through wagmi/viem.
- **B → C** interface: the **read API schema** (`GET /tokens`, `/tokens/:addr`, `/candles`,
  `/trades`, `/holders`, `/search`) with response types mirrored in `packages/shared` (zod-
  validated at the boundary). C never queries Postgres directly.

Everything crosses through `packages/shared`, so the contracts of A→B, A→C, B→C are **files, not
conversations** — the reason a single lesson from `pons-launcher` (`bundleShare.js`'s CJS/ESM tax)
is fixed structurally here.

---

## Sub-project A — Contracts

**One-line purpose:** the own-built factory that, in one atomic transaction, deploys a fixed-
supply ERC-20, creates and seeds its Uniswap V3 pool, permanently locks the LP position, records
authoritative provenance, and optionally executes the creator's atomic dev buy — with an un-
bypassable short restriction window.

**Pieces:** `LaunchFactory.sol` (atomic launch, fee split, config snapshot-per-token, CREATE2
prediction, `canLaunch` view) · `Token.sol` (fixed supply, **no mint**, transfer-hook wallet/tx
cap keyed on `_isPairPool(from)`) · `Locker.sol` (permanent custody, no withdraw, fee-collect
only) · `interfaces/` for the live Uniswap V3 `UniswapV3Factory` / `NonfungiblePositionManager` /
`SwapRouter02` on chain 4663.

**Interface it publishes (to B and C):** the `TokenLaunched` event signature (our own — we define
it, so no reverse-engineering needed), the standard V3 `Swap` and ERC-20 `Transfer` shapes, the
factory read functions (`getLaunchConfig`/`getDexConfig`/`getLaunchedToken`/`launchFee`/
`predictTokenAddress`/`canLaunch`), and deployed addresses per chain. These land in
`packages/shared/abis/*.ts` (`as const`) and `packages/shared/addresses/{4663,46630}.json`,
generated from `contracts/out/*.json` and `broadcast/.../run-latest.json`.

**Why it builds and tests standalone:** Foundry compiles and tests Solidity with zero dependency
on B or C. Its highest-risk surfaces — fee-split arithmetic, the transfer-hook caps, atomicity,
lock immovability — are exactly what Foundry fuzz/`invariant_` tests target, against **mock**
DEX/position-manager/router contracts, then against a **mainnet fork** using the real live
addresses (§2 of the digest). The security regimen (`60-*.md` §7) *is* A's definition of done and
gates the whole project: unit + every-custom-error coverage; fuzz invariants (supply
conservation, cap-holds-across-every-delivery-path, exemption-cap, lock-unmovable-over-arbitrary-
callers); Slither/Mythril to zero unexplained findings; fork tests; a dry-run/simulate suite;
independent adversarial review → testnet → professional audit → bug bounty → staged/capped
mainnet. A produces value (a verified factory) with no line of B or C written.

---

## Sub-project B — Indexer

**One-line purpose:** watch A's factory + pools, decode launches/trades/transfers into Postgres,
and serve the explore/trade read API no single RPC call can answer.

**Pieces (Ponder):** `ponder.config.ts` (chain 4663, RPC, factory address from `shared`) ·
`ponder.schema.ts` (`tokens`, `pools`, `trades`, `candles`, `holders`, `launch_configs`,
`dex_configs`) · handlers `LaunchFactory.ts` (`TokenLaunched` → register the emitted pool
dynamically), `Pool.ts` (V3 `Swap` → `trades` + incremental `candles`), `Token.ts` (`Transfer` →
`holders`) · the HTTP API layer.

**Interface it consumes (from A):** ABIs + factory address from `packages/shared`. **Interface it
publishes (to C):** the read API — `GET /tokens` (paginated/sortable/filterable; each row carries
price, market cap, 24h vol/change, holders, age, graduation %), `/tokens/:addr`, `/candles`,
`/trades`, `/holders` (+`/count`), `/search`, `/stats` — with response types + zod schemas in
`packages/shared`.

**Why it builds and tests standalone:** Ponder runs against **any** contract on **any** EVM RPC.
Before A is deployed to a real network, B is developed against A's ABIs plus a **local Anvil
deployment** of A (or the existing live pons v1 factory as a shape-compatible stand-in, since our
event shapes mirror it). Its correctness tests are deterministic: feed known launch/swap/transfer
logs, assert the decoded rows, OHLCV buckets, and holder balances. All the RPC-hardening lessons
(§3 of the digest — chunked getLogs, sequential/Multicall3 reads, retry classification, contract-
vs-RPC block number, no batch assumptions) are B's operational test surface and need no C. The
API can be exercised with HTTP contract tests independent of any UI.

---

## Sub-project C — Frontend

**One-line purpose:** the non-custodial dapp — Explore the board, Launch a token, Trade any token
— reading history from B and live state from A, with the visitor's wallet signing every mutation.

**Pieces:** `web/` routes `index` (Explore), `create` (Launch), `token/[address]` (Trade),
`portfolio` · `lib/wagmi.ts` (chain 4663 + connectors) · `lib/indexer.ts` (B's API client) ·
hooks wrapping TanStack Query · chart component (lightweight-charts) · reused conventions from
`pons-launcher/frontend` (LogoField upload, config-driven launch, arm-switch + confirm modal,
toast bus, per-protocol module isolation).

**Interface it consumes:** from **A** — ABIs + addresses (live reads via `slot0`/reserves/
`balanceOf`, and writes: `launchToken`, router `exactInputSingle`); from **B** — the read API
(Explore list, candles, trades, holders, search, portfolio). The hybrid rule is load-bearing:
**quotes and the transaction itself are always direct-from-chain**, so a stale index can never
cause a bad fill; lists/history come from B.

**Why it builds and tests standalone:** C mocks both interfaces. Against a **mocked B API** (fixed
JSON fixtures) every Explore/Trade/portfolio view renders and is component-tested with no live
indexer. Against a **local Anvil deployment of A** (or a wallet on testnet), the Launch and Swap
flows are exercised end-to-end with no production dependency. The framework choice (Q4) and the
curve-vs-pool page branch are internal to C. C is where the most parallelism is available once
B's API schema is frozen in `packages/shared`.

---

## Recommended build order — and what to design & build FIRST

**Design first, in this order; build A → (B ∥ C) with the shared package threaded throughout.**

**Build A (Contracts) first.** Reasons:

1. **A is the only true blocker.** Both B and C encode A's event ABIs and addresses. Guess those
   wrong and B indexes the wrong logs and C signs the wrong calldata. Freezing A's event/ABI
   surface early is the highest-leverage risk reduction in the project — it is the interface
   everything else is written against.
2. **A carries all the irreversible risk.** `60-*.md` is explicit that security *gates the build
   order*: contracts are a fund custodian whose launches can't be un-launched, and the test/audit
   regimen is long-lead. Starting A first is the only way its audit/testnet/bounty timeline
   finishes before a mainnet date rather than after it.
3. **A's interface is small and stable; B's and C's are larger and derived from it.** Design the
   factory's structs and `TokenLaunched` event, publish them to `packages/shared`, and B and C can
   then proceed in **parallel** against a frozen contract — even before A is fully audited, because
   the *shape* stabilizes long before the *deployment* does.
4. **The digest's open questions that most change the build (Q1 scope, Q2 own-vs-integrate, Q3 fee
   tier/split, Q5/Q6 anti-snipe) all resolve inside A.** They must be answered to write A anyway,
   and answering them unblocks B's schema and C's forms as a side effect.

**Do in parallel with A's later (audit) phase:** `packages/shared` scaffolding (day one — it is
the interface medium), then **B and C together** once A's ABIs are frozen — B against a local
Anvil deploy of A, C against mocked B fixtures + local Anvil A. Neither B nor C needs A's audit to
be *complete*; both need A's *interface* to be *frozen*. This lets the long pole (A's security
regimen) run its clock while B and C are built and tested against A's stable shape, so mainnet-
readiness of all three converges rather than serializing.

**Sequenced summary:** `packages/shared` skeleton → **A designed & written with the security
constraints as first-class** → freeze A's ABIs/events into `shared` → **B and C in parallel** →
A's testnet/audit/bounty regimen (B and C harden against testnet A meanwhile) → staged, capped,
alerted mainnet rollout of all three.

**First concrete task:** resolve Q1/Q2/Q3/Q5/Q6 with the human, scaffold `packages/shared` and
`contracts/` (Foundry), and write `Token.sol` + `LaunchFactory.sol` with their fuzz/invariant test
suites — because the factory's event and struct surface is the interface the entire rest of the
build is typed against, and its correctness is the thing that, if wrong, cannot be fixed after the
fact.
