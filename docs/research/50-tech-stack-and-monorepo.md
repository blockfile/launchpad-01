# Tech stack and monorepo layout

Research for: recreating the pons launchpad (factory + bonding-curve protocol,
not the sniping/bundling operator tool) from scratch in `d:\projects\launchpad-01`.

This doc recommends the language/framework/tooling choices and the concrete
top-level directory tree, and justifies each choice against (a) the target
chain's own constraints, (b) what the prior `pons-launcher` repo got right and
wrong, and (c) the goal of a codebase AI agents can build in independent,
task-sized pieces.

Scope note: the indexer and frontend sections here make concrete
recommendations so this document is buildable standalone, but they are
necessarily upstream of the dedicated indexer-architecture and
frontend-architecture research docs. Where those docs land on a different
choice for reasons specific to the data model or UX, defer to them and treat
this doc's picks as the default a task-sized agent should reach for absent
other guidance.

## Recommendation at a glance

| Concern | Choice | Alternative considered | Why not the alternative |
|---|---|---|---|
| Contracts framework | **Foundry** (forge/cast/anvil) | Hardhat 3 | Foundry is faster for a Solidity-only test suite, tests are Solidity (no context switch for an agent already writing Solidity), and it's what Robinhood Chain's own deploy docs lead with |
| Indexer | **Ponder** (TypeScript, Postgres, GraphQL+SQL-over-HTTP) | Subgraph (The Graph), custom ethers/viem poller (pons-launcher's own pattern), SQD/Envio | Robinhood Chain has no hosted Graph Network support (would mean self-hosting graph-node); a hand-rolled poller is exactly the JSON-file/manual-reindex pattern this rebuild should retire |
| Frontend | **React + Vite + TypeScript**, wagmi/viem, TanStack Query, Tailwind | Next.js | The launchpad's own data (candidly, everything) comes from the indexer's API, not from a server-rendered page; Vite keeps the deploy a static bundle with no Node runtime to operate, matching the existing team's Vite fluency (pons-launcher's frontend is already Vite+React) |
| Shared code | `packages/shared` (TypeScript), ABIs + addresses + pricing/format math + zod schemas | Duplicate constants in each app | pons-launcher already learned this lesson once (`shared/bundleShare.js`) and paid a CommonJS/ESM interop tax for it that a real workspace package removes |
| Package manager | **pnpm** + pnpm workspaces | npm workspaces (what pons-launcher uses today), Yarn | Content-addressable store, strict-by-default dependency resolution (catches phantom deps early, which matters when a task-sized agent is adding a package to only one workspace), `workspace:*` protocol makes internal-vs-external dependencies visually unambiguous |
| Monorepo orchestration | Plain pnpm workspace scripts (`pnpm -r`, `--filter`) | Turborepo, Nx | Four packages is too small to need a task cache or affected-graph; add Turborepo later if CI time becomes a real cost, not before |
| Lint/format | **Biome** for TS/JS, `forge fmt` + `solhint` for Solidity | ESLint + Prettier | One fast binary, one config file, instead of two tools whose rules can disagree; drop to ESLint only if a needed rule (e.g. a wagmi/React-hooks lint) isn't in Biome's set yet |
| CI | GitHub Actions, one workflow per package + a root workflow gate | Single monolithic workflow | Path-filtered workflows mean a contracts-only PR doesn't wait on a frontend build, and a task-sized agent working in one package gets fast, scoped feedback |

## 1. The chain, because it constrains everything downstream

The target chain is Robinhood Chain — confirmed from `pons-launcher`'s own
config (`backend/src/config.js:26-28`, RPC `https://rpc.mainnet.chain.robinhood.com`,
chain ID `4663`, explorer `robinhoodchain.blockscout.com`) and from the chain's
own docs:

- It's an **Arbitrum Orbit L2** (Nitro client, settling to Ethereum) —
  "fully EVM-compatible... Solidity contracts deploy without modification, and
  ethers.js, viem, web3.py, Hardhat, Foundry, and Remix all work against a
  Robinhood Chain endpoint unchanged." [Chainstack: What is Robinhood Chain?](https://chainstack.com/what-is-robinhood-chain/)
- Mainnet chain ID `4663`, RPC `https://rpc.mainnet.chain.robinhood.com`;
  testnet chain ID `46630`, RPC `https://rpc.testnet.chain.robinhood.com`.
  [Robinhood Chain docs: Connecting](https://docs.robinhood.com/chain/connecting)
- The **official deploy tutorial presents Foundry and Hardhat as equally
  supported**, verification via Blockscout on both (`--verifier blockscout` for
  forge, `npx hardhat verify` for Hardhat), and recommends testnet-first with a
  throwaway deployer key. [Robinhood Chain docs: Deploy smart contracts](https://docs.robinhood.com/chain/deploy-smart-contracts)
- Block explorer is **Blockscout** (`robinhoodchain.blockscout.com`), not
  Etherscan — matters for verification flags and for the indexer's "get
  contract ABI" affordances if that's ever used as a bootstrap path.
- As an Orbit/Arbitrum-family chain it is sequencer-ordered with no public
  mempool in the traditional sense (already noted and relied upon by
  pons-launcher's own launch design — `README.md:31-35`), which is why atomic,
  same-transaction actions (dev buy, bonding-curve exemptions) are the pattern
  the *contracts* should support, not something the frontend/indexer need to
  compensate for.
- **No hosted subgraph indexing** is documented for this chain — no mention of
  The Graph's hosted/decentralized network supporting Robinhood Chain. That
  directly rules out "just deploy a subgraph" as the low-effort indexer path
  (see §3).

Because Foundry, Hardhat, ethers, and viem all work unmodified, nothing here
is chain-forced; the choices below are made on ordinary engineering grounds.

## 2. Contracts: Foundry

**Recommendation: Foundry** (forge for build/test, cast for scripting/calls,
anvil for local fork testing, `forge script` for deploys).

Why, concretely:

- **Tests in Solidity, not JS-wrapped-around-Solidity.** A task-sized agent
  implementing `BondingCurve.sol` writes `BondingCurve.t.sol` in the same
  language, same repo, same mental model — no ABI-to-TS marshaling, no
  `ethers.getContractFactory` ceremony. This matters specifically for an
  agent-built codebase: fewer languages in flight per task means fewer ways for
  a task to go subtly wrong.
- **Built-in fuzzing and invariant testing** (`testFuzz_`, `invariant_`) with no
  extra plugin — valuable for the two highest-risk surfaces in this project:
  the bonding-curve math (pons v2's curve + decaying opening tax) and the
  transfer-hook wallet caps that pons v1's token enforces (`contracts/BundleDistributor.sol:20-30`
  documents the exact hook shape being worked around/against:
  `_isPairPool(from)` gating `maxWalletBps`). Both are exactly the kind of
  "many small numeric edge cases" code fuzzing is for.
- **Native speed.** No JS VM in the test loop; forge is a native binary running
  solc directly. As of 2026 Hardhat 3 closed much of this gap (within ~2x on
  equivalent suites) but Foundry still leads on raw compile+test speed for a
  Solidity-only suite. [Foundry vs Hardhat in 2026 — DEV Community](https://dev.to/pavelespitia/foundry-vs-hardhat-in-2026-which-solidity-toolchain-wins-20jd)
- **The chain's own docs lead with it** and confirm Blockscout verification
  works from `forge verify-contract --verifier blockscout`. [Robinhood Chain docs](https://docs.robinhood.com/chain/deploy-smart-contracts)
- **`forge script` deploy scripts are Solidity too**, and their broadcast
  output (`broadcast/<Script>.s.sol/<chainId>/run-latest.json`) is a
  machine-readable record of what got deployed where — the natural feed into
  `packages/shared/addresses/*.json` (see §5).

When Hardhat would have been the better call: if this project needed heavy
TypeScript-side deploy orchestration (e.g., deploying dozens of parameterized
instances with complex JS logic driving the parameters), or multichain/OP-Stack
simulation features Hardhat 3 added. Neither applies here — the surface is a
handful of contracts (factory, bonding curve, token, possibly a distributor
akin to `contracts/BundleDistributor.sol`) deployed to one or two chains
(mainnet + testnet).

### Contracts layout

```
contracts/
  foundry.toml
  remappings.txt
  .env.example              # DEPLOYER_PRIVATE_KEY, RPC_URL, ETHERSCAN/BLOCKSCOUT verifier URL
  lib/                       # forge install'd deps (forge-std, openzeppelin-contracts) — gitmodules
  src/
    LaunchFactory.sol        # v1-style: deploy + pool + lock, atomic optional dev buy
    BondingCurveFactory.sol  # v2-style: curve deploy, exemption list, graduation trigger
    BondingCurve.sol
    Token.sol                # ERC20 with the transfer-hook wallet-cap logic
    interfaces/
    libraries/
  script/
    Deploy.s.sol
    DeployTestnet.s.sol
  test/
    LaunchFactory.t.sol
    BondingCurve.t.sol
    Token.t.sol
    invariant/
      BondingCurve.invariant.t.sol
  out/                       # gitignored — forge build artifacts (ABI + bytecode)
  broadcast/                 # gitignored except run-latest.json per chain, feeds §5's address pipeline
```

`forge fmt --check` and `solhint` in CI (see §7); `forge coverage` as a
non-blocking CI report initially, promoted to a gate once coverage is
meaningfully high.

## 3. Indexer: Ponder

The launchpad needs to answer questions no single RPC call answers cheaply:
"every token launched, newest first," "this token's trade history," "current
holders and their share," "which curves have graduated." That's classic
event-indexing territory — read `LaunchFactory`/`BondingCurve` events, build a
queryable read model, serve it fast.

**Recommendation: Ponder** (`ponder-sh/ponder`), TypeScript, Postgres-backed,
served over GraphQL and SQL-over-HTTP.

Why, against the concrete alternatives:

- **Subgraph (The Graph).** Ruled out primarily because there's no evidence of
  hosted Graph Network support for Robinhood Chain — running a subgraph would
  mean self-hosting `graph-node`, which is a heavier, less agent-buildable
  operational surface (a whole indexing-node stack + IPFS + Postgres for
  subgraph manifests) than a single Node/Bun process. AssemblyScript mapping
  handlers are also a second, unusual language for the same team that just
  wrote the Solidity being indexed.
- **A hand-rolled poller** (ethers/viem `getLogs` + a JSON file or SQLite),
  which is exactly `pons-launcher`'s own pattern (`backend/src/evm/v2/holdings.js`,
  `backend/src/store/history.js` — flat JSON files, load-mutate-rewrite,
  manual reindex scripts like `backend/scripts/v2-watch.js`). That pattern was
  fine for a single-operator tool tracking its own launches, but this rebuild
  is a public-facing launchpad that needs concurrent reads, pagination, and
  aggregation (holder counts, volume-over-time) — the exact work a real
  indexing framework exists to not reinvent per project.
- **SQD (Subsquid) / Envio HyperIndex** — both legitimate, both chain-agnostic
  via RPC like Ponder. Ponder is the pragmatic default here specifically
  because: it's the smallest conceptual surface for a single-app indexer (one
  `ponder.config.ts`, one `ponder.schema.ts`, handler files per contract),
  targets exactly this "index any contract on any EVM chain via RPC, write to
  Postgres, query over GraphQL or SQL" shape out of the box, and its local dev
  server gives fast-refresh iteration that suits an agent iterating on
  indexing logic one contract at a time. [Ponder docs](https://ponder.sh/docs/get-started),
  [ponder-sh/ponder](https://github.com/ponder-sh/ponder)

### What the indexer schema needs to cover (informs `ponder.schema.ts`)

Derived from what the contracts and the old operator tool already show is the
domain model:

- **Launches** — token address (CREATE2-predicted, per `contracts/BundleDistributor.sol:195-199`'s
  documented predictability), launcher/deployer, launch config id, dex id,
  socials, timestamp/block, initial buy size.
- **Curve state** (v2-style bonding curve) — reserve, supply sold, raised ETH,
  opening-tax decay window, exemption list used at launch, graduation
  threshold and graduated-at.
- **Trades** — buy/sell events, wallet, amount in/out, price, tax applied (if
  in the opening window).
- **Graduations** — curve → DEX pool transition, pool address, liquidity
  locked.
- **Holders** (derived/materialized, not a raw event) — current balance per
  token per wallet, computed from Transfer events; Ponder's Postgres store is
  the right place to maintain this incrementally rather than recomputing per
  request.

This list is a starting point for the indexer-architecture doc, not a
substitute for it — final table shapes should follow from the actual finalized
contract events.

### Indexer layout

```
indexer/
  ponder.config.ts          # chain(s), RPC URL(s), contract addresses (from packages/shared)
  ponder.schema.ts           # tables: launches, curves, trades, graduations, holders
  src/
    LaunchFactory.ts         # event handlers
    BondingCurve.ts
    Token.ts                 # Transfer handler → holders table
  abis/                      # generated, see §5 — or imported directly from packages/shared
  .env.example                # RPC_URL, DATABASE_URL
  package.json
```

## 4. Frontend: React + Vite + TypeScript

**Recommendation:** React 18/19 + Vite + TypeScript, wagmi + viem for wallet/
contract interaction, TanStack Query for data fetching (indexer GraphQL/SQL +
any direct RPC reads), Tailwind for styling.

Why Vite over Next.js for this project specifically:

- The launchpad's dynamic content (token list, curve state, trades, holder
  counts) all comes from the **indexer's API**, not from data a Next.js server
  component would fetch at request time from a database it owns. There's no
  first-party server-side data source that benefits from SSR here — the
  indexer already is that server.
- A Vite SPA builds to static files and needs no Node runtime in production —
  one artifact to host (a CDN/static host), matching the operational
  simplicity this project should default to. Next.js's SSR/edge/ISR machinery
  is real capability this project doesn't have a concrete requirement for yet
  (no proof of a need for server-rendered OG-image-per-token pages, though
  that's worth flagging to the frontend-research doc as a possible future
  want — if per-token social-preview cards become a requirement, that is the
  moment to revisit Next.js or a small dedicated OG-image edge function, not
  before).
- **Matches the existing team's demonstrated fluency**: `pons-launcher`'s
  frontend is already React 19 + Vite (`frontend/package.json:7-9,23-24`),
  including the native-binary-pinning trick for rolldown/lightningcss
  (`frontend/package.json:25-30`, explained in `README.md:75-79`) — that's an
  operational wrinkle worth carrying forward knowingly (pin both platforms'
  optional native deps) rather than rediscovering.
- TypeScript (not plain JS, unlike the old frontend) because this project's
  frontend now depends on a real ABI/address contract surface
  (`packages/shared`) — wagmi + viem's whole value proposition is
  ABI-inferred types (`as const` ABIs → typed read/write hooks), which plain
  JS forfeits for no offsetting benefit in a from-scratch build.

### Frontend layout

```
web/
  index.html
  vite.config.ts
  tsconfig.json
  src/
    main.tsx
    routes/                  # or pages/ if using a file-based router
      index.tsx              # token list / discover
      token/[address].tsx    # token detail: curve chart, trades, buy/sell
      launch/index.tsx        # launch form
    components/
    hooks/                    # useToken, useCurve, useTrades (wrap TanStack Query + indexer client)
    lib/
      wagmi.ts                 # chain + connector config (Robinhood Chain 4663)
      indexer.ts                # GraphQL/SQL client against indexer/
    styles/
  package.json
```

## 5. Shared packages: `packages/shared`

The one lesson `pons-launcher` already paid to learn: **the same arithmetic
must not exist in two places that can drift.** `shared/bundleShare.js`
(`shared/bundleShare.js:1-16`) exists specifically because the console prices a
bundle buy live while typing and preflight prices it again before signing, and
those two answers must match. The cost of doing it as a plain CommonJS file
shared between an Express backend and a Vite frontend was a hand-written Vite
plugin (`frontend/vite.config.js:14-27`) that wraps CommonJS as ESM at dev-time
only, because rolldown handles it differently at build-time — two code paths
for one file, and a comment thread's worth of "nothing in here may import
anything" discipline to keep it browser-safe.

A real pnpm workspace package removes that tax entirely: `packages/shared` is
built once (tsup/tsc to ESM+CJS or ESM-only, whichever `web`/`indexer` need),
consumed via `workspace:*`, and both consumers get real types.

**What lives in `packages/shared`:**

- **ABIs** — generated from `contracts/out/*.json` (forge build artifacts
  already contain the ABI) via a small script (`scripts/sync-abis.ts`) that
  extracts just the ABI array into a TS file per contract, exported `as const`
  for viem/wagmi type inference. Run manually or in CI after a contracts
  change; committed, not generated at consumer build time, so `web` and
  `indexer` never need `contracts/` present to build.
- **Addresses** — per-chain-id JSON (`addresses/4663.json`, `addresses/46630.json`)
  populated from `contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json`
  after a real deploy — same sync script, or a manual update for now given
  deploys are infrequent and deliberate.
- **Types** — TS types for the domain model (Launch, Curve, Trade,
  Graduation) shared between what the indexer returns and what the frontend
  expects, plus zod schemas at the boundary if the indexer's HTTP API needs
  runtime validation on the frontend side.
- **Pricing/format math** — the actual successor to `bundleShare.js`: curve
  math (buy/sell quote given reserve + supply), formatting helpers
  (`frontend/src/format.js` in the old repo is the direct analog). Pure
  functions, no side effects, so they're trivially unit-testable and safe to
  run in both a Node indexer/build step and a browser bundle — no CommonJS
  trick required because the package is authored as a normal ESM TS package
  from the start.

```
packages/shared/
  package.json               # name: "@launchpad/shared"
  tsconfig.json
  src/
    abis/
      LaunchFactory.ts
      BondingCurve.ts
      Token.ts
    addresses/
      4663.json
      46630.json
    types/
      launch.ts
      curve.ts
      trade.ts
    math/
      curve.ts               # buy/sell quote math — the bundleShare.js successor
      format.ts
    index.ts
  scripts/
    sync-abis.ts             # contracts/out/*.json → src/abis/*.ts
```

## 6. Package manager and workspaces: pnpm

**Recommendation: pnpm** with `pnpm-workspace.yaml`, over npm workspaces
(what `pons-launcher` uses today, `package.json:6-9`) or Yarn.

- Content-addressable store: one copy of a dependency version on disk no
  matter how many workspace packages use it — meaningfully smaller
  `node_modules` across `web`/`indexer`/`packages/shared` sharing things like
  `viem`, `typescript`, `vitest`.
- Strict-by-default resolution surfaces phantom dependencies (a package using
  something it never declared, only present because a sibling hoisted it) at
  install time rather than as a mystery break later — valuable specifically
  because a task-sized agent adding a dependency to one workspace should not
  be able to accidentally rely on something another workspace happened to
  hoist.
- `workspace:*` in a `dependencies` field is an unambiguous, greppable marker
  that a dependency is internal to this repo, distinct from a version range
  pointing at the npm registry — useful when an agent is scanning
  `package.json` files to understand what depends on what.
- 2026 tooling surveys converge on pnpm workspaces as the default monorepo
  package manager, Turborepo as the default *orchestrator* layered on top once
  a repo is large enough to need build caching. [Monorepo 2026 — AnhTu.dev](https://anhtu.dev/monorepo-2026-turborepo-nx-pnpm-workspaces-large-teams-1124)

Given this project starts with exactly four workspaces (`contracts` is
Foundry-native and not part of the JS workspace graph at all; `indexer`,
`web`, `packages/shared` are), **skip Turborepo/Nx at the start.** Plain
`pnpm -r` / `pnpm --filter <pkg>` scripts are enough, and one less tool is one
less thing an agent has to understand the config of before it can run a
build. Revisit if CI time or cross-package task orchestration becomes an
actual measured pain point.

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "indexer"
  - "web"
```

Root `package.json`:

```json
{
  "name": "launchpad-01",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm --filter web dev",
    "dev:indexer": "pnpm --filter indexer dev",
    "test": "pnpm -r test",
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "pnpm -r typecheck"
  }
}
```

(Contracts are built/tested via `forge build` / `forge test` inside
`contracts/`, invoked directly or from a thin root script — Foundry has its
own toolchain and isn't part of the pnpm dependency graph.)

## 7. CI

GitHub Actions, one workflow per top-level concern, each path-filtered so an
agent's task-sized PR only waits on relevant checks:

```
.github/workflows/
  contracts.yml    # on: paths: contracts/**  → forge fmt --check, forge test -vvv, forge coverage (report)
  indexer.yml      # on: paths: indexer/**, packages/shared/** → pnpm --filter indexer build/test/typecheck
  web.yml          # on: paths: web/**, packages/shared/** → pnpm --filter web build/test/typecheck
  shared.yml       # on: paths: packages/shared/** → pnpm --filter @launchpad/shared build/test
  ci.yml           # on: pull_request (no path filter) → biome check ., a lightweight "did anything break the workspace graph" pnpm install + pnpm -r build gate
```

`contracts.yml` example shape:

```yaml
name: contracts
on:
  pull_request:
    paths: ["contracts/**"]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: foundry-rs/foundry-toolchain@v1
      - run: forge fmt --check
        working-directory: contracts
      - run: forge test -vvv
        working-directory: contracts
```

Deploys are **not** part of CI initially — `forge script ... --broadcast` is a
deliberate, human-triggered action (echoing `pons-launcher`'s own stance that
"nothing is broadcast without `--broadcast`," `backend/scripts/deploy-contract.js:16-19`).
Automating deploys is a later step once there's a real release process to
automate, not a day-one CI job.

## 8. Full top-level directory tree

```
launchpad-01/
├── contracts/                     # Foundry project (§2)
│   ├── foundry.toml
│   ├── remappings.txt
│   ├── lib/                       # forge-std, openzeppelin-contracts (submodules)
│   ├── src/
│   │   ├── LaunchFactory.sol
│   │   ├── BondingCurveFactory.sol
│   │   ├── BondingCurve.sol
│   │   ├── Token.sol
│   │   ├── interfaces/
│   │   └── libraries/
│   ├── script/
│   │   ├── Deploy.s.sol
│   │   └── DeployTestnet.s.sol
│   ├── test/
│   │   ├── LaunchFactory.t.sol
│   │   ├── BondingCurve.t.sol
│   │   ├── Token.t.sol
│   │   └── invariant/
│   ├── out/                       # gitignored
│   └── broadcast/                 # gitignored except committed run-latest.json snapshots
│
├── indexer/                       # Ponder project (§3)
│   ├── ponder.config.ts
│   ├── ponder.schema.ts
│   ├── src/
│   │   ├── LaunchFactory.ts
│   │   ├── BondingCurve.ts
│   │   └── Token.ts
│   ├── .env.example
│   └── package.json
│
├── web/                            # React + Vite frontend (§4)
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── src/
│   │   ├── main.tsx
│   │   ├── routes/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── lib/
│   │   └── styles/
│   └── package.json
│
├── packages/
│   └── shared/                     # @launchpad/shared (§5)
│       ├── src/
│       │   ├── abis/
│       │   ├── addresses/
│       │   ├── types/
│       │   ├── math/
│       │   └── index.ts
│       ├── scripts/
│       │   └── sync-abis.ts
│       ├── tsconfig.json
│       └── package.json
│
├── docs/
│   ├── research/                   # this doc and its siblings (indexer, frontend, contracts research)
│   └── adr/                        # architecture decision records, optional
│
├── .github/
│   └── workflows/
│       ├── contracts.yml
│       ├── indexer.yml
│       ├── web.yml
│       ├── shared.yml
│       └── ci.yml
│
├── pnpm-workspace.yaml
├── package.json
├── biome.json
├── .gitignore
└── README.md
```

## 9. Carried-forward lessons from `pons-launcher`

Concrete things worth keeping, and things this rebuild's structure already
fixes:

- **Keep:** atomic write-then-rename for any file-backed state that survives a
  restart (`backend/src/v4/store.js:8-13` explains why — a process killed
  mid-write must not leave a half-serialised file where a multi-week
  campaign's state used to be). If any part of this rebuild still needs local
  file state (e.g. indexer checkpoint files, though Ponder's Postgres store
  makes this largely moot), keep this discipline.
- **Keep:** "nothing broadcasts without an explicit flag" for deploy scripts
  (`backend/scripts/deploy-contract.js:16-19`) — `forge script` without
  `--broadcast` already defaults to this; don't wrap it in anything that
  changes that default.
- **Fix:** the CommonJS/ESM shared-module workaround
  (`frontend/vite.config.js:14-27`) is a direct consequence of `shared/` not
  being a real package. `packages/shared` as an actual pnpm workspace member,
  authored as ESM TypeScript from the start, needs no such plugin.
  Same file family also gets stronger types for free: hand-written JSDoc-typed
  CommonJS in `shared/bundleShare.js` becomes a TS module wagmi/viem can infer
  through end-to-end.
- **Fix:** the old repo indexes nothing — it queries chain state on demand per
  request (`backend/src/evm/v2/holdings.js`) and keeps its own history as flat
  JSON (`backend/src/store/history.js`). That was adequate for one operator's
  own launches; a public launchpad's "browse all tokens," "this token's trade
  history," "current holders" pages need the indexer described in §3, not N
  more RPC calls per page load.
- **Note, don't necessarily fix:** the frontend's native-binary pinning
  (`frontend/package.json:25-30`) for rolldown/lightningcss across
  Linux/Windows is a real Vite 8 + npm workspace wrinkle. Under pnpm this may
  behave differently (pnpm records more precise per-platform optional-dep
  metadata than npm does) — worth a quick check when `web/` is scaffolded
  rather than assuming pnpm needs the same pinning.

## 10. Open items for the indexer and frontend research docs

Flagging explicitly rather than silently assuming, since those docs are the
authority on their domains:

- Confirm Ponder (vs SQD/Envio) against the actual event volume and query
  patterns the launchpad needs once the contracts' event shapes are final —
  this doc's case for Ponder is about developer ergonomics and chain support,
  not a load-tested comparison.
- Confirm whether any token/curve page needs server-rendered social-preview
  metadata (OG images) — the one concrete case where the Vite-SPA
  recommendation in §4 would need revisiting in favor of Next.js or a small
  dedicated edge function for image generation only.
- Decide the indexer's public API shape (GraphQL vs REST vs SQL-over-HTTP —
  Ponder supports all three) based on what the frontend's data-fetching
  patterns actually need; §5's `packages/shared` types should be generated
  from or validated against whatever that API commits to.
