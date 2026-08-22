# Pons Launch Factory — Reverse-Engineering Notes

Source of truth: the local `pons-launcher` repo at `d:\projects\pons-launcher`, which
talks to the **real, live, verified** `PonsLaunchFactory` (v1) and `PonsV2LaunchFactory`
(v2) contracts on Robinhood Chain (chain id `4663`). Nothing here is re-implemented —
pons-launcher is a client of ponsfamily.com's own contracts, so this document describes
those contracts as seen through that client. Cross-checked against `docs.ponsfamily.com`,
which the repo explicitly and repeatedly flags as **unreliable for addresses** (see
"Docs vs on-chain reality" below).

---

## 0. TL;DR — two unrelated protocols behind one brand

| | v1 | v2 |
|---|---|---|
| Model | Uniswap v3 pool at birth | Bonding curve at birth, Uniswap v4 pool at graduation |
| Factory address (live) | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Launch fn | `launchToken(TokenParams, uint256, uint256, bytes32) payable` | `launchToken(TokenParams, uint256, address, address[]) payable` (2 overloads) |
| Address prediction | `predictTokenAddress(...)` on the factory | `predictLaunchAddresses(...)` on a separate `PonsV2LaunchDeployer` |
| Dev buy | Uncapped, inside `launchToken` itself (`msg.value − launchFee`) | Via a separate `PonsV2LaunchForwarder.launchAndBuy` (factory itself takes fee **exactly**, no dev buy) |
| Anti-snipe mechanism | Per-address wallet/tx caps for `restrictionBlocks` blocks (factory's own buy exempt) | Exponentially decaying "snipe tax" (99%→0%) on the recipient, first N seconds; up to 32 declared exemptions |
| Launch fee (live) | read from `launchFee()`, docs say ~0.0005 ETH | read from `launchFee()` on the v2 factory |
| Liquidity | Locked automatically as part of the atomic launch | No pool until graduation; then a v4 position is created and sent to a permanent locker |
| Access gate | none observed / not gated in this client | `canLaunch(address)` / `launchEnabled()` / `whitelistedLaunchers(address)` — public launching was **closed** at time of writing pons-launcher's v2 support, later found open |

The two protocols are deliberately kept in **separate route trees, separate ABI
modules, separate prepare/fire modules** in pons-launcher (`bundle/prepare.js` +
`evm/factory.js` for v1; `bundle/prepareV2.js` + `evm/v2/factory.js` for v2). Do not
merge them when rebuilding — they do not share a contract, an ABI, or a launch
lifecycle.

---

## 1. v1 — `PonsLaunchFactory`

### 1.1 Address(es)

- **Live / active**: `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`
  (`backend/src/config.js:33`, lower-cased in code to
  `0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb`).
  Configurable via `FACTORY_ADDRESS` env var, defaulting to that address.
- Docs (`docs.ponsfamily.com`, fetched live) list the **same** address as "Active
  Factory (Current)" with **start block 8991118**, plus a **legacy v1** factory at
  `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` (start block 8600612) that pons-launcher's
  code does not reference at all — so there may have been an earlier v1 deployment
  before the one this client targets.
- Boot-time validation (`backend/src/evm/factory.js:198-207`, `validate()`) confirms
  the configured address has contract code, at least one enabled `LaunchConfig`, and at
  least one enabled `DexConfig` — comment notes "five [factory deployments] are
  verified on-chain," i.e. the factory has been redeployed multiple times historically.

### 1.2 `launchToken` — the launch function

ABI (transcribed from verified source, `backend/src/evm/abi.js:9-45`):

```solidity
function launchToken(
    TokenParams params,
    uint256 launchConfigId,
    uint256 dexId,
    bytes32 salt
) payable returns (address token)
```

Companion / read functions on the same factory:

```solidity
function predictTokenAddress(TokenParams params, uint256 launchConfigId, uint256 dexId, bytes32 salt, address tokenDeployer) view returns (address)
function getLaunchConfig(uint256 id) view returns (LaunchConfig)
function getDexConfig(uint256 id) view returns (DexConfig)
function getLaunchedToken(address token) view returns (LaunchedToken)
function launchConfigCount() view returns (uint256)
function dexConfigCount() view returns (uint256)
function launchFee() view returns (uint256)
```

### 1.3 `TokenParams` (positional tuple — order matters)

```solidity
struct Socials {
    string twitter;
    string telegram;
    string discord;
    string website;
    string farcaster;
}

struct TokenParams {
    string name;
    string symbol;
    string logo;          // ipfs:// URI, pinned via ponsfamily's own uploader — see §5
    string description;
    Socials socials;
    address feeWallet;    // zero address ⇒ launching wallet becomes initial-buy recipient
}
```
(`backend/src/evm/abi.js:7-12`; positional-tuple encoding, `backend/src/evm/factory.js:21-38`.)

The **logo cannot be empty**: pons-launcher rejects a launch client-side because an
empty logo is baked into the CREATE2 preimage forever
(`backend/src/bundle/prepare.js:59-61`).

### 1.4 Other launch-time parameters

- `launchConfigId` (uint256) — index into `getLaunchConfig`, selects supply, pair
  token, price, restriction caps.
- `dexId` (uint256) — index into `getDexConfig`, selects the Uniswap-v3-shaped venue
  (factory address, position manager, swap router, pool fee, tick spacing).
- `salt` (bytes32) — arbitrary; feeds the CREATE2 address derivation, which is why
  `predictTokenAddress` can return the deploy-time token address *before* the
  transaction is sent (`backend/src/evm/factory.js:171-180`). pons-launcher generates
  it randomly per launch (`backend/src/bundle/prepare.js:26-28`, `randomSalt()`).
- `msg.value` — **must equal `launchFee + initialBuyAmount`** exactly. Everything
  above `launchFee` becomes the atomic dev buy (README.md:23-26, quoting the factory's
  own doc comment: *"Atomically deploys, pools, locks, records, and optionally buys a
  token."*).

### 1.5 `LaunchConfig` struct

```solidity
struct LaunchConfig {
    address pairToken;           // e.g. WETH
    uint256 graduationThreshold; // present in v1 struct too, though v1 has no curve
    int24   initialTick;         // opening price, Uniswap-tick-encoded
    uint256 supply;              // total token supply minted
    uint16  maxWalletBps;        // cap on any address's holding during the restriction window
    uint16  maxTxBps;            // cap on a single buy during the restriction window
    uint32  restrictionBlocks;   // how many blocks the caps apply for
    uint24  reservedFee;         // (not further interpreted client-side)
    bool    enabled;
    bool    routerRequiresDeadline; // selects which of two SwapRouter ABI shapes to use
}
```
(`backend/src/evm/abi.js:14-19`, read/decoded in `backend/src/evm/factory.js:134-150`.)

Live values observed 2026-07-25 (README.md:41-46):

| | |
|---|---|
| max wallet | 500 bps = **5%** of supply |
| cumulative buy cap (maxTxBps) | 550 bps = **5.5%** of supply |
| restriction window | **2 blocks** |
| exempt from the cap | the atomic dev buy only (launch block) |

The cap is **not a clamp** — a buy over `maxWalletBps`/`maxTxBps` **reverts** rather
than filling partially (README.md:44-45; enforced by
`shared/bundleShare.js:158-173`, `capCheck`, used both for the live console warning and
inside `prepare()`, `backend/src/bundle/prepare.js:188-196`).

### 1.6 `DexConfig` struct

```solidity
struct DexConfig {
    string  name;
    address factory;          // Uniswap-v3-shaped pool factory
    address positionManager;  // NFT position manager (the LP-lock target)
    address swapRouter;       // SwapRouter or SwapRouter02 — shape picked by routerRequiresDeadline
    uint24  poolFee;          // e.g. 10000 = 1%
    int24   tickSpacing;
    bool    enabled;
}
```
(`backend/src/evm/abi.js:22-24`, decoded in `backend/src/evm/factory.js:120-132`.)
Docs confirm: *"Each token trades against WETH in a dedicated Uniswap V3 pool with 1%
fee (10000 basis points)."*

Two swap-router ABI shapes exist and the factory itself switches between them
per-`LaunchConfig` via `routerRequiresDeadline` (`backend/src/evm/abi.js:47-64`,
mirrored client-side in `backend/src/evm/router.js:20-24`):

```solidity
// routerRequiresDeadline == true  (older "SwapRouter")
function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)

// routerRequiresDeadline == false ("SwapRouter02")
function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)

// both shapes also carry:
function multicall(bytes[] data) payable returns (bytes[] results)
function unwrapWETH9(uint256 amountMinimum, address recipient) payable
```
Both shapes additionally disagree on the sentinel meaning "recipient = this router":
`SwapRouter02` uses `address(2)` and treats `address(0)` as a *real* recipient, while
the older deadline-taking router maps `address(0)` to itself — passing `address(0)` to
the wrong one reverts with `"TF"` (`backend/src/evm/router.js:94-101`, verified against
the live router by overriding the allowance and calling it).

### 1.7 What one `launchToken()` call atomically does

Per the factory's own doc comment, quoted in README.md:23-24: **"Atomically deploys,
pools, locks, records, and optionally buys a token."** Concretely, in one transaction:

1. Deploys the ERC-20 token (`PonsLauncherToken`) via CREATE2, seeded by
   `(TokenParams, launchConfigId, dexId, salt, deployer)` — this is exactly the
   preimage `predictTokenAddress` computes off-chain.
2. Creates a Uniswap-v3-shaped pool for `token` / `dexConfig.pairToken` at
   `dexConfig.poolFee`, opened at `launchConfig.initialTick`.
3. Mints `launchConfig.supply` tokens and provides them as liquidity into that pool
   (full-range or otherwise — pons-launcher treats the resulting pool as a plain v3
   constant-product-like venue when pricing, see `shared/bundleShare.js:176-209`).
4. **Locks** the LP position (docs: *"the pool's liquidity is locked automatically"*).
   The `LaunchedToken` record (§1.8) carries a `positionManager` and `positionId`,
   consistent with the LP NFT being minted to/held by a lock mechanism rather than the
   deployer.
5. Records the launch in the factory's own `getLaunchedToken(token)` mapping — see §1.8,
   this is the **authoritative provenance record**, deliberately preferred over the
   token's own self-reported `deployer()`/`launchFactory()` getters
   (`backend/src/evm/factory.js:90-96`: *"a dusted ERC-20 can claim whatever it likes
   about itself"*).
6. **Optionally buys**: any `msg.value` above `launchFee` is swapped, atomically, inside
   the same transaction, through the DEX config's own router — recipient is
   `feeWallet` if set, otherwise the launching wallet
   (`backend/src/evm/factory.js:36`: *"a blank feeWallet becomes the zero address,
   which makes the launching wallet the initial-buy recipient"*).
7. Enforces the launch-window restriction: every pool→user buy other than the
   factory's own atomic initial buy **reverts** with `LaunchBlockBuyBlocked` if it
   lands in the same EVM block as the launch — not merely capped, outright blocked
   (`backend/src/bundle/fire.js:9-16`, discovered by observing the pool's
   `TransferHelper` mask the true reason as `"TF"`).
8. After the launch block, for `restrictionBlocks` further blocks, every other address
   is capped at `maxWalletBps`/`maxTxBps` of supply (§1.5), reverting rather than
   clamping over the cap.

Deployed token getters (used for post-launch reads,
`backend/src/evm/abi.js:67-76`, `PONS_TOKEN_ABI`):

```solidity
function launchFactory() view returns (address)
function liquidityPool() view returns (address)
function pairToken() view returns (address)
function poolFee() view returns (uint24)
function deployer() view returns (address)
function restrictionEndBlock() view returns (uint256)
function maxWalletLimit() view returns (uint256)
function maxTxLimit() view returns (uint256)
```
Explicitly **not trusted** for provenance/authorization decisions — self-reported by a
contract that could be a hostile dusting attempt (`backend/src/evm/factory.js:90-96`).

### 1.8 `LaunchedToken` record (factory's own bookkeeping — the authority)

```solidity
struct LaunchedToken {
    address token;
    address deployer;
    address pairedToken;
    address positionManager;
    uint256 positionId;
    uint256 dexId;
    uint256 launchConfigId;
    uint256 restrictionsEndBlock;
    uint256 supply;
    bool    isToken0;
    uint24  poolFee;
    bool    exists;
    uint256 initialBuyAmount;
}
```
(`backend/src/evm/abi.js:26-34`.) Read via `getLaunchedToken(address token)`.
`exists == false` means the factory has never heard of the token — treated as reason
enough to refuse a sell (`backend/src/evm/factory.js:98-117`). The v1 sell path gates
on this record and nothing else, in particular never on the token's own
`launchFactory()`/`deployer()` getters.

### 1.9 Events

**No `TokenLaunched` (or any) event ABI is declared for v1 in this codebase** —
`FACTORY_ABI` (`backend/src/evm/abi.js:36-45`) is functions-only, and
`backend/src/bundle/fire.js` confirms a v1 launch purely by receipt status
(`launchReceipt.status === 1`), never by parsing a log. The docs, however, describe one:

> **TokenLaunched Event** — Topic0: `0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a`
> (note: this hex string is 65 chars after `0x`, one nibble too long for a real
> 32-byte topic — likely a scraping artifact from the docs fetch; **re-derive the real
> topic0 from the verified factory source on the target chain's explorer rather than
> trusting this string verbatim**)
> Emitted parameters: `token, deployer, dexFactory, pairToken, pool, dexId,
> launchConfigId, positionId, restrictionsEndBlock, initialBuyAmount`

Indexed-ness of those fields is **not** stated by the docs and not present anywhere in
the local repo — when rebuilding, pull the verified v1 factory source from the chain
explorer (Robinhood Chain: `https://robinhoodchain.blockscout.com`) and read the event
signature directly rather than trusting either source here. Given the sell-side design
notes for v2 use `deployer` as an indexed filter topic (see `TokenLaunched` in v2,
§2.6), it would be consistent for v1's event to index `deployer` too, but this is
**inference, not observation** — flag as unverified.

### 1.10 Access control / `canLaunch()` semantics (v1)

No `canLaunch()`, `launchEnabled()`, or whitelist gating is read or referenced
anywhere in the v1 client code path (`evm/factory.js`, `bundle/prepare.js`,
`routes/launch.js`). pons-launcher's v1 integration launches directly with no
preflight gate beyond "config enabled" and balance/gas checks. This suggests v1's
`PonsLaunchFactory` either has no launcher whitelist or has always been in a fully
public-launch state for the wallets pons-launcher used — **not confirmed from the v1
factory source itself, since this repo never needed to read such a gate.** When
rebuilding, check the verified v1 source directly for the equivalent of v2's
`canLaunch`/`whitelistedLaunchers`/`launchEnabled`.

One access-control fact that **is** load-bearing operationally: **the launch must be
sent directly by the wallet meant to be `deployer`.** *"The factory records `deployer =
msg.sender`, and only the deployer can later claim creator fees — route it through a
helper contract and [a fee-claim tool] could never claim them."* (README.md:121-124.)
This is why pons-launcher signs and broadcasts the launch transaction from the dev
wallet itself rather than through any relaying/forwarder contract on v1.

### 1.11 Fee (v1)

- Read live from `launchFee()` (never hardcoded) — `backend/src/evm/factory.js:46`,
  `backend/src/evm/abi.js:44`.
- Docs (fetched live): **"A small 0.0005 ETH launch fee" applies to all launches** — no
  further payment-mechanism detail given beyond that it's part of `msg.value`.
- Paid as native chain-coin `msg.value` alongside the (optional) dev buy:
  `launchValue = launchFee + devBuyWei` (`backend/src/bundle/prepare.js:102-104`).
- Fee split, per docs: **Active factory: creator 70% / protocol 30%. Legacy factory:
  creator 90% / protocol 10%.** (Not independently confirmed from source in this repo;
  the local client never reads or needs the split, only the total `launchFee`.)

---

## 2. v2 — `PonsV2LaunchFactory`

v2 is explicitly **"a different protocol, not a newer factory"**
(`backend/src/config.js:37`) and **"a different protocol on a different factory"**
(README.md:182). It has its own routes (`/api/v2/*`), own prepare/fire modules
(`bundle/prepareV2.js`, `bundle/fireV2.js`), and own ABI module (`evm/v2/abi.js`).

### 2.1 Address(es) — and a real docs-vs-chain discrepancy

- **Live, used by pons-launcher**: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
  (`backend/src/config.js:45`, `backend/src/evm/v2/abi.js:6`). Comment: *"LIVE:
  thousands of launches, launchEnabled true, and canLaunch() true for ordinary
  wallets... found by scanning the chain for the TokenLaunched topic rather than
  trusting the docs."*
- The repo repeatedly asserts docs.ponsfamily.com/v2 points at a **different,
  superseded** address that "has never emitted an event" and whose `launchEnabled` is
  `false` (`backend/src/config.js:42-44`, `backend/src/evm/v2/abi.js:10-14`,
  README.md:182-186).
- **However**, fetching `docs.ponsfamily.com/v2` live (2026-08-22, for this document)
  returned `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` — the **same** address the repo
  calls "the live one," not the "superseded" one the repo's comments describe. Two
  explanations are possible: (a) ponsfamily updated their docs after pons-launcher's
  comments were written, or (b) the docs snapshot differs by fetch method/caching.
  **Treat the address match as encouraging but not certain — re-verify the currently
  live factory address on-chain (scan for `TokenLaunched`, check `launchEnabled()` and
  `canLaunch()` on whatever address is configured) before trusting either source
  blindly**, exactly as this repo's own operating principle demands
  (`backend/src/config.js:42-44`).
- Companion verified contracts (`backend/src/evm/v2/abi.js:5-8`):
  - `PonsV2LaunchFactory` — `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
  - `PonsV2LaunchDeployer` — `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42`
  - `PonsV2LaunchForwarder` — `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`
  - `PonsV2BondingCurve` — one freshly deployed per launch (no fixed address)

### 2.2 `launchToken` — two overloads

```solidity
function launchToken(
    TokenParams params,
    uint256 launchConfigId,
    address pairToken
) payable returns (address token, address curve)

function launchToken(
    TokenParams params,
    uint256 launchConfigId,
    address pairToken,
    address[] snipeTaxExemptions   // up to 32 addresses
) payable returns (address token, address curve)
```
(`backend/src/evm/v2/abi.js:64-66`.) `pairToken == address(0)` means native ETH as the
quote asset. `value` must be **exactly** `launchFee` — the factory reverts
`LaunchFeeNotPaid()` on anything else (`backend/src/evm/v2/factory.js:274-275`
docstring); there is **no dev-buy path through the factory itself** (see §2.3).

`TokenParams` for v2 (positional tuple, note the additions vs. v1 —
`backend/src/evm/v2/abi.js:32-42`):

```solidity
struct TokenParams {
    string  name;
    string  symbol;
    string  logo;
    string  description;
    Socials socials;                 // same 5-field struct as v1
    address creatorFeeRecipient;      // zero ⇒ factory substitutes the launcher
    uint16  creatorTaxBps;            // creator-configurable tax, capped by maxCreatorTaxBps()
    bool    buybackEnabled;
    bytes32 expectedEconomics;        // only enforced by the factory when non-zero; pons-launcher always sends the zero bytes32
    bytes32 salt;                     // NEW vs. the version pons-launcher first targeted — makes token/curve addresses predictable pre-launch
}
```

### 2.3 Atomic launch + dev buy: the `PonsV2LaunchForwarder`

Because the bare factory only accepts `value == launchFee` exactly, an atomic dev buy
goes through a **separate forwarder contract**, not the factory
(`backend/src/evm/v2/factory.js:288-319`):

```solidity
function launchAndBuy(
    TokenParams params,
    uint256 launchConfigId,
    address pairToken,
    uint256 quoteIn,
    uint256 minTokensOut,
    address recipient,
    address[] snipeTaxExemptions
) payable returns (address token, address curve, uint256 tokensOut)
```
`value` must be `launchFee + quoteIn`. This is **"the v2 shape of v1's uncapped dev
buy": the dev's tokens are bought inside the launch, so nothing can be in front of
them"** (`backend/src/evm/v2/factory.js:287-291`).

**Important asymmetry**: `launchAndBuy` appends its own buy `recipient` to the
exemption list before forwarding to the factory, so the caller-supplied exemption list
can be **at most 31**, not 32, when going through the forwarder — the factory's own
cap (32) is one higher than what a dev-buy launch can actually use
(`backend/src/evm/v2/abi.js:143-155`, verified against the live contracts: "factory-
direct takes 32 and reverts at 33; launchAndBuy takes 31 and reverts at 32").

### 2.4 Address prediction — `PonsV2LaunchDeployer`

```solidity
function predictLaunchAddresses(LaunchDeployment params) view returns (address token, address curve)
function factory() view returns (address)
```
`LaunchDeployment` is the fully-expanded struct the factory internally builds before
handing it to the deployer — pons-launcher rebuilds it client-side field-for-field
(`backend/src/evm/v2/factory.js:184-244`, `predictAddresses()`) from:
- the caller's `TokenParams` (minus decoration),
- the selected `LaunchConfig` (`supply`, `curveFeeBps`, `phantomQuote` or, for a
  non-native pair, `pairTokenEconomics(pairToken)`'s `phantomQuote`/`graduationThreshold`),
- a `FeePolicySnapshot` read live from the "meme hook" contract's
  `currentFeePolicy()`,
- wiring addresses read from the factory itself: `launchDeployer()`,
  `launchForwarder()`, `feeEscrow()`, `buybackVault()`, `memeHook()`.

```solidity
struct FeePolicySnapshot {
    address protocolFeeRecipient;
    uint16  protocolFeeShareBps;
    uint16  buybackBurnBps;
    uint16  hookFeeBps;
    uint16  maxInternalPriceImpactBps;
}

struct LaunchDeployment {
    address pairToken;
    address creatorFeeRecipient;
    address originalDeployer;
    address feePolicy;             // == memeHook address
    FeePolicySnapshot policy;
    address feeEscrow;
    address buybackVault;
    uint256 phantomQuote;
    uint256 curveFeeBps;
    uint256 creatorTaxBps;
    bool    buybackEnabled;
    uint256 graduationThreshold;
    uint256 supply;
    bytes32 salt;
    string  name;
    string  symbol;
    string  logo;
    string  description;
    Socials socials;
}
```
(`backend/src/evm/v2/abi.js:44-62`.)

**Prediction is never trusted alone.** pons-launcher additionally runs the *real*
`launchToken` call as a zero-cost `eth_call` static simulation
(`backend/src/evm/v2/factory.js:253-268`, `simulateLaunch()`) and requires the two
derivations to agree bit-for-bit before signing any bundle buy
(`backend/src/bundle/prepareV2.js:189-206`): *"a buy sent to an address with no
contract SUCCEEDS on the EVM and silently keeps the money"* — and this actually
happened once, stranding 1.798 ETH on 2026-08-13 before the double-check was added
(`backend/src/bundle/prepareV2.js:41-52`, `backend/src/evm/v2/factory.js:19-20`).

### 2.5 `LaunchConfig` (v2) and gating reads

```solidity
struct LaunchConfig {
    uint256 supply;
    uint256 curveFeeBps;
    uint256 phantomQuote;           // synthetic reserve fixing the opening price with no real deposit
    uint256 graduationThreshold;    // in the pair asset's own units/decimals
    uint24  poolFee;                // fee tier of the v4 pool created at graduation
    int24   tickSpacing;
    bool    enabled;
}
```
(`backend/src/evm/v2/abi.js:44-46`, read via `getLaunchConfig(id)`.)

Factory-level reads pons-launcher relies on
(`backend/src/evm/v2/abi.js:68-96`, `factory.js:82-124,135-174`):

```solidity
function canLaunch(address launcher) view returns (bool)
function launchEnabled() view returns (bool)
function whitelistedLaunchers(address launcher) view returns (bool)   // one INPUT to canLaunch, not the whole answer
function launchFee() view returns (uint256)
function launchConfigCount() view returns (uint256)
function approvedPairTokens(address pairToken) view returns (bool)
function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)
function maxCreatorTaxBps() view returns (uint256)
function launchDeployer() view returns (address)
function launchForwarder() view returns (address)
function feeEscrow() view returns (address)
function buybackVault() view returns (address)
function memeHook() view returns (address)
function snipeTaxStartBps() view returns (uint256)
function snipeTaxSeconds() view returns (uint256)
```

### 2.6 `getLaunchedToken` and `TokenLaunched` (v2 — well-defined, with source)

```solidity
function getLaunchedToken(address token) view returns (
    address token,
    address curve,
    address deployer,
    address creatorFeeRecipient,
    address pairToken,
    uint256 graduationThreshold,
    uint24  poolFee,
    int24   tickSpacing,
    uint16  creatorTaxBps,
    bool    buybackEnabled,
    uint8   phase,           // enum; pons-launcher reads it as a bare number (see below)
    uint256 sweptQuote,
    uint256 sweptTokens,
    uint256 sweptAt,
    bool    exists
)
```
(`backend/src/evm/v2/abi.js:93`.) `phase` is read raw as `Number(rec.phase)`
(`backend/src/evm/v2/holdings.js:385`) — pons-launcher does **not** decode it into a
named enum locally; treat "curve" vs. "graduated" as the two states of interest and
confirm the exact enum ordinal meanings against the verified v2 factory source when
rebuilding (likely something like `Curve=0`/`Graduating=1`/`Graduated=2`, but
**unverified** here).

```solidity
event TokenLaunched(
    address indexed token,
    address indexed curve,
    address indexed deployer,
    address pairToken,
    uint256 launchConfigId,
    uint256 graduationThreshold
)
```
(`backend/src/evm/v2/abi.js:95` — **verified, full signature, transcribed from source**,
unlike v1's event which is docs-only and suspect.) Three indexed topics: `token`,
`curve`, `deployer`. This is what makes *"one `getLogs` [call] enumerate every token a
dev wallet ever launched"* by filtering on the indexed `deployer` topic
(`docs/superpowers/specs/2026-08-06-sell-all-notes.md:25-27`,
`backend/src/evm/v2/holdings.js:286`, `encodeFilterTopics('TokenLaunched', [null, null,
getAddress(deployer)])`). This event is used both as the parse target after firing a
launch (`backend/src/evm/v2/factory.js:345-366`, `parseLaunch()`) and as the discovery
mechanism for "every token this wallet ever launched," including launches made outside
pons-launcher entirely.

### 2.7 Snipe tax (v2's anti-bot mechanism, replacing v1's hard block+cap)

*"Every buy in the opening window pays a tax starting at `snipeTaxStartBps` (99% live)
and decaying exponentially to zero across `snipeTaxSeconds` (3 live, though the docs
fetch above says 5 seconds decaying to ~25% at 1s / ~3% at 2s — **treat the exact decay
curve and window length as needing on-chain re-verification, the repo comment and the
docs fetch disagree on the window**). It is charged on the RECIPIENT, not the buyer.*"
(`backend/src/evm/v2/abi.js:22-30`.)

- `launchToken`/`launchAndBuy` take up to `MAX_SNIPE_TAX_EXEMPTIONS = 32` addresses
  (31 via the forwarder, see §2.3) exempt from the tax, applied **atomically inside the
  launch**. The verified source's own comment, quoted in the ABI file, calls this *"the
  sanctioned pathway for organized teams that bundle their opening buys across several
  wallets."* So on v2 **the bundle does not race anyone — it is declared**
  (`backend/src/evm/v2/abi.js:30`, README.md:196-200).
- The dev wallet and the `creatorFeeRecipient` are exempted by the factory itself and
  need not be declared (`backend/src/bundle/prepareV2.js:163-166`).
- Curve-side reads for the tax (`CURVE_V2_ABI`, `backend/src/evm/v2/abi.js:115-141`):
  `snipeTaxExempt(address)`, `currentSnipeTaxBps(address recipient)`,
  `snipeTaxStartBps()`, `snipeTaxSeconds()`.

### 2.8 The bonding curve itself (`PonsV2BondingCurve`)

One deployed per launch, holding the entire supply from birth. Read/interact surface
(`backend/src/evm/v2/abi.js:115-141`, `backend/src/evm/v2/curve.js`):

```solidity
function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)
function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)
function isNativeQuote() view returns (bool)
function pairToken() view returns (address)
function token() view returns (address)
function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)
function quoteReserve() view returns (uint256)
function tokenReserve() view returns (uint256)
function realQuoteReserve() view returns (uint256)
function phantomQuote() view returns (uint256)
function sellableTokens() view returns (uint256)
function reservedTokens() view returns (uint256)
function graduationThreshold() view returns (uint256)
function readyToGraduate() view returns (bool)
function graduated() view returns (bool)
function feeBps() view returns (uint256)
function creatorTaxBps() view returns (uint256)
```

Pricing model: **constant product** (`x*y=k`) against a **phantom quote reserve** —
i.e. the config supplies a synthetic starting reserve (`phantomQuote`) so the opening
price is fixed with no real deposit needed. Config #0 live: `supply = 1e9` tokens,
`phantomQuote = 1.68 ETH` ⇒ `k = 1.68e9` from block one
(`shared/bundleShare.js:214-217`). Fees (curve fee + creator tax, both in bps) are taken
off the **quote leg on a buy** (i.e., off the input) — confirmed against two live
curves to the wei (`shared/bundleShare.js:219-224`). A native-quote launch sends
`quoteIn` as `msg.value`; an ERC-20 pair must `approve` the curve first
(`backend/src/evm/v2/curve.js:26-34`).

**Graduation**: happens **on the way the curve sells out**, i.e. once the curve's
tradeable/"sellable" allocation is exhausted / `raised >= graduationThreshold` — at that
point a **Uniswap v4 position is created and transferred to a permanent locker** (docs:
*"triggering creation of a full-range Uniswap v4 position that transfers immediately to
a permanent locker"*). This is a hard state transition: *"Graduating on the way IN is
the one state a bundle cannot sell out of through the curve"*
(`backend/src/bundle/prepareV2.js:341-350`) — a bundle whose buys push `raised` at or
past the threshold graduates mid-bundle and cannot be exited back through the curve.

### 2.9 Access control / `canLaunch()` semantics (v2) — the key gotcha

*"canLaunch() is the gate the factory itself uses. Reading `whitelistedLaunchers`
instead reports false for a wallet that can launch perfectly well — that mapping is
only one input to `canLaunch`, and taking it for the answer is what made this project
believe v2 was closed while thousands of launches went through it."*
(`backend/src/evm/v2/factory.js:126-134`.)

```solidity
function canLaunch(address launcher) view returns (bool)   // ← THE gate; check this, never whitelistedLaunchers alone
function launchEnabled() view returns (bool)                // global "is public launching on" switch
function whitelistedLaunchers(address launcher) view returns (bool)  // one input among several to canLaunch's internal logic
```

pons-launcher's server refuses to spend the launch fee unless
`plan.canLaunch === true` (`backend/src/routes/launch.js:208-213`), reading the result
of `preflightGate()` which calls `canLaunch(dev.address)` directly
(`backend/src/evm/v2/factory.js:135-155`). It also checks `approvedPairTokens(pair)`
for any non-native pair token — **native ETH (`address(0)`) is never checked against
that mapping; the factory skips that branch entirely for the zero address**
(`backend/src/evm/v2/factory.js:149-151`).

Per the docs fetch: *"During v2's initial phase, public launches are closed"* —
consistent with a permissioned launch phase gated by `whitelistedLaunchers` while
`launchEnabled()` was false, later opened (repo comments say it was later found `true`
for ordinary wallets).

### 2.10 Fee (v2)

- Read live from `launchFee()` on the v2 factory (`backend/src/evm/v2/factory.js:86`).
- Paid as native `msg.value`, **exactly equal to `launchFee`** through the bare
  factory (`LaunchFeeNotPaid()` on any mismatch), or `launchFee + quoteIn` through the
  forwarder for an atomic dev buy (§2.3).

### 2.11 Custom errors (verified, full list)

Transcribed from the four verified v2 contracts (factory, forwarder, deployer, curve)
so that a revert selector can be named instead of shown as raw bytes
(`backend/src/evm/v2/abi.js:163-224`, `explainRevert()` at
`backend/src/evm/v2/factory.js:49-69`):

```
AlreadySet() · CombinedFeeTooHigh() · CoreLpFeeMustBeZero() · Create2EmptyBytecode()
CreatorTaxTooHigh() · CurveFeeTooHigh() · CurveNotQuotable() · ExemptionListTooLong()
FailedDeployment() · FeeTransferFailed() · GraduationExecutorNotSet()
GraduationRescueTooEarly(uint256 availableAt) · GraduationSeedNotViable()
GraduationStillViable() · InexactTransfer(address token, uint256 expected, uint256 received)
InsufficientBalance(uint256 balance, uint256 needed) · InvalidBasisPoints()
InvalidGraduationThreshold() · InvalidLaunchConfigId() · InvalidPhantomQuote()
InvalidSnipeTaxWindow() · InvalidTickSpacing() · InvalidTokenParams()
LaunchConfigDisabled() · LaunchDependenciesNotWired() · LaunchDeployerNotSet()
LaunchEconomicsMismatch(bytes32 expected, bytes32 actual) · LaunchFeeNotPaid()
MetadataTooLong() · NativeValueMismatch(uint256 sent, uint256 expected)
NoPendingChange() · NotApprovedLauncher() · NotBuybackController()
NotCreatorFeeRecipient() · NotFactory() · NotLaunchForwarder() · NotReadyToGraduate()
NotWhitelisted() · NothingToGraduate() · OwnableInvalidOwner(address owner)
OwnableUnauthorizedAccount(address account) · OwnershipCannotBeRenounced()
PairTokenDecimalsMismatch(uint8 expected, uint8 actual) · PairTokenDecimalsUnavailable()
PairTokenEconomicsInvalid() · PairTokenNotApproved() · PairTokenValidationFailed()
ReentrancyGuardReentrantCall() · RefundFailed() · SafeERC20FailedOperation(address token)
SqrtPriceOutOfBounds() · SupplyTooHigh() · SupplyTooLow()
TimelockExpired(uint256 expiresAt) · TimelockNotElapsed(uint256 effectiveAt)
TokenNotFound() · UnsupportedPrice() · WrongGraduationPhase() · ZeroAddress() · ZeroAmount()
```

These names alone are informative about the factory's internal machinery: e.g.
`GraduationRescueTooEarly`/`GraduationSeedNotViable`/`GraduationStillViable`/
`NothingToGraduate`/`WrongGraduationPhase` imply a multi-step graduation state machine
with a possible manual "rescue" path; `TimelockExpired`/`TimelockNotElapsed` imply
owner-configurable parameters are behind a timelock; `NotBuybackController`/
`CoreLpFeeMustBeZero` imply a buyback subsystem with its own privileged caller.

---

## 3. Local `contracts/*.sol` — NOT the launch factory

The only Solidity in this repo (`contracts/Disperse.sol`, `contracts/BundleDistributor.sol`)
are **pons-launcher's own auxiliary contracts**, unrelated to ponsfamily's factory:

- `Disperse.sol` — a fan-out payment helper: batches funding N bundle wallets from one
  dev-wallet transaction instead of N concurrent broadcasts, to avoid RPC rate-limit
  failures (README.md:144-178). No owner; deploying it grants no privileged control,
  but the deployer address is permanently linked on-chain to every wallet it funds.
  Deployed/compiled via `backend/src/evm/deploy.js` (solc, optimizer `{enabled: true,
  runs: 200}`, pinned for explorer-verification reproducibility,
  `backend/src/evm/deploy.js:21-24`).
- `BundleDistributor.sol` — not read in this pass; likely a related batch-send helper
  for the bundle wallets (same deploy path as `Disperse.sol`). Re-read directly if the
  new project needs a disperse/distributor contract of its own.

**Neither file is, or interacts with the ABI of, `PonsLaunchFactory` or
`PonsV2LaunchFactory`.** The factory contracts live entirely off-chain-from-this-repo's-
perspective — pons-launcher only holds their ABIs and addresses, never their source.

---

## 4. `backend/src/routes/launch.js` — how the factory is exposed over HTTP

- `GET /api/configs` → `factory.getConfigs()`: every `LaunchConfig`, every `DexConfig`,
  and the live `launchFee`, plus `factory` address and `chainId`
  (`backend/src/routes/launch.js:112-119`).
- `POST /api/logo` → proxies an image upload to ponsfamily's own IPFS pinning worker
  (see §5), returning the `ipfs://` URI to put in `params.logo`.
- `POST /api/preflight` → `prepare()` (build + sign the **entire** bundle, broadcast
  nothing) — the "rehearsal."
- `POST /api/launch` → `prepare()` then `fire()` — actually broadcasts. Gated by
  `withLaunchLock`, an in-memory per-account mutex: *"Two launches overlapping would
  read the same pending nonce for the shared dev wallet and sign two different
  launches... against it"* (`backend/src/routes/launch.js:23-30`).
- `publicPlan()` strips every raw signed transaction before the plan is returned to the
  client — *"anyone holding a raw signed buy could broadcast it, so it never leaves the
  server"* (`backend/src/routes/launch.js:50-60`).
- v2 mirror: `GET /api/v2/configs`, `POST /api/v2/preflight`, `POST /api/v2/launch`
  (the latter additionally throws before broadcasting if `plan.canLaunch` or
  `plan.pairApproved` is false — see §2.9).
- `GET /api/launches` — history, filtered by `variant` (v1/v2/v3/seasoning tabs each
  have an isolated wallet set and read only their own launch history,
  `backend/src/routes/launch.js:226-238`).

---

## 5. Off-chain adjuncts the launch depends on

- **Logo pinning**: pons-launcher proxies to ponsfamily's own (undocumented) IPFS
  upload worker, `https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image`
  — *"the same endpoint their /launchpad/create form posts to, so our tokens carry the
  same kind of ipfs:// logo as a launch made from their site"*
  (`backend/src/config.js:154-159`). Requires spoofing an `Origin: https://www.ponsfamily.com`
  header, because the worker's CORS allowlists that origin and a server-side fetch
  sends none by default (`backend/src/config.js:165-168`).
- **Reading logos back**: `https://gateway.pinata.cloud/ipfs/` (configurable,
  `backend/src/config.js:161-164`), console preview only.

---

## 6. Docs vs. on-chain reality — a standing warning worth preserving

The repo's own operating stance, stated in three separate places
(`backend/src/config.js:42-44`, `backend/src/evm/v2/abi.js:10-14`, README.md:180-186),
is that **`docs.ponsfamily.com` cannot be trusted for contract addresses** — it was
found pointing at a v2 factory deployment that had *never emitted a single event* and
had `launchEnabled() == false`, while the real, actively-used factory (found only by
scanning the chain for the `TokenLaunched` event topic) had thousands of launches.

When this document's own live fetch of `docs.ponsfamily.com/v2` returned the **same**
address the repo calls "the live one" (§2.1), that is either good news (docs caught up)
or a coincidence not worth resting on. **The actionable rule for the new project is
unchanged: always verify a factory address by (a) confirming it has deployed code, (b)
confirming `launchEnabled()`/equivalent is true and `canLaunch()` is true for a test
wallet, and (c) scanning for at least one recent `TokenLaunched` event — never by
trusting a docs page alone.**

### Docs summary (fetched live, 2026-08-22)

- **v1 "Active Factory (Current)"**: `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`,
  start block 8991118 — **matches** the repo's configured live address.
- **v1 "Legacy Factory"**: `0x0c37a24F5D23A486FA692d1500881d698B1F77a4`, start block
  8600612 — not referenced anywhere in this repo; an older v1 deployment.
- **v1 fee split**: Active 70/30 (creator/protocol), Legacy 90/10.
- **v1 launch fee**: "a small 0.0005 ETH."
- **v2 factory** per docs: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` — see the
  discrepancy note in §2.1.
- **v2 snipe tax decay** per docs: 99% → ~25% at 1s → ~3% at 2s, over a **5-second**
  window — the repo's code comments instead say **3 seconds** live
  (`backend/src/evm/v2/abi.js:24`, "snipeTaxSeconds (3 live)"). **This is a real
  disagreement between two sources describing the same live constant; read
  `snipeTaxSeconds()` directly off the configured factory when rebuilding rather than
  hardcoding either number.**
- **v2 graduation**: docs confirm graduation triggers "creation of a full-range Uniswap
  v4 position that transfers immediately to a permanent locker" — the repo's own
  comments only ever say "Uniswap v4 pool... built at graduation" without naming the v4
  specifics; docs are the more detailed source here and are consistent with the repo.
- Docs' `TokenLaunched` topic0 for v1 is malformed (65 hex chars) — do not use verbatim;
  re-derive from source (see §1.9).

---

## 7. Open items for the rebuild (flagged as unverified / needing fresh on-chain confirmation)

1. **v1's real `TokenLaunched` event signature and indexed-ness** — not in this repo's
   ABI at all; only a possibly-corrupted docs description exists. Pull from the
   verified v1 factory source on the explorer.
2. **v1 access control** — whether `PonsLaunchFactory` has any `canLaunch`/whitelist
   gate at all is unknown from this codebase; it was simply never read.
3. **v2 `phase` enum values** on `getLaunchedToken` — read as a bare integer, never
   decoded to names, in this repo.
4. **v2 snipe tax window** — 3 seconds (repo code comment, called "live") vs. 5 seconds
   (docs fetch) — reconcile against `snipeTaxSeconds()` directly.
5. **v1 legacy factory** (`0x0c37a24F5D23A486FA692d1500881d698B1F77a4`, docs-only,
   never touched by this repo) — investigate only if historical v1 launches predating
   the current factory matter to the new project.
6. **Fee split percentages** (70/30 active, 90/10 legacy) — docs-only, never read or
   used by pons-launcher's code; confirm against source if the new project needs to
   reason about where the fee goes.
