# 00 — Engineering Digest: How Pons's Launchpad Works & What Recreating It Requires

De-duplicated synthesis of `docs/research/10-*.md` … `60-*.md`. Source of truth for those
findings is the sibling `pons-launcher` repo (a working operator client of the **live,
verified** pons contracts on Robinhood Chain) plus live on-chain reads and Blockscout, cross-
checked against `docs.ponsfamily.com` — which the research **repeatedly proves unreliable for
addresses** (it lists factory/locker deployments that never emitted an event). The operating
rule inherited from every source doc: **verify anything address-shaped or parameter-shaped
against the live chain, never against docs.**

**The single most important framing fact:** "pons" is two unrelated protocols under one brand.

| | **v1** — the brief's target | **v2** — what pons became |
|---|---|---|
| Model | Fixed-supply token → **Uniswap V3 pool at birth**, no curve | **Bonding curve** at birth → **Uniswap V4 pool at graduation** |
| Anti-snipe | 2-block wallet/tx cap that **reverts** over cap | Decaying **snipe tax** (99%→0) + declared exemption list |
| "Graduation" | Cosmetic progress bar (pool never migrates) | Real state transition (curve drains → v4 pool + locker) |
| Scope call | **BUILD THIS.** Matches "fixed supply, instant Uniswap V3, anti-snipe" | Study as prior art; out of scope unless the human re-scopes |

The two share no contract, ABI, or lifecycle. `40-reference-launchpads.md` and the brief both
point at **v1**. This digest leads with v1 and treats v2 as reference. Building v2's shape
while calling it "pons" would silently change scope from day one.

---

## 1. On-chain — factory, token, pool, locker, economics

### 1.1 v1 launch: one atomic `launchToken(...)` call

Per the factory's own verified doc-comment: *"Atomically deploys, pools, locks, records, and
optionally buys a token."* In one transaction it: (1) CREATE2-deploys the ERC-20 (address
predictable in advance via `predictTokenAddress`, which is what lets bundle buys be pre-signed
before the token exists); (2) creates a Uniswap V3 pool `token/WETH` at the config fee/tick;
(3) mints the full supply and seeds it as a **one-sided** position at `initialTick`; (4) locks
the LP-NFT into the permanent locker; (5) writes the authoritative `LaunchedToken` record; (6)
optionally swaps any `msg.value − launchFee` as an atomic dev buy (recipient = `feeWallet`, or
launcher if zero); (7) enforces the launch-window restriction.

`msg.value` **must equal** `launchFee + initialBuyAmount` exactly. There is no external price
reference for the initial buy, so its `amountOutMinimum` is necessarily `0` — a **reviewed**
decision, not slippage protection.

**ABI shape (v1):**
```solidity
function launchToken(TokenParams params, uint256 launchConfigId, uint256 dexId, bytes32 salt) payable returns (address token)
function predictTokenAddress(TokenParams, uint256, uint256, bytes32, address deployer) view returns (address)
function getLaunchConfig(uint256) view returns (LaunchConfig)
function getDexConfig(uint256)   view returns (DexConfig)
function getLaunchedToken(address) view returns (LaunchedToken)   // authoritative provenance
function launchFee() view returns (uint256)

struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address feeWallet; }
struct Socials     { string twitter; string telegram; string discord; string website; string farcaster; }
struct LaunchConfig{ address pairToken; uint256 graduationThreshold; int24 initialTick; uint256 supply;
                     uint16 maxWalletBps; uint16 maxTxBps; uint32 restrictionBlocks; uint24 reservedFee;
                     bool enabled; bool routerRequiresDeadline; }
struct DexConfig   { string name; address factory; address positionManager; address swapRouter;
                     uint24 poolFee; int24 tickSpacing; bool enabled; }
struct LaunchedToken{ address token; address deployer; address pairedToken; address positionManager;
                      uint256 positionId; uint256 dexId; uint256 launchConfigId; uint256 restrictionsEndBlock;
                      uint256 supply; bool isToken0; uint24 poolFee; bool exists; uint256 initialBuyAmount; }
```

The `logo` cannot be empty — it is baked into the CREATE2 preimage forever. Provenance is
**always** read from the factory's `getLaunchedToken` record (`exists == true`), **never** from
the token's self-reported `deployer()`/`launchFactory()` getters — "a dusted ERC-20 can claim
whatever it likes about itself."

### 1.2 v1 restriction window (the "anti-snipe tax", which is actually a cap)

Enforced by the token's own transfer hook, keyed on `_isPairPool(from)` — **only pool→user buys
are gated; sells and wallet-to-wallet transfers are never restricted.** A breach **reverts**
(it does not clamp); the pool's `TransferHelper` masks the reason as the opaque string `"TF"`.

- Launch block (block 0): only the factory's atomic initial buy can execute; every other
  pool→user buy reverts (`block.number == launchBlock` strict-equality ban).
- Blocks 1–2: every non-exempt address capped at **5% held** (`maxWalletBps` 500) / **5.5% per
  tx** (`maxTxBps` 550).
- Block 3+: all limits lift; plain ERC-20 thereafter.
- **Exempt: only the atomic initial-buy recipient, launch block only.**

**Known loophole (must be a reviewed decision, not an accident):** because the cap gates on
`from == pool`, a large buy landing on an intermediate (non-pool) contract that then fans out to
many wallets bypasses the per-wallet cap. `pons-launcher` exploits this deliberately for
legitimate bundle distribution; the same is available to an adversary.

### 1.3 v1 pool + locker

- **Pool:** Uniswap V3, WETH-quoted, **1% fee tier** (`poolFee = 10000`), tick spacing 200,
  `initialTick = -204200` (live). Priced by reading the pool's `slot0().sqrtPriceX96` directly
  (no Quoter on this chain — see §2).
- **Locker (`PonsLaunchLocker`, verified):** the position NFT is transferred here in the same
  launch tx via `lockPosition(address token) onlyFactory`. The locker **intentionally exposes no
  withdraw and no arbitrary-call function** — locking is *permanent by construction*, not by
  timelock. The only thing extractable is **swap fees**: `collectFees(address token)` (gated by
  an owner-managed `feeCollectors` allow-list) splits fees under a per-token policy. The creator
  share is redirectable by the deployer via `setFeeRedirect(token, newWallet)`; the protocol
  share is owner-controlled (`protocolFeeShare` ≤ `MAX_PROTOCOL_FEE_SHARE = 50`, snapshotted per
  token at launch). `Ownable2Step`. The locker is wired to the factory as an **immutable
  constructor arg** — a factory deployment cannot be repointed at a different locker.

### 1.4 v1 economics (confirmed unless noted)

| Parameter | Value | Confidence |
|---|---|---|
| Supply | 1,000,000,000 (1e9), 18 decimals, fixed | Confirmed (code + docs + live read) |
| Launch fee | 0.0005 ETH (`500000000000000` wei) | Confirmed live + ctor arg |
| Pool | Uniswap V3, WETH pair, 1% fee, tickSpacing 200 | Confirmed live |
| Max wallet / max tx | 5% / 5.5% of supply | Confirmed live |
| Restriction window | 2 blocks (≈32s — see §2 block-time gotcha) | Confirmed live |
| `graduationThreshold` | 4.2 ETH (cosmetic for v1) | Confirmed live; inert per docs |
| Trade fee split | 70% creator / 30% protocol (active); 90/10 (legacy) | **Docs only** — never read by client |
| `reservedFee` | 0 live; purpose undocumented | **Unknown** |
| No ongoing token tax | Only the 1% Uniswap swap fee | Confirmed |

### 1.5 v2 (reference only — bonding curve)

Factory `launchToken` (2 overloads, one taking `address[] snipeTaxExemptions`) takes
`msg.value == launchFee` **exactly** (`LaunchFeeNotPaid()` otherwise); atomic dev buy goes
through the **separate `PonsV2LaunchForwarder.launchAndBuy` (value = launchFee + quoteIn)**. A
`PonsV2BondingCurve` (one per launch) holds the whole supply, priced constant-product `x·y=k`
against a **phantom quote reserve** (config #0 live: supply 1e9, phantomQuote 1.68 ETH ⇒ k =
1.68e9). Fees taken off the buy **input**. `TokenLaunched(token indexed, curve indexed, deployer
indexed, pairToken, launchConfigId, graduationThreshold)` — **verified verbatim** (unlike v1's).
Snipe tax 99%→0 over `snipeTaxSeconds`, charged on **recipient**; exemption cap **32 factory-
direct / 31 via forwarder** (forwarder appends its own recipient — an off-by-one that reverts
`ExemptionListTooLong`). At graduation (`raised >= graduationThreshold`, net of fees, 4.2 ETH
live) a **full-range Uniswap V4 position is minted and sent to a permanent locker**; trading
moves to a v4 pool via a shared `memeHook`. Access gated by `canLaunch(address)` — **never read
`whitelistedLaunchers` alone; it is one input, and mistaking it for the answer made the team
believe v2 was closed while thousands of launches went through.** v2 carries an **ongoing** hook
fee post-graduation (unlike v1).

---

## 2. Chain infrastructure — Robinhood Chain + Uniswap V3

**Chain identity:** Robinhood Chain, **chain id 4663** (testnet 46630), an **Arbitrum Orbit L2**
settling to Ethereum, ETH-native (18 dec), **sequencer-ordered with no public mempool** (a
pending tx cannot be mempool-front-run). RPC `https://rpc.mainnet.chain.robinhood.com`; explorer
Blockscout `https://robinhoodchain.blockscout.com` (+ `/api/v2/...` REST, no key).

**THE block-time gotcha (design around from day one):** two "block numbers" coexist. RPC height
advances ~every 100ms (~10/s). But **`block.number` read inside a contract advances only ~every
16 seconds** (it reflects the parent chain, an Arbitrum-family quirk). Every on-chain
restriction is written against the *contract-visible* number. So `restrictionBlocks: 2` ≈ **32
seconds**, not ~200ms. Read it via a contract call (Multicall3 `getBlockNumber()`), never from
RPC height — or duration math is off by ~160×.

**RPC realities the indexer/clients must handle:** the public RPC load-balances across
heterogeneous nodes and intermittently returns spurious `-32601 Method not found` on valid
calls (retry transient `-32601/-32603/-32005/-32000` + "rate limit/timeout/busy" text);
`eth_getLogs` capped at ~10k blocks (chunk + halve-on-refusal); **concurrency is *slower*** (8
concurrent getLogs = 16s vs 0.3s each sequential) — prefer sequential + Multicall3 batching;
`batchMaxCount: 1` because some nodes mishandle JSON-RPC batch arrays. A paid provider
(Alchemy/QuickNode) removes most of this. Also: Relay `/quote` on this chain rate-limits ~5/window/IP (memory note) — relevant only to cross-chain funding.

**Confirmed-live addresses (read from chain, cross-checked on Blockscout):**

| Contract | Address |
|---|---|
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| WETH (pair token) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| UniswapV3Factory | `0x1F7D7550b1b028f7571E69A784071F0205FD2eFA` |
| NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| SwapRouter02 (pons's router) | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| PonsLaunchFactory (v1) | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (start block 8991118) |
| PonsLaunchLocker (v1) | `0x736D76699C26D0d966744cAe304C000d471f7F35` |
| PonsV2LaunchFactory / Deployer / Forwarder | `0x7eD598…EC7e` / `0x3711ceA4…1A42` / `0xe33E9E47…2948` |

**Uniswap V3 here is a custom deployment** — addresses do **not** match canonical CREATE2
addresses. `pons-launcher` never hardcodes them; it reads them from `getDexConfig(id)` (the
factory is the authority). **No Quoter/QuoterV2 exists** at a known address (the canonical
addresses hold *unrelated* `SwapRouter`/`SwapRouter2` contracts by coincidence). Price without a
quoter by reading the pool's `slot0()` directly — a viable quoter-free pattern to reuse. The
**router has two `exactInputSingle` shapes** (with/without `deadline`), selected per config by
`routerRequiresDeadline` (live = false). Selling uses a two-call `multicall` (swap→`unwrapWETH9`)
with the swap `recipient` set to **the router's own address** (passing `address(0)` reverts
`"TF"`). **UniversalRouter / Uniswap V4 PoolManager have no code here** — needed only if
supporting graduated-token trading, and must be discovered from scratch.

---

## 3. Indexer — events, data model, API, tech choice

Recommended tech: **Ponder.sh** (TypeScript, viem-based, Postgres, GraphQL + SQL-over-HTTP,
built-in reorg-safe backfill/checkpointing, native factory-pattern dynamic contract
registration). **Why:** no subgraph exists for this chain (The Graph would mean self-hosting
graph-node + IPFS for zero payoff); a hand-rolled viem poller re-solves reorg/checkpoint/backfill
problems a framework already solves; Ponder sits between — it *is* a viem program, so every
RPC-quirk lesson above transfers, while the sync engine, rollback, and query layer come free. It
retires `pons-launcher`'s pattern (flat per-user JSON files + on-demand `balanceOf` reads; no
price history, no trade log, no OHLCV — genuinely new work).

**Three trade-event shapes must be indexed, not one** (a design that indexes only "the Swap
event" silently misses two thirds of activity):

| Protocol | Launch event | Trade event | Shape |
|---|---|---|---|
| v1 | `TokenLaunched` (v1) — **signature not in repo, pull from verified source** | Uniswap V3 `Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)` | one pool contract per launch |
| v2 pre-grad | `TokenLaunched` (v2) — **verified verbatim** | curve `Buy`/`Sell` — **name/ABI unknown, pull from `PonsV2BondingCurve` source** | one curve contract per launch |
| v2 post-grad | graduation event (name TBD) | Uniswap V4 `PoolManager.Swap`, keyed by **`poolId`** (singleton, no per-pool address) | one singleton PoolManager |

**Data model (Postgres; amounts as `numeric`/`text` base units, never float):** `tokens` (one
per launch, both protocols, metadata + socials + lifecycle) · `pools` (one row per venue a token
has had — a v2 token has two: curve then v4 pool) · `trades` (`tx_hash+log_index` PK, normalized
buy/sell across all three shapes, side derived from signed amounts + `isToken0`) · `candles`
(precomputed OHLCV per `(token, interval, bucket)`, materialized on trade arrival) · `holders`
(running balances from ERC-20 `Transfer`) · `launch_configs`/`dex_configs` (mirror of factory
structs) · `sync_state` (checkpoint per watched contract; Ponder-managed).

**API surface (read-only HTTP in front of the store):** `GET /tokens` (paginated, sortable:
newest / market-cap / 24h volume / 24h change; filter protocol, graduated; each row carries the
graduation-progress % for curve tokens) · `GET /tokens/:addr` (detail + live pool/curve state) ·
`GET /tokens/:addr/candles?interval=` · `GET /tokens/:addr/trades?cursor=` · `GET
/tokens/:addr/holders` (+ cheap `/count`) · `GET /search?q=` (pg_trgm on name/symbol, PK on
address) · `GET /stats` · realtime new-trades push (WS/SSE) or short-poll.

**Carry-over requirements (not suggestions):** chunk `eth_getLogs` ≤10k and split-on-refusal;
sequential/Multicall3 reads over concurrency; classify+retry transient RPC errors; don't assume
batch JSON-RPC works; reason about durations in contract-visible `block.number`; derive pool
identity from `TokenLaunched` + `getPool`, never the token's self-report; treat docs as
hypotheses.

---

## 4. Frontend — pages, stack, data flow, trade execution

**Trust model:** a **non-custodial wallet-signing dapp** — the visitor's wallet signs every
launch/buy/sell. This is the *opposite* of `pons-launcher/frontend` (a private operator console
whose server holds keys and signs via an `x-api-key`-gated API). Reuse that repo's **UI
conventions** (IPFS logo-upload flow with moderation checkbox + preview; config-driven launch
with no free-typed supply; two-step arm-switch + confirm-modal that freezes the request body;
named-`busy` states; a global toast bus; per-protocol module isolation) — **never** its money-
moving plumbing.

**Pages:** `/` Explore (sortable/filterable token list: logo, price, market cap, 24h vol/change,
holders, age, graduation-progress bar for curve tokens, protocol badge) · `/create` Launch
(name, ticker, description, logo upload, socials, config picker echoing enforced rules, paired
asset, dev buy, creator-fee wallet, creator tax bounded by live factory max, summary strip;
arm-switch + confirm modal showing predicted token address) · `/token/[address]` Trade (chart +
buy/sell panel above fold; info/holders/recent-trades below) · `/portfolio`.

**Stack:** viem + wagmi v2 + TanStack Query v5, RainbowKit (Privy flagged for later),
**lightweight-charts v5** (note the v4→v5 `addSeries` breaking change), Tailwind (+ Radix/shadcn),
React-Hook-Form + Zod, IPFS pinning proxied through a server route (never a browser-embedded key).
**Framework is an OPEN QUESTION** (see table): doc `30` recommends **Next.js** (SSR for Explore
paint, thin BFF route handlers, per-token OG images); doc `50` recommends **React + Vite** static
SPA (all data comes from the indexer anyway; matches the team's Vite fluency; one static
artifact, no Node runtime).

**Data flow is a hybrid — do not force one source to serve both:**
- **Direct chain reads (viem/wagmi):** a single token's *live* state on its trade page (pool
  `slot0`/curve reserves, `balanceOf`, restriction status); the **quote** step (must be current-
  block); and the **write** itself (launch / curve `buy`/`sell` / router `exactInputSingle`).
- **Indexer API:** the Explore table, candlestick history, recent-trades feed, holders, search,
  portfolio — queries no single RPC call answers.
- Rule: the price-you're-about-to-pay and the transaction are **always direct-from-chain**, so a
  stale index can never cause a bad fill.

**Trade execution specifics:** v1/graduated pool → quote (there is no on-chain Quoter here, so
compute from `slot0` or a discovered Quoter), then `SwapRouter02.exactInputSingle` with a **real
non-zero `minAmountOut`** from a fresh quote × (1 − slippage) — *never* the zero floor that the
atomic-launch/bundle path justifiably uses. Curve (pre-grad) → quote against curve math, call
`buy`/`sell`. **Approve exactly the amount, every time; leave no standing allowance.** Branch
curve-trading vs pool-trading **at the page level**, not with `if (isV2)` threaded through shared
logic.

---

## 5. Security must-dos (this gates the build order)

Nothing touches mainnet until §7 of `60-security-and-risk.md` is done and signed off. A fee-
collecting, pool-minting, liquidity-locking factory is a **fund custodian** from block one, its
launches are **irreversible and unpausable by design**, and this is the most heavily attacked
class of code on public chains. Non-negotiables:

- **Fee/value math** as one pure, fuzz-tested `splitValue(msg.value, fee) → (fee, buy)` over the
  full `uint256` range; `msg.value == fee` must not revert, `< fee` must revert; **grep every
  `unchecked{}`** (underflow-wrap reintroduces the classic bug).
- **Atomicity:** deploy→pool→seed→lock→(buy) all-or-nothing; test with a mock DEX that reverts at
  each step. **CREATE2 address prediction must be cross-checked against a static call of the real
  deploy path in an automated test** — sending value to a not-yet-deployed address *succeeds and
  burns the funds* (this stranded 1.798 ETH once in the v2 lineage).
- **Reentrancy guard on every state-mutating entry point** + checks-effects-interactions (guards
  don't stop cross-function reentrancy). Treat every externally-supplied address (feeWallet, pair
  token, exemption member) as attacker-controlled.
- **Access control:** enumerate every privileged function; **snapshot each launch's config into an
  immutable per-token record** so an admin edit can never retroactively change a live token's
  rules; multisig + **timelock** on anything that redirects money or rewires the DEX; expose one
  composed `canLaunch()` view as the authority (never let off-chain code reimplement the gate from
  raw storage).
- **DoS:** every caller-supplied array explicitly bounded *before* any external call/state write,
  gas comfortably inside a block; **pull-payments** (not push loops) where third parties can be
  recipients.
- **Token:** **no `mint()` at all** — supply minted once at construction; free-text metadata is
  safe on-chain but untrusted in the UI (XSS/log-injection).
- **Snipe protection un-bypassable:** decide-and-document the buy-then-fan-out loophole (§1.2);
  exemptions settable **only inside the launch tx**, never afterward; cap enforced identically in
  any forwarder/wrapper; verify "cap holds across every delivery path" (direct pool, router,
  helper, same-block repeat) as a fuzz invariant; if a decay tax is used, its time source must be
  unmanipulable and the window long enough that timestamp tolerance is immaterial.
- **Lock:** the real question is "*who* can move the liquidity before the unlock condition, by
  what call path" — answer with a full call-graph review + a test that tries every path and
  asserts revert. Prefer permanent-by-construction (no withdraw function) over admin-gated. Build
  a **timelocked, narrowly-scoped rescue** for permanent-failure cases from day one (an unbounded
  admin backdoor is indistinguishable from a rug). Audit the token for any owner-gated function
  that could functionally rug a "locked" pool indirectly.
- **Trading:** every `minAmountOut` is a per-call-site decision (zero only where justified and
  documented); test the two-router-shape matrix; minimal short-lived approvals; establish "is this
  one of ours" from the factory record, never the token's self-report.
- **Gate (before mainnet):** full unit + custom-error coverage; Foundry `invariant_`/fuzz (supply
  conservation, cap-across-paths, exemption-cap, lock-unmovable); Slither/Mythril to zero
  unexplained findings; **mainnet-fork tests against the real DEX/router/WETH**; a dry-run/simulate
  mode; independent adversarial review → testnet regimen → **professional audit** → bug bounty →
  **staged, capped** mainnet rollout with push-based alerting and a rehearsed incident-response
  plan. Key management hardware-backed and multisig from the first mainnet tx, not "later."

---

## 6. OPEN QUESTIONS — need the human's decision

| # | Question | Why it matters / options | Blocks |
|---|---|---|---|
| Q1 | **Scope: v1 only, or v1 + v2?** | v1 = fixed-supply instant-V3 (matches brief). v2 = bonding curve → V4. Changes contracts, indexer (3 event shapes vs 1), and the Create/Trade UI (config picker + curve branch). Recommend **v1 first, v2 as a later track.** | Everything |
| Q2 | **Own contracts, or integrate pons's live factory?** | Security doc assumes we build our **own** factory/token/locker. Integrating pons's removes contract risk but forfeits fee control and ties us to their upgrades. | A, B, C |
| Q3 | **Fee tier & split — copy pons or diverge?** | Pons's 1% pool fee is publicly attacked by Uniswap Pools as "2% spread"; Pools is out-launching pons on the same chain at **zero** launch fee / 0.25% LP. V3 supports 0.05%/0.3% tiers. Consider creator-configurable split (openfair keeps up to 100%). | A, C |
| Q4 | **Frontend framework: Next.js (doc 30) or React+Vite (doc 50)?** | Real internal disagreement. Next.js buys SSR Explore paint + per-token OG images; Vite buys a static, Node-free artifact matching team fluency. Decide before scaffolding `web/`. | C |
| Q5 | **Anti-snipe primitive & the fan-out loophole** | v1 wallet-cap (2 blocks) "lapses almost immediately." Adopt hood.fun's pre-graduation non-transferability? Adopt v2's declared-exemption-list for legit team bundles? Cap on `to` as well as `from`? Each is a reviewed security decision, not a default. | A |
| Q6 | **Restriction window length** | 2 blocks ≈ 32s is a deliberate, short, security-relevant parameter — keep, lengthen, or replace with a decaying tax? | A |
| Q7 | **Indexer: Ponder vs a Dune/explorer API MVP** | Protocol needs no off-chain API; a minimal product could read live logs before investing in Ponder. Ponder is the recommended durable choice. | B, C |
| Q8 | **Multi-quote-asset support?** | Pons v2 pairs against USDG/tokenized stocks; v1 is WETH-only. Stablecoin addresses on this chain not yet surfaced. | A, C |
| Q9 | **Graduated-token trading (Uniswap V4)?** | Requires discovering UniversalRouter + PoolManager (no code at canonical addresses here). Only relevant if Q1 includes v2. | A, B, C |

### Parameters to re-verify live at build time (do not hardcode from docs)
- v1 `TokenLaunched` event signature & indexed-ness (not in repo; docs topic0 is malformed).
- v2 curve `Buy`/`Sell` and graduation event ABIs (pull from verified source).
- v2 `snipeTaxSeconds` (repo says 3s, docs say 5s) and v2 `launchFee` (no anchored figure).
- v1 `reservedFee` purpose (read as 0, unexplained anywhere).
- v1 fee split 70/30 vs 90/10 (docs-only, never read by client).
- v2 `phase` enum ordinals (read as a bare int).
- Which factory address is truly live + `canLaunch()`/`launchEnabled()` true + a recent
  `TokenLaunched` — always, for any address, before trusting it.
- Whether other `dexConfig`/`launchConfig` ids exist beyond id 0.
