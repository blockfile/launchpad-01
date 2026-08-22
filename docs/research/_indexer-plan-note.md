# Indexer spec + plan — summary note

Produced the Sub-project B (Indexer) design deliverables per the digest/decomposition research and
sub-project A's actual, merged contracts (`contracts/src/LaunchFactory.sol`,
`packages/shared/abis/*.ts`). Scope is narrower than the general two-protocol research doc: A only
ever built the pons-**v1** shape (fixed-supply token, instant Uniswap V3 pool, no bonding curve, no
graduation), so the indexer watches exactly three event shapes — `LaunchFactory.TokenLaunched` (our
own signature: `token, deployer, pool, launchConfigId, dexId, supply, initialBuyAmount`), the pool's
standard V3 `Swap`, and the token's standard ERC-20 `Transfer` — plus the factory's
`LaunchConfigSet(id)`/`DexConfigSet(id)` admin notifications. Tech is Ponder.sh (`ponder@0.17.8`,
`viem@2.55.19`, `hono@4.13.3`, `drizzle-orm@0.45.2`), confirmed against Ponder's current docs (factory
pattern, `onchainTable` schema, `context.client.multicall`, Hono custom API routes, pglite/postgres
config) rather than assumed from memory. Every non-trivial computation (Swap side/price derivation
via `sqrtPriceX96`, OHLCV bucketing, holder balance arithmetic, pagination, search/stats math) is a
pure function in `src/lib/*.ts`/`src/api/helpers.ts`, unit-tested with literal fixtures; `ponder.on`
handlers and the Hono API stay thin glue. The capstone task forks the real Robinhood chain via a
local Anvil, deploys A's unmodified `Deploy.s.sol`, drives a real launch + swap + transfer, and
asserts on the indexer's live HTTP API end-to-end.

**Files produced:**
- `d:\projects\launchpad-01\docs\superpowers\specs\2026-08-22-indexer-design.md`
- `d:\projects\launchpad-01\docs\superpowers\plans\2026-08-22-indexer.md` (10 tasks)

**Open questions resolved while writing (not re-litigated, baked into both docs):**
1. **Local dev/test chain id:** use `anvil --chain-id 4663` (never 31337) so `packages/shared`'s
   chain-4663 DEX addresses apply unmodified with no separate config branch.
2. **A's `Deploy.s.sol` wires the REAL live Uniswap V3 addresses**, not mocks — so a bare
   non-forked local Anvil can't run it (no bytecode at those addresses). Task 10 therefore forks
   the real chain (`anvil --fork-url <robinhood RPC> --chain-id 4663`) rather than using a bare
   local chain, mirroring exactly what A's own `test/fork/Launch.fork.t.sol` already does.
3. **`TokenLaunched` carries no name/symbol/logo/socials/dev-buy-recipient** — the handler reads
   token metadata + `getLaunchedToken` (authoritative provenance) + a direct `balanceOf(pool)` read
   in one batched multicall; the dev-buy recipient's very first balance (only when
   `initialBuyAmount > 0`) is an accepted, documented limitation depending on catching the real
   `Transfer` log, not derivable from the event alone.
4. **API-layer testability vs. Ponder's virtual modules:** `ponder:api`/`ponder:schema` imports
   only resolve inside Ponder's runtime, not under plain `vitest`. Fixed by splitting the API layer
   into `src/api/helpers.ts` (zero `ponder:*` imports, directly unit-tested) and `src/api/index.ts`
   (the Hono app + DB-touching routes, exercised for real only in Task 10's end-to-end test).

**STATUS:** done. Two files delivered, 10 tasks in the plan, both internally reviewed for step-
numbering consistency and one real bug (an operator-precedence/type-mismatch bug in a draft `/tokens`
cursor snippet) caught and fixed before finalizing.
