# 12 — Pool Creation & Liquidity Locker

Scope: how pons puts a launched token into a tradeable pool, how (and whether) it locks that
liquidity, and what "graduation" actually means. pons runs **two unrelated protocols** side by
side on Robinhood Chain (chain id 4663) — referred to in the `pons-launcher` codebase as **v1**
and **v2** — and they answer every one of these questions differently. The task that motivated
this doc (and docs.ponsfamily.com's own marketing copy) describes **v1**. v2 is a separate,
undocumented-on-their-own-docs-site protocol discovered by scanning the chain; it is included here
because it is the thing that actually matches the "bonding curve climbing toward graduation"
mental model, and a reimplementation needs to know pons shipped both.

## 0. Two protocols, one launcher UI

| | **v1** ("the" pons launchpad, what docs.ponsfamily.com describes) | **v2** ("pons v2", live on-chain, not the address docs.ponsfamily.com lists) |
|---|---|---|
| Factory (live) | `PonsLaunchFactory` — `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | `PonsV2LaunchFactory` — `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Pool model | Full Uniswap V3 pool created **at launch**, whole supply deposited as a one-sided V3 position | **Bonding curve** contract (`PonsV2BondingCurve`, one per launch) holds the whole supply; no pool exists yet |
| "Graduation" | Informational milestone only — pool already has all its liquidity; nothing moves | Real state transition — curve is drained and a **new Uniswap v4 pool** is created from the proceeds |
| Locking | Uniswap V3 position NFT sent to `PonsLaunchLocker` (permanent, no withdraw function) | N/A pre-graduation (there is no pool to lock); the docs pages and this repo's code do not describe a locker step for the post-graduation v4 pool — see §5 open question |
| Anti-snipe | Restriction window: `maxWalletBps` / `maxTxBps` caps for `restrictionBlocks` blocks, checked against the opening tick | Decaying "snipe tax" (starts ~99%, decays to 0 over ~3s) charged on the buy recipient, plus a factory-managed exemption list for bundled/team buys |
| Sources | `d:\projects\pons-launcher\backend\src\evm\factory.js`, `abi.js`, `router.js`, `pricing.js`; `shared/bundleShare.js` `shareV1` | `d:\projects\pons-launcher\backend\src\evm\v2\*.js`; `shared/bundleShare.js` `shareV2` |

Evidence that these are genuinely two separate products, not two versions of one: `backend/src/evm/v2/abi.js:16-18` —

> "v2 is a different protocol, not a new version of v1. A launch creates a bonding curve holding
> the whole supply; a Uniswap v4 pool is only built at graduation."

The rest of this doc covers v1 in depth (§1–§4, this is the one the task asked about), then v2
(§5), then the addresses (§6).

## 1. v1 — which DEX, and the fee tier

v1 launches directly into **Uniswap V3**. Confirmed from three independent angles:

- **The repo's own comment**, `backend/src/evm/factory.js:1-5`: "Reads and writes against
  ponsfamily.com's PonsLaunchFactory. We do not reimplement the launchpad — launchToken deploys,
  pools, locks and (with excess msg.value) buys atomically, exactly as it does from their site."
- **The DEX config shape** the factory exposes per `dexId` — `backend/src/evm/abi.js:21-24`:
  ```solidity
  struct DexConfig {
    string name; address factory; address positionManager; address swapRouter;
    uint24 poolFee; int24 tickSpacing; bool enabled;
  }
  ```
  `positionManager` + `poolFee` + `tickSpacing` is the Uniswap V3 shape (a V2-style AMM has
  none of these; V3's `NonfungiblePositionManager` mints a position NFT with exactly these three
  as inputs).
- **The swap router ABI the launcher calls** is literally Uniswap's V3 `exactInputSingle` /
  `SwapRouter02` shape, verified against the live router by trial call —
  `backend/src/evm/abi.js:54-64`, and the two shapes the factory itself switches between
  (`SWAP_ROUTER_V3_ABI` needs a `deadline` arg, `SWAP_ROUTER_02_ABI` doesn't) per
  `LaunchConfig.routerRequiresDeadline` — `backend/src/evm/router.js:14-24`.
- **docs.ponsfamily.com** (fetched 2026-08-22, mirrored at www.ponsfamily.com): "All tokens trade
  on Uniswap V3 with these specifications: Fee tier 1% (10000 basis points); Quote token: WETH
  exclusively; Pool factory: `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`."

**Fee tier**: `poolFee` is `10000` in Uniswap V3's native units (hundredths of a basis point,
i.e. `1e-6`), which is **1%** — the same fee tier Uniswap itself reserves for exotic/high-volatility
pairs, not the common 0.3%/0.05% tiers. Confirmed in code comments at
`backend/src/evm/pricing.js:24` ("Uniswap fee tiers are hundredths of a basis point: 10000 is
1%.") and in a real test fixture, `backend/src/evm/pricing.test.js:85` (`poolFee: 10000`). The
factory currently exposes this as `dexConfigs[i].poolFee` (one dex config per DEX + fee-tier
combination it's willing to launch into — `backend/src/evm/factory.js:67-80`), so in principle
more than one fee tier could be enabled; in practice the live config that matters is the 1% one.

## 2. v1 — how initial liquidity is provided, and in what pair

**Pair / quote asset**: WETH, exclusively and always — every v1 launch config names a
`pairToken` (`LAUNCH_CONFIG` struct, `backend/src/evm/abi.js:16-19`), and the live one is WETH.
The launch and every subsequent buy/sell moves **native ETH**, which the Uniswap V3 router wraps
and unwraps on the way in/out — see `backend/src/evm/router.js:27-79` (`buildBuyTx` sends native
`value`, the router wraps it) and `:81-170` (`buildSellTx`, which swaps token→WETH then calls
`unwrapWETH9` in the same `multicall` so the seller receives native ETH, not WETH — verified by
probing the live router rather than assumed from docs, per the comment at `router.js:81-105`).
docs.ponsfamily.com corroborates: "Every token trades against WETH in its own pool."

**Mechanism**: `PonsLaunchFactory.launchToken(...)` does three things atomically in one
transaction (per `factory.js:1-5` and confirmed by Blockscout's read of the verified source):
1. Deploys the ERC-20 (deterministically, at an address the factory can predict in advance via
   `predictTokenAddress` — `factory.js:171-180` — which is what lets a whole bundle of buy
   transactions be *pre-signed* before the launch is even sent, since every wallet already knows
   the token address it's buying).
2. **Creates the Uniswap V3 pool and seeds it with a one-sided liquidity position** — per
   Blockscout's read of the verified factory: "Atomically deploys ERC20 tokens into one-sided
   Uniswap V3 liquidity positions with optional native token swaps and permanent position
   locking." One-sided means the entire token `supply` from the launch config
   (`LaunchConfig.supply`) is deposited as the position's liquidity at a single opening tick
   (`LaunchConfig.initialTick`) — there is no ETH seeded on the other side; the pool has *no*
   price impact model beyond "whole supply on one side, zero (paired) reserve on the other, at
   tick T" until someone actually buys. This is exactly what `shared/bundleShare.js:198-209`
   (`openingPool`) reconstructs off-chain to estimate a bundle's fill before the pool exists:
   > "A constant product holding the whole supply quotes tokens-per-pair-token equal to
   > tokenReserve / quoteReserve, and the tick says that ratio is `rate`, so the pair-token side
   > of the pool it opens is supply / rate."
3. Optionally executes an atomic **dev buy** with any `msg.value` left over after the launch fee,
   landing the deployer's own opening buy in the same transaction as the pool's creation — so
   nothing can front-run it (`factory.js:182-191`, `buildLaunchTx`; `shared/bundleShare.js:365-370`
   in `shareV1`, "The dev buy is inside the launch transaction, so it is ahead of the entire
   bundle").

**Launch fee**: 0.0005 ETH (`500000000000000` wei) — confirmed from the live
`PonsLaunchFactory`'s constructor argument `initialLaunchFee` (Blockscout, contract
`0xA5aAb3F0…`) and matching docs.ponsfamily.com ("A small 0.0005 ETH launch fee applies at
creation").

**Anti-snipe restriction window** (separate from locking, but part of "how the pool opens"):
for `restrictionBlocks` blocks after launch, every non-exempt buyer is capped at `maxWalletBps` of
supply per wallet and `maxTxBps` per transaction (`LAUNCH_CONFIG` struct fields,
`backend/src/evm/abi.js:16-19`); a buy that would breach this **reverts** rather than clamping,
and the pool's `TransferHelper` masks the revert reason as `"TF"` (`shared/bundleShare.js:98-101`).
The launched token itself exposes the restriction state post-launch:
`restrictionEndBlock()`, `maxWalletLimit()`, `maxTxLimit()` (`PONS_TOKEN_ABI`,
`backend/src/evm/abi.js:67-76`).

## 3. v1 — the liquidity locker

**Contract**: `PonsLaunchLocker` at `0x736D76699C26D0d966744cAe304C000d471f7F35` on Robinhood Chain
(chain id 4663) — verified on Blockscout (`robinhoodchain.blockscout.com`), compiler
`v0.8.30+commit.73712a01`, SPDX `MIT`. This is the **only** locker the live factory is wired to:
`PonsLaunchFactory`'s own constructor arguments name `locker_ = 0x736D76699C26D0d966744cAe304C000d471f7F35`
as an **immutable** constructor parameter (Blockscout read of the verified factory source) —
so a given factory deployment cannot be repointed at a different locker after deployment.
docs.ponsfamily.com/www.ponsfamily.com additionally lists a **legacy locker**,
`0x31ca5E101941A93A7DD6d0497928700625CF54B5`, presumably wired into a now-superseded factory
deployment (the same page notes pons has had multiple factory deployments over time, and
`backend/src/evm/v2/abi.js:10-14` separately documents that the *docs site itself* points at a
stale, never-used v2 factory address — this ecosystem has a track record of docs lagging behind
the live contracts, so treat any address pons publishes as a hint to verify on-chain, not ground
truth).

**What it does — from the verified source's own NatSpec** (Blockscout source read):

> "Permanently holds launch position NFTs and distributes accrued fees. The contract
> intentionally exposes no position withdrawal or arbitrary-call function, so registered launch
> liquidity cannot be removed by an administrator."

That is the entire locking model: **there is no unlock, no lock-duration, and no
early/late/timelocked withdrawal path at all.** It is not "locked for N days" — it is
architecturally incapable of ever releasing the position. `onERC721Received` is present (it
receives Uniswap V3 position NFTs), and the only entry point that registers a position is:

```solidity
function lockPosition(address token) external onlyFactory
```
NatSpec: "Registers and verifies permanent custody of a launched position." — callable only by
the factory itself (`onlyFactory`), i.e. locking happens as one step inside the atomic
`launchToken` flow, not as a separate action anyone else can trigger.

**What the locker *can* do — fee collection, not liquidity removal.** A Uniswap V3 concentrated
position earns swap fees that accrue inside the position and need to be pulled out periodically;
the locker exposes exactly that, and nothing that touches principal:

```solidity
function collectFees(address token) external nonReentrant returns (uint256 amount0, uint256 amount1)
```
NatSpec: "Collects V3 fees and splits both assets under the configured policy." Who may call it
is gated by an owner-managed allow-list (`feeCollectors[address] => bool`, toggled via
`setFeeCollector(address collector, bool enabled) external onlyOwner`), and where the **creator's**
share of those fees goes is per-token and redirectable:

```solidity
function setFeeRedirect(address token, address newFeeWallet) external
```
NatSpec: "Redirects the creator share for one token. Callable by the launch deployer or factory."
— i.e. the token's own deployer can change which wallet receives their cut of collected fees,
without ever touching the locked position itself. The protocol's own cut is separately
configurable, capped, and owner-controlled:

- `uint256 public constant MAX_PROTOCOL_FEE_SHARE = 50` (a ceiling — the encoding, e.g. percent
  vs bps, wasn't determinable from the metadata fetch alone; worth confirming against source
  before relying on the exact unit)
- `uint256 public protocolFeeShare` + `setProtocolFeeShare(uint256 share) external onlyOwner`
  ("Changes the fee share snapshotted by future launches" — i.e. changing it does not retroactively
  change the split already snapshotted for tokens already launched; `tokenProtocolFeeShares[token]`
  records each token's frozen-at-launch share)
- `address public protocolFeeRecipient` + `setProtocolFeeRecipient(address recipient) external onlyOwner`

**Ownership**: `Ownable2Step`-shaped (`owner`, `pendingOwner`, `transferOwnership`,
`acceptOwnership`, `renounceOwnership`) — the owner controls fee policy and the
factory/collector wiring, but per the NatSpec above has **no privileged path to the locked
liquidity itself**. `initialize(address factory_) external onlyOwner` — "Binds the locker to one
immutable launch factory" — is presumably a one-time bootstrap call (bind-once semantics implied
by the wording "immutable", though the getter to confirm write-once-ness wasn't independently
checked).

Read/query surface, for completeness: `factory()` (the bound factory address),
`getLaunchedToken(address token)` (proxies `IPonsLaunchFactory.LaunchedToken` — the same record
`backend/src/evm/factory.js:98-117`'s `describeToken` reads directly from the factory),
`deployerTokens(address)` / `deployerTokenCount(address)` (every token a given deployer has
launched, for the locker's own bookkeeping), `feeRecipientTokens(address)` /
`feeRecipientTokenCount(address)` (every token whose fees currently route to a given recipient).

**Locked-position bookkeeping, on the factory side.** The factory's own launch record for a v1
token carries the position identity directly — `LAUNCHED_TOKEN` struct,
`backend/src/evm/abi.js:31-34`:
```solidity
struct LaunchedToken {
  address token; address deployer; address pairedToken; address positionManager;
  uint256 positionId; uint256 dexId; uint256 launchConfigId; uint256 restrictionsEndBlock;
  uint256 supply; bool isToken0; uint24 poolFee; bool exists; uint256 initialBuyAmount;
}
```
`positionId` is the Uniswap V3 `NonfungiblePositionManager` NFT id that was minted for this
launch and then locked — this is the on-chain thread connecting a specific token to the specific
NFT sitting (forever) inside `PonsLaunchLocker`.

## 4. v1 — "graduation" is a threshold marker, not a state change

This is the answer to the task's direct question: **v1 does not use a bonding curve.** It is an
instant, full-liquidity Uniswap V3 listing from block one. "Graduation" here is purely an
**informational milestone** computed off the pool's own reserves, not a migration, not a curve
completion, and not a change to how the token trades.

Evidence:

- The `LaunchConfig` struct itself carries a `graduationThreshold`
  (`backend/src/evm/abi.js:16-19`, `backend/src/evm/factory.js:55`) — this is a threshold on
  **paired WETH in the pool**, not on a separate curve contract (v1 has no curve contract at all;
  the whole supply is already in the V3 position from launch, per §2).
- docs.ponsfamily.com, fetched directly: *"A launch graduates once the WETH paired in its locked
  pool reaches the threshold. The default threshold is 4.2 ETH, and the progress line tracks how
  close a launch is."* — note "**its locked pool**": the pool graduation is measured against is
  the same pool, already locked, from launch.
- Critically, the same page: *"There is no bonding curve and no migration later. Buys and sells
  happen in that same pool from the moment it launches."* and *"trading continues in the same
  pool after graduation. Nothing moves or migrates."*
- And the explicit disclaimer that graduation is not a quality/liquidity guarantee: *"Graduation
  only confirms the threshold was reached. It is not a quality signal and does not guarantee
  future liquidity, price, or an exit."*
- Nothing in `pons-launcher`'s v1 code path (`factory.js`, `pricing.js`, `router.js`) reads or
  branches on any graduation state for v1 — the concept only becomes operationally relevant
  (something the launcher code actually gates behavior on) in **v2**, where it is real (§5). The
  console/API only reports v1's `graduationThreshold` as a static config value, never a live
  "has it happened" boolean, which fits: for v1 there is nothing for that boolean to describe
  beyond "how much ETH has flowed into a pool that's been fully tradeable the whole time."

Net effect for a reimplementation: v1's "climbing toward graduation" language on the site is a
**progress bar over an already-complete listing**, not a bonding-curve mechanic. If the brief
that produced this task assumed a curve-and-migration model for the *whole* pons product, that
assumption is only true of the separate v2 protocol below.

## 5. v2 — the actual bonding curve, for contrast

Included because it is the part of pons that *does* match "bonding curve + graduation threshold,"
and a reimplementation should know pons operates both models under one brand.

- **Factory (live)**: `PonsV2LaunchFactory` at `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` — found
  by scanning the chain for the `TokenLaunched` event topic, *not* the address
  docs.ponsfamily.com/v2 lists (that one has never emitted an event and its `launchEnabled` is
  `false` — `backend/src/evm/v2/abi.js:3-14`, `backend/src/config.js` comment above
  `v2FactoryAddress`). Companion contracts: `PonsV2LaunchDeployer`
  (`0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42`), `PonsV2LaunchForwarder`
  (`0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`), and one `PonsV2BondingCurve` deployed per
  launch (`backend/src/evm/v2/abi.js:3-9`).
- **Curve mechanics**: a launch creates a curve holding the **whole token supply**, priced as a
  constant product (`x*y=k`) against a **phantom quote reserve** fixed by the launch config (live
  config #0: supply `1e9`, `phantomQuote` 1.68 ETH ⇒ `k = 1.68e9` from block one) —
  `shared/bundleShare.js:211-234`. Buys/sells are `curve.buy(quoteIn, minTokensOut, recipient)` /
  `curve.sell(tokensIn, minQuoteOut, recipient)` — `backend/src/evm/v2/abi.js:115-141`
  (`CURVE_V2_ABI`). Fees (curve fee + creator tax, both in the quote asset) come off a buy's
  *input*, not its output (`bundleShare.js:219-224`).
- **Snipe tax, not a wallet/tx cap**: every buy in the opening window pays a tax on the recipient
  starting at `snipeTaxStartBps` (99% live) and decaying exponentially to 0 over `snipeTaxSeconds`
  (3s live) — with up to 32 addresses (31 via the atomic-buy forwarder) exemptable at launch time,
  which the codebase calls "the sanctioned pathway for organized teams that bundle their opening
  buys across several wallets" (`backend/src/evm/v2/abi.js:20-30, 143-155`). This replaces v1's
  restriction-window wallet/tx caps entirely — v2 "has no restriction window and no caps"
  (`shared/bundleShare.js:553`).
- **Graduation is a real event here**: `graduationThreshold` is measured against **net quote
  raised** into the curve (excluding the phantom reserve and excluding fees already paid out) —
  `bundleShare.js:485-513`. `curve.readyToGraduate()` / `curve.graduated()` are live booleans the
  launcher polls and gates every trade path on (`backend/src/evm/v2/abi.js:129-131`;
  `backend/src/v3/engine.js:330-334`; `backend/src/routes/v3.js:103-111`;
  `backend/src/v3/exit.js:122-125`). Once graduated, **a new Uniswap v4 pool is created** and the
  token trades there instead — confirmed repeatedly in the operator-facing refusal messages the
  launcher raises when asked to trade a graduated token through the curve/V3 path, e.g.
  `backend/src/bundle/prepareSell.js:207`: *"has graduated to a Uniswap v4 pool — selling a
  graduated token is not yet [supported]"*; `backend/src/v3/exit.js:124`: *"a graduated token
  trades in a Uniswap v4 pool"*; `backend/src/evm/v2/abi.js:16-18`: *"a Uniswap v4 pool is only
  built at graduation."* The v4 swap route goes through Uniswap's `UniversalRouter`
  (`docs/superpowers/specs/2026-08-06-sell-all-notes.md:64`), which `pons-launcher` does not yet
  implement (v3/v4 trading of *graduated* v2 tokens is explicitly out of scope in this repo, per
  the refusal messages above).
- **Open question this repo does not resolve**: whether the v4 pool created at v2 graduation has
  its liquidity locked at all, and if so by what contract. Nothing in `evm/v2/*` or the v2 error
  list references a locker (compare v1's explicit `Locked`/custody NatSpec) — the closest hints
  are error names like `GraduationExecutorNotSet`, `GraduationRescueTooEarly(uint256 availableAt)`,
  `GraduationSeedNotViable`, `GraduationStillViable`, `WrongGraduationPhase`
  (`backend/src/evm/v2/abi.js:174-221`), which imply graduation is itself a multi-phase, possibly
  permissionlessly-rescuable process (a `GraduationRescueTooEarly` error strongly suggests *someone
  other than the protocol* can trigger/finish graduation after a timelock if the designated
  executor hasn't), but the actual v4-side locking behavior was not verified on-chain as part of
  this pass — flag for follow-up research if v2 is in scope for the rebuild.

## 6. Addresses reference (Robinhood Chain, chain id 4663)

| Contract | Address | Role | Source |
|---|---|---|---|
| `PonsLaunchFactory` (v1, live) | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | v1 launch entry point | `backend/src/config.js` (`factoryAddress` default); Blockscout verified |
| `PonsLaunchLocker` (v1, live) | `0x736D76699C26D0d966744cAe304C000d471f7F35` | Permanent V3 position custody + fee split | Blockscout verified; wired as immutable ctor arg on the factory above |
| Legacy locker | `0x31ca5E101941A93A7DD6d0497928700625CF54B5` | Superseded locker for an earlier factory | www.ponsfamily.com/contracts |
| Uniswap V3 factory (pons's configured one) | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | Pool creation for v1 launches | www.ponsfamily.com/contracts |
| `PonsV2LaunchFactory` (v2, live) | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | v2 launch entry point (bonding curve) | `backend/src/evm/v2/abi.js:5`, `backend/src/config.js` (`v2FactoryAddress` default) |
| `PonsV2LaunchDeployer` | `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` | Predicts/deploys v2 token+curve pairs | `backend/src/evm/v2/abi.js:6` |
| `PonsV2LaunchForwarder` | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | Atomic v2 launch+buy | `backend/src/evm/v2/abi.js:7` |
| Multicall3 | `0xca11bde05977b3631167028862be2a173976ca11` | Reading `block.number` (standard address) | `backend/src/config.js` |

Robinhood Chain: RPC `https://rpc.mainnet.chain.robinhood.com`, explorer
`https://robinhoodchain.blockscout.com`, chain id `4663` — `backend/src/config.js`. (Note: the
project's memory file `relay-rate-limit.md` separately records that this chain id's Relay
`/quote` endpoint rate-limits at ~5 requests per window per IP, unrelated to pool/locker
mechanics but relevant if any rebuild work touches cross-chain funding into this chain.)

## 7. Takeaways for the rebuild

1. **v1 = instant full-liquidity Uniswap V3 listing**, 1% fee tier, WETH-quoted, whole supply
   deposited as a one-sided position at a configured opening tick, locked into an immutable,
   no-withdraw locker contract in the same transaction that creates the token. If the new
   launchpad is meant to reproduce "what pons does," this — not a bonding curve — is the default
   model to build.
2. **Locking = permanent by construction, not by timelock.** The correct primitive to copy is
   "the locker contract has no function capable of moving the position's principal," not "the
   locker unlocks after N days." Fee collection (both a protocol share and a
   creator/deployer-redirectable share) is the only thing ever extracted from a locked position.
3. **"Graduation" in the v1 sense is cosmetic** — a progress threshold on paired WETH, purely for
   the UI, with an explicit "not a quality signal" disclaimer. Cheap to reproduce (a comparison
   against pool reserves) and carries no contract-level consequence.
4. If bonding-curve-style graduation (curve → new pool, trading changes) is actually wanted, that
   is pons's **separate v2 product**, not v1 — copy its shape (phantom-reserve constant product,
   net-raised graduation threshold, decaying snipe tax instead of wallet caps, migration to a new
   pool at graduation) rather than assuming it's a variant of the V3 flow above. Note pons's own
   v2 graduation destination is Uniswap **v4** (hook-based), a materially different integration
   surface (hooks, `UniversalRouter`) than v1's plain V3 `SwapRouter`/`NonfungiblePositionManager`
   calls.
5. Treat pons's own published docs/addresses as a starting point only — this research repeatedly
   found the *live, event-emitting* contracts to differ from what docs.ponsfamily.com names (v2
   factory address, and likely why a "legacy locker" exists at all). Verify anything address-shaped
   against on-chain activity before trusting it.

## Sources

**Local repo** (`d:\projects\pons-launcher`):
- `backend/src/evm/factory.js:1-5, 40-83, 98-117, 152-165, 171-220`
- `backend/src/evm/abi.js:1-88` (all structs/ABIs, `FACTORY_ABI`, `DEX_CONFIG`, `LAUNCH_CONFIG`,
  `LAUNCHED_TOKEN`, `SWAP_ROUTER_V3_ABI`, `SWAP_ROUTER_02_ABI`, `PONS_TOKEN_ABI`)
- `backend/src/evm/router.js:1-173`
- `backend/src/evm/pricing.js:1-93`
- `backend/src/evm/pricing.test.js:85, 99-100`
- `backend/src/evm/deploy.js:1-20` (compiler/deploy conventions, not pool-specific but confirms
  this repo does not deploy pons's own contracts)
- `backend/src/config.js` (`factoryAddress`, `v2FactoryAddress`, `chainId`, `rpcUrl`,
  `explorerUrl`, `multicallAddress`)
- `shared/bundleShare.js:1-654` (`openingPool`, `rateFromTick`, `capCheck`, `shareV1`, `shareV2`,
  `constantProductBuy`)
- `backend/src/evm/v2/abi.js:1-241` (all v2 structs/ABIs/errors)
- `backend/src/bundle/prepareSell.js:41, 167-207, 399-406`
- `backend/src/bundle/prepareV2.js:343-348, 380`
- `backend/src/routes/v3.js:17, 103-111, 248`
- `backend/src/v3/engine.js:30, 330-334`
- `backend/src/v3/exit.js:89, 122-125`
- `backend/src/v3/trade.js:108-127`
- `docs/superpowers/specs/2026-08-06-sell-all-design.md:43, 98, 109, 156`
- `docs/superpowers/specs/2026-08-06-sell-all-notes.md:30, 55, 64, 67`
- `docs/superpowers/specs/2026-07-25-pons-launcher-design.md:71`

**Web** (fetched 2026-08-22):
- https://docs.ponsfamily.com (redirects/mirrors to www.ponsfamily.com content) — pool creation,
  1% fee tier, WETH quote, "no bonding curve/no migration," graduation threshold (4.2 ETH
  default) and its "not a quality signal" disclaimer
- https://www.ponsfamily.com/contracts — Uniswap V3 factory address, active locker address,
  legacy locker address, 0.0005 ETH launch fee
- https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0x736D76699C26D0d966744cAe304C000d471f7F35
  — `PonsLaunchLocker` verified source: full NatSpec, function signatures
  (`lockPosition`, `collectFees`, `initialize`, `setFeeCollector`, `setFeeRedirect`,
  `setProtocolFeeRecipient`, `setProtocolFeeShare`, `getLaunchedToken`), state variables
  (`MAX_PROTOCOL_FEE_SHARE`, `protocolFeeShare`, `feeRedirects`, `feeCollectors`,
  `tokenProtocolFeeShares`, `deployerTokens`, `feeRecipientTokens`)
- https://robinhoodchain.blockscout.com/api/v2/addresses/0x736D76699C26D0d966744cAe304C000d471f7F35
  — contract tag "PonsLaunchLocker", creator address, creation tx hash, zero coin balance
- https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb
  — `PonsLaunchFactory` verified source: constructor args (`initialOwner`, `locker_`,
  `initialLaunchFee` = 500000000000000 wei), "one-sided Uniswap V3 liquidity positions" /
  "permanent position locking" summary
