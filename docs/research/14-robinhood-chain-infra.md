# Robinhood Chain infrastructure for a launchpad

Everything a launchpad needs to know about the chain itself: identity, RPC,
explorer, the one non-obvious timing gotcha, and every contract address a
launchpad would call — which ones are confirmed live on-chain today, and
which ones would still have to be discovered.

Primary local source: `pons-launcher`, a working launchpad client against this
exact chain (`d:\projects\pons-launcher`). Every address below marked
"confirmed live" was independently re-verified during this research by
calling the chain directly (`eth_call` via ethers against
`https://rpc.mainnet.chain.robinhood.com`) and cross-checking the address on
Blockscout — not merely copied from a comment.

## 1. Chain identity

| Field | Value |
|---|---|
| Name | Robinhood Chain |
| Chain ID (mainnet) | **4663** |
| Chain ID (testnet) | 46630 |
| Architecture | Ethereum L2 — "Arbitrum Dedicated Blockchains" (Arbitrum Orbit), settles to Ethereum L1, blob data availability |
| Native currency | ETH, **18 decimals** — no separate gas token |
| Sequencing | First-come-first-served at the sequencer; no public mempool (a pending tx cannot be front-run the way it can on a mempool chain) |
| Ordinary RPC block cadence | ~100ms / block, ~10 blocks per second |
| **`block.number` as seen by a contract** | **~16 seconds per tick** — see §4, this is the single most important non-obvious fact about this chain for a launchpad |

Sources: pons-launcher `backend/src/config.js:28-29` (chainId 4663);
[docs.robinhood.com/chain](https://docs.robinhood.com/chain) (architecture,
native currency, FCFS sequencing); WebSearch result confirming "Arbitrum Orbit,
settling to Ethereum with blob data availability"; `backend/src/evm/blocknumber.js:1-16`
and `backend/src/bundle/blockwait.js:28-31` (the two block-time figures).

## 2. RPC endpoints

| Purpose | URL |
|---|---|
| Public mainnet RPC (default used by pons-launcher) | `https://rpc.mainnet.chain.robinhood.com` |
| Public testnet RPC | `https://rpc.testnet.chain.robinhood.com` |
| Public sequencer feed (WebSocket, mainnet) | `wss://feed.mainnet.chain.robinhood.com` |
| Public sequencer feed (WebSocket, testnet) | `wss://feed.testnet.chain.robinhood.com` |
| Alchemy (recommended paid provider) | `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` (+ WS variant) |
| QuickNode | `https://{ENDPOINT}.robinhood-mainnet.quiknode.pro/{TOKEN}` |
| Also listed as available | Chainstack, dRPC |

Reliability notes from a real deployment (pons-launcher `backend/src/evm/provider.js:29-33`):
the public RPC is load-balanced across heterogeneous nodes and **intermittently
returns `-32601 Method not found` for a perfectly valid `eth_call`** — the repo
treats this, plus `-32603`/`-32005`/`-32000` and messages matching
`timeout|rate.?limit|temporar|try again|too many|busy|overloaded`, as transient
and retries reads (not broadcasts) up to 4 times with backoff. Broadcasts
(`eth_sendRawTransaction`) are only retried on an explicit rate-limit refusal
(codes `-32005`/`-32007`/`-32029` or matching `rate.?limit|429|quota|credits?`),
because that is the one failure mode that proves the sequencer never saw the
transaction (`provider.js:36-64`). A launchpad talking to this chain directly
should expect to build the same kind of retry/classification layer rather than
assume a plain JSON-RPC client is enough.

Also: connection pooling matters here specifically because a launch bundle
fires N buys simultaneously — the repo keeps a `keep-alive` HTTPS agent (up to
96 sockets) and explicitly "warms" the pool before a broadcast burst so the
burst doesn't pay a TCP+TLS handshake per wallet (`provider.js:1-27`, `86-116`).
`batchMaxCount: 1` is set because some RH RPC nodes mishandle JSON-RPC batch
arrays (`provider.js:119-121`).

Sources: `docs.robinhood.com/chain/connecting` (endpoint list); `backend/src/evm/provider.js:16-33,110-121`; `backend/src/config.js:28`.

## 3. Block explorer & its API

| Field | Value |
|---|---|
| Mainnet explorer | `https://robinhoodchain.blockscout.com` (Blockscout) |
| Testnet explorer | `https://explorer.testnet.chain.robinhood.com` |
| Default in pons-launcher | `EXPLORER_URL` env, defaults to `https://robinhoodchain.blockscout.com` |
| Self-hosted REST API (no key needed) | `https://robinhoodchain.blockscout.com/api/v2/...` — **confirmed working** during this research (e.g. `GET /api/v2/addresses/{address}` returns `is_contract`, `name`, `is_verified`, and token metadata for real addresses on this chain) |
| Blockscout's hosted PRO gateway (optional, needs a key) | `https://api.blockscout.com` with `chain_id=4663` — Etherscan-compatible `?module=...&action=...` **and** a REST v2 path (`/4663/api/v2/...`) **and** a proxied ETH JSON-RPC (`/4663/json-rpc`) |
| PRO gateway auth | Free key at dev.blockscout.com, required even for the free tier; `apikey=proapi_xxx` query param or `authorization: Bearer` header |
| PRO gateway rate limits | Free 5 req/s, 100K/day · Builder 15 req/s, 100M/mo · Pro 30 req/s, 500M/mo · Business 50 req/s, 3B/mo |
| Known cap on this chain specifically | `txlistinternal` and `eth_getLogs` capped at 1,000 records |

A launchpad reading contract-verification status, token metadata, or
transaction history without running its own indexer should use the **direct
self-hosted instance** (`robinhoodchain.blockscout.com/api/v2/...`) for
no-key basic use, and only reach for the PRO gateway if it needs guaranteed
rate limits or the Etherscan-compatible shape.

Sources: `backend/src/config.js:30`; `docs.blockscout.com/robinhood-api`;
live `WebFetch` calls to `https://robinhoodchain.blockscout.com/api/v2/addresses/{addr}`
performed during this research (see §6 for the specific addresses that
returned real, named, verified contracts).

## 4. The block-time gotcha — read this before writing anything that gates on a block number

This is the one fact about this chain that will silently break a launchpad if
missed, and it is not mentioned in the public docs found during this research
— pons-launcher only knows it because it was reverse-engineered against the
verified source of a launched token.

**Two different "block number" concepts exist simultaneously on this chain:**

1. **RPC block height** — advances about every 100ms (~10 blocks/second).
   This is what `eth_blockNumber` / a normal `provider.getBlockNumber()` call
   returns.
2. **`block.number` as read from *inside* a smart contract** (the Solidity
   opcode) — advances only about **every 16 seconds**, because it is derived
   from the parent (L1-side) chain rather than from this chain's own fast
   block production. This is the classic Arbitrum-family quirk where the
   `block.number` opcode reflects the parent chain, and it is *this* number —
   not the RPC height — that every on-chain restriction (launch-window caps,
   "the launch block", etc.) is written against.

Consequences documented in pons-launcher, verified against real launches:

- Reading `block.number` requires either an actual `eth_call` into a contract
  (not `eth_getBlockByNumber`) or, cheaper, calling **Multicall3's
  `getBlockNumber()`** (selector `0x42cbb15c`) — see §5. `backend/src/evm/blocknumber.js`.
- A launch-window restriction that says "2 blocks" (`restrictionBlocks: 2`)
  means **~32 seconds**, not ~200ms — sizing anything off the RPC height
  instead would be wrong by two orders of magnitude.
- The chain's own launched-token contract enforces a **strict equality**
  ban (`block.number == launchBlock` blocks every non-atomic buy), not a
  window — so a bundle of follow-up buys must wait for the EVM's
  `block.number` to tick *past* the launch block, then fire immediately
  (`backend/src/bundle/blockwait.js:1-26`).
- Because RPC blocks arrive ~160x faster than the EVM tick, a bundle can be
  "a whole RPC block late" (~100ms) relative to a competitor's without ever
  looking late by any RPC-level measurement — pons-launcher lost two launches
  to competitors this way before instrumenting it (`blockwait.js:28-56`).
- The fix implemented is an **overlapping poll loop** (reads issued on a fixed
  cadence regardless of what's still in flight, resolving on the first
  *answer* that shows the tick rather than the next scheduled poll) plus a
  `npm run latency` script that measures, on the actual deployment box,
  whether lateness is dominated by the poll interval or by RPC round-trip
  time, and recommends which lever to pull (`backend/scripts/latency.js`).

A new launchpad on this chain **must** decide early whether it needs to gate
anything on-chain by block number (restriction windows, vesting-by-block,
etc.), and if so must read `block.number` via a contract call
(Multicall3 or similar), never assume it tracks RPC height.

Sources: `backend/src/evm/blocknumber.js:1-35`; `backend/src/bundle/blockwait.js:1-273`;
`backend/src/bundle/fire.js:11-12`; `backend/src/config.js:94-110`;
`backend/scripts/latency.js:1-254`.

## 5. Core infrastructure contracts (confirmed live)

| Contract | Address | Status |
|---|---|---|
| **Multicall3** | `0xcA11bde05977b3631167028862bE2a173976CA11` | Confirmed live: Blockscout names it `Multicall3`, verified. This is the standard cross-chain deterministic-deployer address, and it works unmodified here — used by pons-launcher for exactly one thing, reading `block.number` via `getBlockNumber()` (§4). |
| **WETH** (bridged, wraps native ETH) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Confirmed live: Blockscout shows a verified `TransparentUpgradeableProxy` with token metadata `name=WETH, symbol=WETH, decimals=18`. Matches the "L2 WETH" entry on `docs.robinhood.com/chain/protocol-contracts`, and matches the `WETH`/pairToken constant used in pons-launcher's own test fixtures (`bundle/prepareSell.test.js:16`, `evm/v2/holdings.test.js:99`). This is the pair token every pons v1 launch actually trades against (confirmed live: `getLaunchConfig(0).pairToken` returns this exact address — see §7). |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Confirmed live: this is the canonical cross-chain Permit2 address and `eth_getCode` against it on Robinhood Chain returns real bytecode (18,306 bytes). Not currently used by pons-launcher, but present and relevant for any future integration that needs signature-based approvals (e.g. Uniswap's newer routers). |
| A **different**, official "L2 Multicall" | `0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1` | Listed on `docs.robinhood.com/chain/protocol-contracts` as a distinct Robinhood-operated utility contract — **not** the same address as canonical Multicall3 above, and not used anywhere in pons-launcher. Flagged here only so it isn't confused with the Multicall3 address; not independently verified by this research beyond the docs page. |

Also listed on the L1 side of the bridge (relevant only if a launchpad needs
to bridge assets in, not for on-chain launch logic): Rollup
`0x23A19d23e89166adedbDcB432518AB01e4272D94`, Sequencer Inbox
`0xBd0D173EEb87D57A09521c24388a12789F33ba96`, Bridge
`0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3`, L1 Gateway Router
`0x6a2E3a1e16FC29f27Ce61429746D558d656975bB`, L1 WETH (canonical Ethereum
mainnet WETH) `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`. (Not independently
re-verified; sourced from `docs.robinhood.com/chain/protocol-contracts` only.)

Sources: pons-launcher `backend/src/config.js:99-100` (Multicall3 default);
`backend/src/evm/blocknumber.js:13-21`; live `WebFetch` to
`robinhoodchain.blockscout.com/api/v2/addresses/{Multicall3, WETH, Permit2 addresses}`
performed during this research; `getCode` check performed via a local `node`
script against `https://rpc.mainnet.chain.robinhood.com`;
`docs.robinhood.com/chain/protocol-contracts` (L2 Multicall, L1-side bridge
contracts).

## 6. Uniswap V3 deployment on Robinhood Chain

**This is a custom/independent Uniswap V3 deployment for this chain — its
addresses do *not* match the canonical cross-chain Uniswap CREATE2 addresses.**
Confirmed by directly probing the canonical mainnet Quoter/QuoterV2 addresses
on this chain: both have bytecode, but Blockscout identifies the contracts
living there as `SwapRouter` and `SwapRouter2` — unrelated contracts that
happen to occupy those addresses by coincidence of deployment order, not real
Quoter deployments (see the explicit warning at the end of this section).
**Do not assume any Uniswap-adjacent address on this chain matches its
mainnet counterpart without checking.**

The addresses that *are* confirmed, and how they were obtained: pons-launcher
never hardcodes them. It reads them live from `PonsLaunchFactory.getDexConfig(id)`
(`backend/src/evm/factory.js:67-80,120-132`) — the factory itself is the
authority. This research called that function directly against the live
chain (`getDexConfig(0)`, factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`)
and cross-checked every result against Blockscout:

| Contract | Address | Verification |
|---|---|---|
| **UniswapV3Factory** | `0x1F7D7550b1b028f7571E69A784071F0205FD2eFA` | Read live via `getDexConfig(0).factory`. Blockscout: verified contract named `UniswapV3Factory`. |
| **NonfungiblePositionManager** | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | Read live via `getDexConfig(0).positionManager`. Blockscout: verified contract named `NonfungiblePositionManager` ("Uniswap V3 Positions NFT-V1"). |
| **SwapRouter02 — the pons swap router** | `0xCaf681a66D020601342297493863E78C959E5cb2` | Read live via `getDexConfig(0).swapRouter`. Blockscout: verified contract named `SwapRouter02`. This is the router pons-launcher's bundle buys/sells actually call (`backend/src/evm/router.js`, `backend/src/evm/abi.js:60-64` — `SWAP_ROUTER_02_ABI`, the no-deadline `exactInputSingle` shape). |
| **Quoter / QuoterV2** | **Not found — see warning below** | Repo has zero references to any quoter. Pricing is computed by reading the pool's `slot0()` directly (see below) rather than calling a quoter contract at all. |

**Pool fee tier actually used by pons launches:** `poolFee = 10000` (1%),
`tickSpacing = 200` — read live via `getDexConfig(0)`, matches Uniswap's
standard 1%-tier tick spacing.

**The router has two possible call shapes**, both of which pons-launcher's
ABI carries (`backend/src/evm/abi.js:47-64`): a newer `SwapRouter02`-style
`exactInputSingle` (no `deadline` field, what's live today —
`routerRequiresDeadline: false` on the live launch config) and an older
`SwapRouter`-style `exactInputSingle` (`deadline` field present). The factory
picks per launch config via `LaunchConfig.routerRequiresDeadline`, and
pons-launcher's `routerFor()` switches ABI accordingly
(`backend/src/evm/router.js:14-24`). A launchpad building fresh should not
assume only one router shape exists on this chain.

**Selling back out uses a two-call `multicall`, not a plain swap** — because
a sell's output is WETH (left sitting on the router), unwrapped to the
seller's native ETH balance in the same transaction via `unwrapWETH9`. Two
non-obvious details, both verified against the *live* router rather than
assumed from Uniswap's docs (`backend/src/evm/router.js:81-109`):
1. The swap's `recipient` must be **the router's own literal address**, not
   the seller and not the zero address — passing `address(0)` reverts with
   `"TF"` on this deployment (verified). The two router shapes disagree about
   what a zero-address recipient even means (`SwapRouter02` treats it as a
   real recipient and uses `address(2)` as the "keep it here" sentinel; the
   older `SwapRouter` maps `address(0)` to itself) — using the router's
   literal address sidesteps needing to know which shape is live.
2. `unwrapWETH9` sweeps the router's **entire** WETH balance to the given
   recipient, not just this swap's output — documented as a deliberate,
   harmless windfall rather than a risk.

**No slippage protection exists anywhere in the bundle-buy or sell-all path
by design** (`amountOutMinimum: 0` throughout) — the buy is signed before the
pool exists (nothing to quote against) and the "sell everything" feature is
explicitly a floor-less exit (`backend/src/bundle/prepareSell.js:13-18`).

**Quoter/QuoterV2 warning, in detail:** this research checked whether the
canonical mainnet Quoter (`0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6`) or
QuoterV2 (`0x61fFE014bA17989E743c5F6cB21bF9697530B21e`) addresses have code on
Robinhood Chain. Both do — but Blockscout identifies them as verified
`SwapRouter` and `SwapRouter2` contracts respectively, not quoters. This is
almost certainly because this Uniswap V3 fork was deployed with regular
sequential-nonce `CREATE` (or a different CREATE2 salt/deployer) rather than
the standard cross-chain deterministic deployer, so mainnet addresses landing
on *some* contract here is coincidence, not a match. **If a new launchpad
wants on-chain quoting** (as opposed to reading pool state directly, which is
what pons-launcher does — see next paragraph), **the real Quoter/QuoterV2
address for this deployment must still be discovered**, e.g. by asking
whoever operates this Uniswap V3 instance, or by scanning Blockscout's
verified-contracts list for a contract whose ABI matches `QuoterV2.quoteExactInputSingle`.

**How pons-launcher prices without a quoter:** `readPoolPrice()`
(`backend/src/evm/pricing.js:33-58`) calls the V3 factory's `getPool(token,
pairToken, fee)` directly, then reads that pool's `slot0()` for
`sqrtPriceX96`, and computes the spot price by hand
(`quoteSellOutV1()`, `pricing.js:78-90`) — explicitly labeled a **ceiling, not
a quote**, since it ignores price impact. This is a viable, quoter-free
alternative pattern a new launchpad could reuse instead of chasing down a
Quoter address.

**UniswapV4 / UniversalRouter:** pons-launcher explicitly refuses to sell a
"graduated" token because that trades through Uniswap v4 via
`UniversalRouter`'s command/input scheme, which the operator judged too easy
to get wrong (`backend/src/bundle/prepareSell.js:197-210`). This research
confirmed the canonical mainnet `UniversalRouter` address
(`0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD`) has **no code at all** on
Robinhood Chain — so if a new launchpad needs to support graduated-pool
trading, that address (and any v4 `PoolManager`) must be discovered from
scratch; nothing in pons-launcher or in the docs found so far identifies it.

Sources: `backend/src/evm/factory.js:40-83,119-132`; live `node`+`ethers` call
to `getDexConfig(0)`/`getLaunchConfig(0)` against
`https://rpc.mainnet.chain.robinhood.com` performed during this research;
live `WebFetch` to Blockscout for each address above; `backend/src/evm/router.js:1-172`;
`backend/src/evm/abi.js:47-64`; `backend/src/bundle/prepareSell.js:13-18,197-210`;
`backend/src/evm/pricing.js:1-92`.

## 7. Pons protocol contracts (context, not raw chain infra)

These are not Uniswap/chain infrastructure but are the addresses a
pons-compatible launchpad would need, included here since they were already
confirmed during this research and a new project will likely want to decide
whether to integrate with or replace them:

| Contract | Address | Confirmation |
|---|---|---|
| PonsLaunchFactory (v1) | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | Confirmed live: verified on Blockscout as `PonsLaunchFactory`; confirmed responsive via direct `getConfigs()`-style calls during this research. |
| PonsV2LaunchFactory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | From repo comment citing verified source (`backend/src/evm/v2/abi.js:5-7`); **not** independently re-verified in this pass but is the address pons-launcher's config actively uses in production (`config.js:39-46`) and which the repo's own header warns is the *correct* v2 factory — the address published at `docs.ponsfamily.com/v2` is a stale, never-used deployment; this one was found by scanning chain logs for the `TokenLaunched` topic. |
| PonsV2LaunchDeployer | `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` | From repo comment (`evm/v2/abi.js:6`). |
| PonsV2LaunchForwarder | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | From repo comment (`evm/v2/abi.js:7`). |

Sources: `backend/src/config.js:33,45`; `backend/src/evm/abi.js:3-5`;
`backend/src/evm/v2/abi.js:5-7`; `backend/src/evm/factory.js:198-207`
(`validate()` — boot-time proof the factory address is live).

## 8. Live launch/dex config, as read directly from the chain

Pulled live during this research via `PonsLaunchFactory.getLaunchConfig(0)` /
`.getDexConfig(0)` / `.launchFee()` (single enabled config of each, at the
time of writing — `dexConfigCount()` and `launchConfigCount()` both returned
`1`):

| Field | Value |
|---|---|
| `pairToken` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (WETH — every v1 launch is native-ETH-quoted) |
| `graduationThreshold` | 4,200,000,000,000,000,000 wei = **4.2 ETH** |
| `initialTick` | -204200 |
| `supply` | 1,000,000,000,000,000,000,000,000,000 = **1,000,000,000 tokens** (18 decimals) |
| `maxWalletBps` | 500 → **5%** of supply |
| `maxTxBps` | 550 → **5.5%** cumulative buy cap |
| `restrictionBlocks` | **2** (≈32 seconds — see §4) |
| `reservedFee` | 0 |
| `enabled` | true |
| `routerRequiresDeadline` | false (live launch config uses the `SwapRouter02` no-deadline shape) |
| `dexConfig.name` | `"uniswap v3"` |
| `dexConfig.poolFee` | 10000 (1%) |
| `dexConfig.tickSpacing` | 200 |
| `launchFee()` | 500,000,000,000,000 wei = **0.0005 ETH** |

These match pons-launcher's own README table ("read 2026-07-25": max wallet
5%, cumulative cap 5.5%, restriction window 2 blocks — `README.md:41-45`),
confirming the config has been stable across at least a month of production
use as of this research (2026-08-22).

Sources: live `node`+`ethers` calls performed during this research against
`https://rpc.mainnet.chain.robinhood.com`, factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`;
`backend/README.md:41-45` (cross-check).

## 9. Summary — what's confirmed vs. what a new launchpad still has to find

**Confirmed live, safe to hardcode as defaults (with an env override, as
pons-launcher does):**
- Chain ID 4663 (mainnet) / 46630 (testnet)
- Public RPC `https://rpc.mainnet.chain.robinhood.com`
- Explorer `https://robinhoodchain.blockscout.com` (+ its `/api/v2/...` REST API, no key needed)
- Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`
- WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- Uniswap V3 Factory `0x1F7D7550b1b028f7571E69A784071F0205FD2eFA`
- NonfungiblePositionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`
- SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`
- Pool fee tier in use: 10000 (1%), tickSpacing 200

**Still must be discovered on-chain / by asking the deployer if needed:**
- **Quoter / QuoterV2** — no confirmed address; not used by any working
  reference implementation seen so far. Consider the quoter-free
  `slot0()`-based pricing pattern in §6 instead of chasing this down.
- **UniversalRouter / Uniswap v4 PoolManager** — needed only if supporting
  trading on *graduated* tokens; canonical mainnet address confirmed to NOT
  exist on this chain; pons-launcher deliberately does not support this yet
  either.
- Whether there are **other enabled dex configs beyond id 0** — only checked
  as of this research; `PonsLaunchFactory.dexConfigCount()` should be
  re-queried at build time rather than assuming `1` forever, exactly as
  pons-launcher does (it never hardcodes any of the addresses in §6 — it
  reads them from the factory every time).
- Stablecoins (USDC/USDT/USDG) if a launchpad wants a non-ETH quote
  currency — mentioned as existing in Robinhood's own contract-address
  documentation but no specific addresses were surfaced in this pass.

**The one behavioral fact to design around from day one:** `block.number`
inside a contract on this chain ticks every ~16 seconds and is **not** the
same number the RPC reports for its own block height (§4). Any launch-window
restriction, vesting schedule, or "N blocks after X" logic must be measured
against the *EVM's* `block.number` (read via a contract call, e.g. Multicall3),
never against RPC block height.
