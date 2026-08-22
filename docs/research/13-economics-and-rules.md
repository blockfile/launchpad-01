# 13 — Pons Economics and Launch Rules

Scope: the economic parameters and launch-time rules of the pons launchpad (`ponsfamily.com`, Robinhood
Chain, chain id 4663), as they exist across its two live protocols — **v1** (Uniswap v3, no bonding curve)
and **v2** (bonding curve, graduates into Uniswap v4). Everything below is labeled by how it was learned:

- **CONFIRMED (code)** — read directly from `pons-launcher`'s source, which calls the real, verified
  on-chain factory contracts and in several places anchors its arithmetic to a real observed transaction.
- **CONFIRMED (docs)** — fetched from `docs.ponsfamily.com` (2026-08-22) and quoted close to verbatim.
- **CONFIRMED (both)** — code and docs agree.
- **DISCREPANCY** — code/live-chain and docs disagree; both values are given, live wins.
- **INFERRED / UNCONFIRMED** — present in the ABI or the docs but its behavior isn't exercised or
  explained anywhere this project could check; flagged so the new repo doesn't silently assume it.

A standing warning from the codebase applies to all of this: `docs.ponsfamily.com` lists **stale
addresses** for both the v1 legacy factory and the v2 factory — the pages describe deployments that have
never emitted a `TokenLaunched` event. The live factories were found by scanning the chain for that event
topic, not by trusting the docs. Treat the docs as reliable for *economics/rules prose* (confirmed against
live reads below) but unreliable for *addresses*.

---

## 1. The two protocols, in one paragraph each

**v1** — `PonsLaunchFactory` (`0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`, live; `0x966ffA3957a6d3621D3EfC96E22160806f0EF141` is a fallback; four older deployments are stale) launches straight into a Uniswap v3 pool. `launchToken` is payable and, per its own doc comment, *"Atomically deploys, pools, locks, records, and optionally buys a token"* — anything sent above `launchFee` becomes an uncapped, atomic `initialBuyAmount` swapped in the same transaction as pool creation. There is no bonding curve and no migration: the pool that exists at block 0 is the pool that exists forever.
— *Sources:* `d:\projects\pons-launcher\backend\src\evm\factory.js:1-20`, `README.md:17-35, 318-329`

**v2** — `PonsV2LaunchFactory` (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, found by chain-scan; **not** the address docs.ponsfamily.com/v2 lists) launches a bonding curve holding the entire supply. A Uniswap v4 pool is created only at graduation. v2 has no atomic dev-buy cap either, but instead of a block-based restriction window it uses a **snipe tax** that decays over a few seconds, plus a **declared exemption list** the contract's own source calls *"the sanctioned pathway for organized teams that bundle their opening buys across several wallets."*
— *Sources:* `backend\src\evm\v2\abi.js:1-30`, `backend\src\evm\v2\factory.js:1-20`

---

## 2. Launch fee

| Protocol | Fee | Status |
|---|---|---|
| v1 | **0.0005 ETH** | CONFIRMED (both) — verified live 2026-07-25 by this project; also stated by docs.ponsfamily.com |
| v2 | Read live via `factory.launchFee()`; not a fixed constant in this repo | CONFIRMED (code) mechanism only — no anchored live wei value was recorded in this repo (test fixtures use `10n**15n` = 0.001 ETH, but that is a test value, not an observed live one). docs.ponsfamily.com/v2 does not state a number either. |

v1 mechanics: `launchToken.populateTransaction(..., { value })` where `value` **must equal** `launchFee + devBuyEth` — the factory's atomic buy is "everything above `launchFee`." There is no separate "dev buy fee"; the dev buy is uncapped and un-front-runnable because it executes inside the same transaction that creates the pool.
— *Sources:* `backend\src\evm\factory.js:182-191` (`buildLaunchTx`), `backend\src\bundle\prepare.js:102-104`, `README.md:23-29, 322-326`

v2 mechanics: `value` must be exactly `launchFee` (plain `launchToken`) or `launchFee + quoteIn` when routed through the forwarder's `launchAndBuy` (atomic dev buy). Sending anything else on the plain path reverts `LaunchFeeNotPaid`.
— *Sources:* `backend\src\evm\v2\factory.js:271-274, 293-294`, `backend\src\evm\v2\abi.js:191`

---

## 3. v1: the restriction window and the 5% wallet cap

This is the "5% cap inside the restriction window" referenced in the task, and it is the most precisely
anchored number in the whole codebase — checked against a **real on-chain launch**
(`0x4aE28f7022F0db76F9B791ff3DEe6bE67B40137F`, initial tick `-204200`, supply 1,000,000,000, where 0.003 ETH
observably bought 2,186,029 tokens on chain).

| Parameter | Live value (read 2026-07-25) | Meaning |
|---|---|---|
| `maxWalletBps` | **500 bps = 5% of supply** | Cap on how much of supply one address may **hold** after a pool→user buy, during the window |
| `maxTxBps` | **550 bps = 5.5% of supply** | Cap on how much of supply one **single buy transaction** may take, during the window |
| `restrictionBlocks` | **2 blocks** | Length of the restriction window, in EVM block numbers (~16s/block on this chain → ~32s wall time) |
| Exempt | The launch's own `initialBuyRecipient`, **launch block only** | The atomic dev buy is the only buy immune to both caps |

Rules, spelled out:
- **Block 0 (the launch block):** only the factory's own atomic initial buy can execute against the pool; every other pool→user buy reverts.
- **Blocks 1–2 (rest of the window):** every non-exempt address is capped at 5% held / 5.5% per-tx. A buy over either cap **does not clamp — it reverts**, and the pool's `TransferHelper` masks the revert reason as the opaque string `"TF"` (so the operator sees no useful error).
- **After the window (block 3+):** all limits lift — unrestricted trading.
- **Selling and wallet-to-wallet transfers are never restricted** at any point in the window — only pool→user buys are gated.
- The gate is enforced by the token's own transfer hook, checked as `_isPairPool(from)`: a transfer *from* the pool is capped, a transfer *not* from the pool (e.g. a wallet forwarding tokens to another wallet, or a distributor contract fanning them out) is unconstrained. This is exploited deliberately by pons-launcher's own "trigger buy" strategy (§6).

Because the cap **reverts rather than clamps**, and there is no pool to quote a live price against until the launch transaction has actually run, pons-launcher estimates the opening price from the launch config's `initialTick` (a Uniswap tick, magnitude only — `Math.abs`, because the tick's *sign* follows pool address ordering, not economics) and flags any bundle wallet whose estimated bps would exceed either cap **before signing**, so the warning shows while the operator can still resize. The estimate reads intentionally high (ignores the pool's own 1% fee and price impact), which errs on the safe side for a cap whose breach reverts.
— *Sources:* `backend\src\evm\pricing.test.js:1-55` (the anchor launch, exact `maxWalletBps`/`maxTxBps`/observed-token numbers), `backend\src\evm\abi.js:14-19` (`LaunchConfig` struct: `maxWalletBps`, `maxTxBps`, `restrictionBlocks`, `reservedFee`), `backend\src\bundle\prepare.js:183-196` (the preflight warning, `"TF"` masking), `shared\bundleShare.js:93-172` (the `capCheck`/`rateFromTick` estimator and its rationale), `README.md:37-54` (the config table quoted directly: "max wallet 500 bps = 5%", "cumulative buy cap 550 bps = 5.5%", "restriction window 2 blocks", "exempt: initialBuyRecipient, launch block only"), `backend\src\evm\distributor.js:1-30, 184-197` (the strategy exploiting the pool-vs-non-pool hook check, "capped at ~5% of supply (~0.0714 ETH)")

**CONFIRMED (both):** docs.ponsfamily.com states the same shape verbatim: *"On the launch block itself, only the creator's initial buy can execute. For the rest of the window each wallet can hold at most 5% of supply and buy at most 5.5% of supply,"* window = *"the first two blocks after launch,"* and *"all limits end once the window closes."* Docs also add explicitly that *selling and wallet transfers are never restricted* during the window — matching the code's `_isPairPool(from)` gate.

One more field exists in the v1 `LaunchConfig` struct that this repo reads but never explains or acts on:
**`reservedFee` (`uint24`)** — read into `getLaunchConfig()`/`getConfigs()` output but not documented anywhere
in this codebase or found in docs.ponsfamily.com. **UNCONFIRMED** — likely relates to the protocol/creator fee
split described in §5, but that is an inference, not something either source states directly.
— *Source:* `backend\src\evm\abi.js:14-19`, `backend\src\evm\factory.js:61,146`

---

## 4. v1 graduation — a field that exists but (per docs) means nothing distinctive

The v1 `LaunchConfig` struct **does** carry a `graduationThreshold` field (`backend\src\evm\abi.js:14-19,
17`), and docs.ponsfamily.com states a **default threshold of 4.2 ETH** paired in the locked pool. However,
because v1 has no bonding curve — the pool exists from block 0 — "graduation" for v1 does not gate trading
or migrate liquidity anywhere. Per the docs: *"Graduation only confirms the threshold was reached. It is
not a quality signal and does not guarantee future liquidity, price, or an exit."* This project's own
`bundleShare.js` v1 path (`shareV1`) returns `graduation: null` unconditionally — it never checks this field
for v1, treating it as inert for that protocol's bundle-planning purposes.
— *Sources:* `shared\bundleShare.js:440-463` (`graduation: null` in `shareV1`'s return), docs.ponsfamily.com (fetched 2026-08-22)

---

## 5. v1 pool fee and fee split (not a "tax" — a standard AMM swap fee)

- **Pool fee: 1%** (10,000 in Uniswap-v3 hundredths-of-a-bp units — `poolFee` on the `DexConfig`). This is an ordinary Uniswap v3 LP fee charged on every swap through the pool, split between creator and protocol — **not** a token-contract transfer tax.
  — CONFIRMED (both): `backend\src\evm\pricing.js:24` ("Uniswap fee tiers are hundredths of a basis point: 10000 is 1%"), README.md:325 ("pool fee 1%"), docs.ponsfamily.com ("Pool Fee: 1%").
- **Fee split, per docs.ponsfamily.com** (not independently verified against code in this repo — this project never claims trading fees, so it has no reason to read this split):
  - Current launches (from block 8991118): **creator 70% / protocol 30%**
  - Legacy launches (from block 8600612): **creator 90% / protocol 10%**
  — CONFIRMED (docs only).
- **No snipe tax, no opening tax, no ongoing token-level tax on v1.** Docs state this explicitly and nothing in the token ABI this repo reads (`PONS_TOKEN_ABI`: `launchFactory`, `liquidityPool`, `pairToken`, `poolFee`, `deployer`, `restrictionEndBlock`, `maxWalletLimit`, `maxTxLimit`) exposes any tax mechanism beyond the restriction-window caps in §3.
  — *Source:* `backend\src\evm\abi.js:66-76`

---

## 6. v1 liquidity: locked at creation, never migrates

Docs.ponsfamily.com states plainly: *"There is no bonding curve and no migration later. Buys and sells
happen in that same pool from the moment it launches,"* and *"the pool's liquidity is locked automatically"*
at creation, with *"Trading continues in the same pool after graduation. Nothing moves or migrates."* This
matches the code's model exactly — `factory.launchToken` "deploys, pools, **locks**, records, and optionally
buys" in one call, and this project's `getLaunchedToken` record stores a fixed `positionManager` /
`positionId` per token rather than anything suggesting a migratable position.
— *Sources:* docs.ponsfamily.com (fetched 2026-08-22), `backend\src\evm\abi.js:26-34` (`LAUNCHED_TOKEN` struct — one fixed `positionId`/`positionManager` per token, no migration hooks)

---

## 7. v2: the snipe tax (the real "anti-bot" mechanism, replacing v1's block window)

v2 has **no restriction window and no per-wallet buy cap** — `bundleShare.js`'s v2 path sets
`exceedsWallet: false, exceedsTx: false` unconditionally with the comment *"v2 has no restriction window and
no caps."* Instead, v2 taxes the **recipient** of every buy during an opening window:

| Parameter | Value | Status |
|---|---|---|
| `snipeTaxStartBps` | **9900 bps = 99%**, charged on the recipient of the buy, not the buyer | CONFIRMED (code) — read live from the factory; repo comment: "99% live" |
| `snipeTaxSeconds` | **3 seconds live** (per this repo's own comment, checked against the live contract) | DISCREPANCY vs docs — see below |
| Decay shape | Exponential, from `snipeTaxStartBps` down to 0 across `snipeTaxSeconds` | CONFIRMED (code) |

**DISCREPANCY:** `docs.ponsfamily.com/v2` states the decay window as **5 seconds** ("decays exponentially
to zero across the first 5 seconds"), while this repo's own comment — written against the live, verified v2
contracts — says **`snipeTaxSeconds` (3 live)**. Both values are read from the same on-chain getter
(`snipeTaxSeconds()`), so the discrepancy is either a stale docs page or the parameter having been changed
on-chain after the docs were written; **treat the live on-chain read as authoritative**, and re-verify
`snipeTaxSeconds()` directly at build time for the new repo rather than hardcoding either number.
— *Sources:* `backend\src\evm\v2\abi.js:20-30` (repo's own comment: *"Every buy in the opening window pays a tax starting at `snipeTaxStartBps` (99% live) and decaying exponentially to zero across `snipeTaxSeconds` (3 live). It is charged on the RECIPIENT, not the buyer."*), `README.md:191-195` ("a tax starting at 99% and decaying to zero over 3 seconds... charged on the *recipient*"), docs.ponsfamily.com/v2 (fetched 2026-08-22: "The tax starts at 99% of a buy and decays exponentially to zero across the first 5 seconds. It applies only to buys, not sells.")

**Exemption list** — the mechanism that makes v2 bundling declarative rather than a race:
- `launchToken` (3-arg overload with `snipeTaxExemptions`) and the forwarder's `launchAndBuy` both take an
  array of addresses exempt from the tax, applied atomically inside the launch transaction.
- **Factory-direct limit: 32 addresses.** Above that, the call reverts `ExemptionListTooLong`.
- **Forwarder limit (used whenever there's an atomic dev buy): 31 addresses** — one less than the factory,
  because `launchAndBuy` appends its own buy recipient before forwarding the list. Requesting 32 through the
  forwarder path fails with a clear message rather than reverting on-chain after the fee is spent; this was
  probed against the live contracts (factory-direct accepts exactly 32, reverts at 33; `launchAndBuy` accepts
  31, reverts at 32).
- The dev wallet and the creator-fee recipient are exempted **automatically by the factory itself** — they
  do not need to be (and should not be) added to the declared list.
- Per the verified v2 source (quoted in this repo's own ABI comment): the exemption list is *"the sanctioned
  pathway for organized teams that bundle their opening buys across several wallets"* — i.e. bundling
  through this mechanism is an explicitly supported use case of the protocol, not an exploit of it.
— *Sources:* `backend\src\evm\v2\factory.js:1-20` (file header), `backend\src\evm\v2\exemptions.test.js:1-23` (32/31 split, tested against the live behavior), `backend\src\bundle\prepareV2.js:163-179` (`exemptionLimit = devBuy>0 ? 31 : 32`), docs.ponsfamily.com/v2 ("At most 32 entries, past which it reverts with `ExemptionListTooLong`" — the forwarder-appended 31 is this project's own finding, not stated in docs)

---

## 8. v2: graduation, curve mechanics, and creator tax

- **Graduation threshold: 4.2 ETH raised** (README states this as a fact about the live config; a config-#0
  test fixture independently uses `graduationThreshold: 42n * 10n**17n` = 4.2 ETH). The threshold is
  measured against **`raised`** — the net quote that has actually stayed in the curve (fees excluded) — not
  against the phantom-inclusive `quoteReserve`. Docs.ponsfamily.com describes the threshold as configurable
  per launch config / per quote asset rather than a single hardcoded number, which is consistent with the
  code (`graduationThreshold` lives on the `LaunchConfig` struct and can also come from `pairTokenEconomics`
  for a non-native quote asset).
  — *Sources:* README.md:188-189 ("A Uniswap v4 pool is only built at graduation, at 4.2 ETH raised"), `backend\src\bundle\prepareV2.signsNothing.test.js:46` (`42n * 10n**17n`), `shared\bundleShare.js:480-617` (`shareV2`, `raised` vs `threshold` and `crosses`/`crossesAt`), `backend\src\evm\v2\factory.js:194-199` (`pairTokenEconomics` override for non-native pairs)
- **Curve mechanics: a real constant-product bonding curve against a phantom quote reserve.** Config #0's
  live curve was observed with **supply 1e9** and **phantomQuote 1.68 ETH** (`k = 1.68e9` from the first
  block), and this repo's arithmetic was checked against two live curves to within ~0.04%. Because the curve
  config fixes everything before the launch is sent, v2's bundle-share math is described in this repo as
  **exact arithmetic**, not an estimate (`exact: true`) — unlike v1's opening-tick estimate.
  — *Source:* `shared\bundleShare.js:211-234`
- **Fees on a v2 buy are taken off the input** (`netIn = quoteIn − fees`); a v2 sell instead takes fees off
  the **output** — both are charged in the quote asset, which is the input leg of a buy and the output leg
  of a sell.
  — *Source:* `shared\bundleShare.js:219-224`
- **`curveFeeBps`** — the protocol/LP-side curve fee, per launch config. **`creatorTaxBps`** — a creator-set
  tax, capped by the factory's live **`maxCreatorTaxBps()`** getter (no fixed number found in this repo or
  docs — it's read live and enforced client-side in `prepareV2` before signing: *"creatorTaxBps X exceeds
  the factory maximum of Y"*). Both bps figures are summed (`feeBps = curveFeeBps + creatorTaxBps`) and
  applied on the same quote leg for every buy walked through the curve.
  — *Sources:* `backend\src\bundle\prepareV2.js:128-132`, `shared\bundleShare.js:480-484`
- **At graduation, a Uniswap v4 pool is created and its liquidity is locked permanently** — per
  docs.ponsfamily.com: *"minted at graduation and transferred straight to the locker, where it stays
  permanently."* This project's own sell path refuses to trade a graduated v2 token at all (see below), so
  it has not independently verified the locker mechanism on-chain; this is **CONFIRMED (docs only)**.
- **Ongoing tax after graduation — v2 differs from v1 here.** Per docs.ponsfamily.com/v2: *"You pay the same
  rate whether the token is on its curve or in its Uniswap pool. The pool itself is set up to charge no fee
  of its own."* In other words, v2's `creatorTaxBps`/protocol fee is **not** a launch-window-only tax — it
  persists at the same rate into the graduated Uniswap v4 pool via a hook (`memeHook` /
  `FeePolicySnapshot`, frozen into the curve at launch: `protocolFeeRecipient`, `protocolFeeShareBps`,
  `buybackBurnBps`, `hookFeeBps`, `maxInternalPriceImpactBps`). This repo reads and freezes that policy
  snapshot at launch time (`predictAddresses` in `backend\src\evm\v2\factory.js:189-227`) but never further
  explains or exercises `hookFeeBps`/`buybackBurnBps` beyond passing them through — **flag this for the new
  repo: v2 tokens likely carry an ongoing swap-fee-like tax for their whole life, unlike v1's one-time 1%
  AMM fee split.** This is the opposite of a blanket "no ongoing taxes" claim and should not be assumed to
  hold for v2 without re-checking the live `memeHook` fee-policy contract directly.
  — *Sources:* `backend\src\evm\v2\abi.js:48-62` (`FEE_POLICY` / `LAUNCH_DEPLOYMENT` structs), `backend\src\evm\v2\factory.js:157-227` (`wiring()`, `predictAddresses()`), docs.ponsfamily.com/v2 (fetched 2026-08-22)

---

## 9. v2: no per-wallet buy cap, but a hard refusal once graduation is imminent

Unlike v1's revert-on-breach caps, v2 imposes no wallet/tx percentage limit at all (§7). The one hard rule
this repo enforces around graduation is on the **sell** side (v3 engine, which trades an already-launched
v2 token): a sell run **refuses to start** if the curve has already graduated, or is `readyToGraduate()`,
because *"a run started now would strand the remaining position"* mid-migration. This is a client-side
safety refusal in this project, not a contract-level rule.
— *Source:* `backend\src\routes\v3.js:100-112`, `backend\src\v3\exit.js:118-125`

Selling a **graduated** v2 token through the *buy* side of this project (`prepareSell.js`, the v1/v2 sell
planner) is explicitly out of scope and refused loudly: *"has graduated to a Uniswap v4 pool — selling a
graduated token is not yet [implemented]"* — the encoding differs (Uniswap v4 swaps go through
`UniversalRouter`) and getting it wrong does not revert safely.
— *Source:* `backend\src\bundle\prepareSell.js:199-208`

---

## 10. Supply

**Fixed supply: 1,000,000,000 (1e9) tokens per launch**, per docs.ponsfamily.com, and consistent with every
anchored example in the code (`supply: (1_000_000_000n * 10n**18n).toString()` in the v1 pricing test; v2
test fixtures use `10n**27n` = 1e9 tokens at 18 decimals too).
— *Sources:* docs.ponsfamily.com (fetched 2026-08-22), `backend\src\evm\pricing.test.js:16`, `backend\src\bundle\prepareV2.signsNothing.test.js:46`

---

## 11. Summary table

| Rule | v1 | v2 |
|---|---|---|
| Launch fee | **0.0005 ETH** (confirmed live 2026-07-25) | Read live via `launchFee()`; no anchored live figure found |
| Anti-snipe mechanism | Block-based restriction window | Time-decaying recipient tax |
| Window length | **2 blocks** (~32s) | **3 seconds** live per this repo's own on-chain check (docs say 5s — discrepancy) |
| Cap/tax at open | 5% wallet / 5.5% tx, **reverts** over cap | **99%** tax, decaying to 0 |
| Bundle exemption | None needed — dev buy is atomic; bundle wallets just stay under 5%/5.5% each | Declared exemption list, **32 max** (31 via atomic-dev-buy forwarder path) |
| Pool model | Straight to Uniswap v3, pool live from block 0 | Bonding curve → Uniswap v4 pool at graduation |
| Graduation threshold | 4.2 ETH (field exists, but is inert / "not a quality signal") | **4.2 ETH raised** (net of fees), gates the curve→pool transition |
| LP migration | **None — pool never moves, liquidity locked at creation** | Curve liquidity is converted into a **new, permanently-locked** Uniswap v4 position at graduation (docs only) |
| Ongoing token tax | **None** — only a standard 1% Uniswap swap fee, split creator/protocol (70/30 current, 90/10 legacy) | **Yes** — `creatorTaxBps` + protocol/hook fee persists at the same rate before *and* after graduation (docs: "pool itself... charge[s] no fee of its own", i.e. the tax is the pool's only fee) |
| Supply | 1,000,000,000 fixed | 1,000,000,000 fixed |

---

## 12. Open questions for the new repo to re-verify directly against the live chain

1. **v2 `snipeTaxSeconds`** — this repo says 3s live, docs say 5s. Read `snipeTaxSeconds()` live rather than hardcoding either.
2. **v2 launch fee** — no anchored live wei value was found in this repo or the docs; read `launchFee()` live.
3. **`reservedFee` on the v1 `LaunchConfig` struct** — read but never explained anywhere in this codebase or in docs.ponsfamily.com; its purpose is unknown.
4. **v2's post-graduation hook fee** (`hookFeeBps`, `buybackBurnBps`, `protocolFeeShareBps`) — this repo freezes the policy snapshot at launch but never further inspects or exercises it; worth pulling the verified `memeHook` source directly if the new project needs to model post-graduation economics precisely.
5. **v2 `curveFeeBps` / `maxCreatorTaxBps` live values** — both are read live via getters in this repo (no hardcoded defaults); no anchored real-world figure for either was found in comments or docs.
