# Frontend (Sub-project C) — spec + plan drafted, 2026-08-22

**Status:** DONE. Drafted the spec and TDD implementation plan for sub-project C
(the frontend), per the locked stack (React + Vite, viem/wagmi v2/TanStack Query
v5, RainbowKit, lightweight-charts v5, Tailwind v4, React-Hook-Form + Zod) and the
hybrid data rule (quotes and writes always direct-from-chain; lists/history/holders
from sub-project B's API). No frontend code was written — only the two documents.

**Files:**
- `docs/superpowers/specs/2026-08-22-frontend-design.md`
- `docs/superpowers/plans/2026-08-22-frontend.md`

**Task count:** 14 tasks in the plan.

**Grounding done before writing:** read A's actual frozen ABIs in `packages/shared`
(not just the research docs) and confirmed a real gap the plan closes in Task 2 —
`packages/shared`'s existing `uniswapV3PoolAbi`/`erc20Abi` exports are event-only
fragments written for B's indexing needs (`Swap`/`Transfer`) and carry no
`slot0`/`token0`/`token1`/`getPool` functions and no `multicall`/`unwrapWETH9` on
the router — none of which C's quote-from-`slot0` and swap-write flows can work
without. Confirmed the needed pool/factory/router interfaces are already compiled
under `contracts/out/IUniswapV3.sol/*.json` (A declared them for its own launch
path) and can be pulled in additively; only `multicall`/`unwrapWETH9` need hand-
adding, since no compiled artifact anywhere in the repo declares them. Also
verified the exact buy/sell call shapes (including the "sell recipient must be the
router's literal address, never `address(0)`, or it reverts `TF` on this exact
deployment") against `pons-launcher/backend/src/evm/router.js`, already
battle-tested against the live router. Confirmed `forge`/`anvil` 1.7.1 are on PATH
and that `anvil --fork-url <chain-4663-RPC>` + A's existing `contracts/script/
Deploy.s.sol --broadcast` is sufficient for the plan's local-Anvil write-flow
tests (Launch, Swap) — no contract changes needed. Pulled current npm-registry
versions for the whole JS stack rather than guessing.

**Open questions I had to resolve (flagged in both docs, not silently decided):**
1. **wagmi version:** npm-`latest` is now wagmi v3 (3.7.6), but RainbowKit's
   current stable release (2.2.11) peer-depends on `wagmi ^2.9.0` — pinned to
   wagmi v2 (2.19.5) per the locked decision, and called out explicitly as "don't
   bump without a RainbowKit compat check."
2. **TypeScript version:** npm-`latest` is now TypeScript 7.0.2 (the native/Go-
   ported compiler, very recently released) — deliberately pinned to 5.9.3 instead,
   since wagmi/viem's ABI-to-type inference wasn't a locked decision requiring the
   bleeding edge and leans on deep conditional types not yet broadly verified
   against TS7.
3. **B's API isn't frozen** (parallel design) and is missing two endpoints this
   frontend's page designs need — `GET /launch-configs` (Launch page's config
   picker; A's factory has no on-chain config-enumeration function, only
   by-id lookups) and `GET /wallets/:address/holdings` (Portfolio). Both are
   built as provisional client + zod schema now (mirroring `00-digest.md` §3's
   documented surface), with a fixed-range on-chain probe fallback for the
   config picker, and flagged in spec §9 to reconcile with B once its schema
   firms up.
4. **Non-goal correction against the research doc:** `30-frontend-architecture.md`
   describes pons's own richer Create form (holder fee-sharing toggle,
   creator-adjustable tax %, snipe-tax exemptions). None of these exist in A's
   frozen `TokenParams`/`Locker` ABI (fixed 70/30 split, no per-launch fee choice,
   no v2 exemption list), so the spec explicitly scopes them out as ungrounded in
   the actual contracts, rather than copying pons's fuller feature set.
