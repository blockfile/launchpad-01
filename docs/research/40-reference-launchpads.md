# Reference launchpads survey

*Date: 2026-08-22. Web research plus primary-source contract ABIs/design notes
pulled from the sibling `pons-launcher` repo (a bundler tool built against
pons's own live factory contracts on Robinhood Chain).*

## Purpose

We are recreating "pons" — described to us as **fixed-supply, instant Uniswap
V3 listing, anti-snipe tax** — in a fresh repo. This document surveys pump.fun
(the model every bonding-curve launchpad on every chain copies) and the three
live Robinhood-Chain peers named in the brief (openfair, hood.fun, Noxa), plus
two extra data points that turned up during research and materially change the
picture: **pons's own two on-chain generations** (V1 matches the brief
exactly; V2 abandoned it for a bonding curve) and **Uniswap's own launchpad**
(Pools/Crowd Launch), which directly attacks the fee model pons V1 uses.

Everything below a platform's own site/docs is marked with its source. Where
a web source could not be fetched (403/404/paywall), that is noted rather than
guessed around.

---

## 1. pump.fun (Solana) — the archetype

**Launch model:** Bonding curve. Every token mints a fixed 1B supply up front;
800M of it sits in the curve, 200M is reserved for the liquidity pool at
graduation. The curve is a constant-product AMM against a **virtual (phantom)
SOL reserve** — buyers pay SOL in, price rises smoothly with no external order
book or market maker needed from block one.

**Graduation mechanics:** Trading halts the instant the curve's market cap
hits ~$69,000 (~85 SOL, network-variable) — equivalently, the moment the 800M
curve-side tokens are sold out. Migration was to Raydium prior to March 2025;
pump.fun then launched its own AMM, **PumpSwap**, and graduations have gone
there since (Raydium is now a rare legacy path).

**Fee model:** Token creation is free. Every trade on the curve pays a flat
**1%** platform fee (one source additionally cites a fixed ~$0.01 network fee
on top). That 1% alone produced hundreds of millions of dollars of first-year
revenue — pump.fun is the proof that a flat curve-trading fee, taken at
enormous volume, is a viable business model on its own, independent of any
graduation/migration fee.

**Anti-snipe measures:** Not documented in any source we could reach in
detail (Bitget's guide and HackerNoon's fee-machine piece both stop short of
covering wallet caps, dev-buy exemptions, or bot detection). The practical
anti-snipe property pump.fun relies on is structural, not a tax: the curve
*is* the pool from block one, constant-product pricing means a sniper who
buys early pays an ever-worsening price on the same curve everyone else
trades on, and there is no separate "restricted window" or decaying tax
layered on top the way pons V2 or hood.fun use. (Community tooling —
sniper bots, bundlers — exists precisely because pump.fun itself does not
suppress the practice at the protocol level.)

**Architecture notes:** No public contract-level writeup was reachable;
pump.fun's Solana programs are not documented in the sources this research
could fetch. The economically load-bearing facts (virtual reserve, curve
split, graduation threshold, PumpSwap migration) are the well-established
public ones cited above.

Sources:
[Bitget: What Is Pump.fun 2026](https://web3.bitget.com/en/academy/what-is-pump-fun-and-how-does-it-work-2026-guide-for-memecoin-traders) ·
[HackerNoon: Inside pump.fun's Fee Machine](https://hackernoon.com/inside-pumpfuns-fee-machine-how-the-protocol-extracts-value-on-solana) (fetch blocked, title/summary only via search) ·
[Chainstack: Listening to pump.fun migrations to PumpSwap](https://docs.chainstack.com/docs/solana-listening-to-pumpfun-migrations-to-raydium) ·
[Flashift: Pump.fun Bonding Curve Mechanics 2026](https://flashift.app/blog/bonding-curves-pump-fun-meme-coin-launches/) ·
[Moby: What Is Pump.fun? 2026 Guide](https://moby.win/learn/pumpfun/)

---

## 2. openfair (Robinhood Chain)

**Launch model:** The one platform surveyed that explicitly offers **both**
paths as creator options in one flow: "free fair launch via bonding curve or
instant Uniswap V3 listing with zero capital," in a single transaction. This
is architecturally the closest peer to what pons V1 + pons V2 look like
side by side — openfair just ships both as configuration rather than as two
protocol generations.

**Fee model:** Creator-configurable. Creators set the fee split between
themselves and the platform, "with the option to keep 100% of fees for
themselves," and can set customizable buy/sell fees (a related search result
puts the configurable range at 0–10%). This is the most creator-favorable fee
model of any platform surveyed — everyone else fixes the split or the rate.

**Anti-snipe measures:** "Optional anti-snipe protection" is named in
openfair's published workflow alongside immutable auto-verified contracts and
permanent liquidity locking, but the mechanism (wallet cap? decaying tax?
delay window?) is not detailed in any reachable source — openfair.app itself
returned only its page title to WebFetch, and no whitepaper/docs URL surfaced.

**Architecture notes:** None reachable. Openfair is described as "permissionless" and "no-code," targeting Robinhood Chain specifically; it appeared alongside the other launchpads named here in the wave that followed Robinhood Chain's July 2026 mainnet.

Sources:
[Bitcoin Foundation: How to Launch a Memecoin on Openfair](https://bitcoinfoundation.org/news/blockchain-news/how-to-launch-a-memecoin/) (fetch blocked, summary via search only) ·
[openfair.app](https://openfair.app/) (fetch returned only page title) ·
[Bitrue: 10+ Best Robinhood Launchpads 2026](https://www.bitrue.com/blog/best-robinhood-launchpads-2026)

---

## 3. hood.fun (Robinhood Chain)

The most thoroughly documented peer — its own whitepaper page was fetchable
in full.

**Launch model:** Constant-product bonding curve with virtual reserves
(mirrors Uniswap's x·y=k), pre-seeded so price starts low and rises smoothly.
Default 1B supply (customizable 1 to 1 quadrillion): **80% curve / 20%
reserved for the Uniswap pool.** Virtual ETH seed ~2.81 ETH; graduation
threshold ~6.5 ETH raised; projected graduation market cap ~26.9 ETH.

**Graduation mechanics:** Permissionless — *any* participant can call the
migration function once the curve sells out. It pairs the raised ETH (minus
fees) with the reserved 20% token allocation into a **1% fee Uniswap V3
pool**, then locks the entire LP position in hood.fun's own Liquidity Locker,
which the whitepaper states has "no withdraw function, no owner, and no
admin — the code that could move the liquidity simply does not exist."
Migration itself costs 0.05 ETH + 3% of the raised amount + a flat 0.5 ETH
protocol fee.

**Fee model:**
- Creation: free (gas only)
- Curve trading: flat **1%**, split 80% creator / 20% protocol
- Post-graduation (Uniswap V3): 1% pool fee, split 80% creator / 20%
  protocol on the ETH side; the token side is **burned**
- Fees are **snapshotted per token at launch** and can never change
  afterward, for any token, by anyone (including the protocol itself)

**Anti-snipe measures** — the most complete anti-snipe stack of any platform
surveyed:
1. Opt-in launch snipe guard that caps each wallet in the first minutes
2. **5%-of-curve per-wallet cap, on by default**, stopping a single buyer
   from acquiring enough to drain the pool at graduation
3. Tokens are **non-transferable outside the curve until graduation** —
   closes the "pre-seeded pair" exploit class entirely
4. Slippage bounds (minimum-out) enforced on every trade

**Architecture notes:** Non-upgradeable contracts on Robinhood Chain
(Arbitrum-Orbit L2). Three core components: launchpad curve, Uniswap V3
migrator, ownerless liquidity locker. Governance: 2-of-3 Gnosis Safe
multisig. Security posture includes a 7-day public timelock on any migrator
upgrade, atomic LP-locking inside the migration transaction, reentrancy
guards throughout, and an "invariant-fuzzing test suite" validating ETH
conservation. No keeper bots or relayers — fully permissionless,
user-initiated.

Sources:
[hood.fun whitepaper](https://hood.fun/whitepaper) ·
[Technology Magazine: hood.fun Official Launch](https://technologymagazine.com/globenewswire/3324698) ·
[CabalGems: hood.fun launch press release](https://www.cabalgems.com/2026/07/hoodfun-announces-official-launch-as.html)

---

## 4. Noxa / NOXA Fun (Robinhood Chain) — shut down

**Launch model:** Not a bonding curve at all — the odd one out among the
"pump.fun-style" Robinhood Chain platforms. Noxa deploys **directly onto
Uniswap V3 with single-sided liquidity** in one transaction: ERC-20 deploy +
single-sided liquidity add (at the **1% Uniswap V3 fee tier**) + immediate
tradeability, atomically. This is the closest peer on the list to pons V1's
"instant Uniswap V3" model, differing mainly in liquidity shape (single-sided
vs. pons's fixed-supply-paired-against-WETH) and in dropping bonding-curve
migration risk entirely — there is no graduation *event*, only a "graduation
milestone" that is cosmetic (net-buy/liquidity threshold marker) since
trading already happens on the real DEX from block one.

**Fee model:** No custom token taxes — the 1% Uniswap V3 fee tier *is* the
fee, identical for every token on the platform. Creators earn trading fees
accrued automatically to their position and claimable through the platform,
paid in WETH.

**Anti-snipe measures:** Not documented in any reachable source. No source
mentions wallet caps, taxes, or bot protection for Noxa specifically —
notable given the bundler-tooling ecosystage around it (see below).

**LP locking / architecture:** LP position locked permanently in a locker
contract described as one that "never moves, never migrates, and cannot be
pulled."

**Current status — collapse, not just a competitor data point:** Noxa was
Robinhood Chain's single biggest launchpad (60k tokens launched, including
the chain's most popular memecoin, CASHCAT) before halting new launches in
mid-July 2026. It had collected roughly **$12M in fees within days** at peak,
then paused new token creation, reportedly amid spam issues and after losing
control of its own domain. Existing tokens can still trade on-chain, but the
platform itself should not be treated as active. This is directly relevant
as a cautionary case: a launchpad with no bonding curve, no anti-snipe tax,
and a flat fee-tier model captured enormous volume fast but had no defense
against the spam/quality problem that a tax-based or curve-based gate (pons,
hood.fun) is explicitly designed to solve.

Sources:
[Bitrue: NOXA Fun Robinhood Chain Guide](https://www.bitrue.com/blog/noxa-fun-robinhood-chain-guide) ·
[Bittime: NOXA Launchpad Beats Pump.fun in 24 Hours](https://www.bittime.com/en/blog/noxa-launchpad-robinhood-chain-kalahkan-pump-fun) ·
[CoinGabbar: Noxa Shutdown](https://www.coingabbar.com/en/crypto-currency-news/robinhood-chain-launchpad-noxa-shutdown-launches-halts) ·
[NFT Plazas: Noxa shuts down after $12M in fees](https://nftplazas.com/noxa-robinhood-chain-launchpad-shuts-down-12m-fees/) ·
[Smithii: Noxa Bundler Robinhood Chain 2026](https://smithii.io/en/noxa-bundler-robinhood-chain/) (fetch 404'd, title/context via search only) ·
[CoinDesk: the launchpad that fueled the memecoin boom](https://www.coindesk.com/business/2026/07/15/the-launchpad-that-fueled-robinhood-chain-s-memecoin-boom-just-gave-away-all-its-revenue) (fetch rate-limited, not directly read)

---

## 5. pons itself — two generations, and they disagree with each other

This is the most important finding in this survey: **pons is not one model.**
The brief's description ("fixed-supply, instant Uniswap V3, anti-snipe tax")
is **pons V1**. Pons then shipped a **V2** that is a completely different
protocol — a bonding curve — reachable via the sibling repo's verified,
transcribed contract ABIs (`pons-launcher/backend/src/evm/v2/{factory,abi}.js`),
which is primary-source, on-chain-verified data, not marketing copy.

### Pons V1 — matches the brief exactly

Verified live against `PonsLaunchFactory` (`0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`)
on Robinhood Chain (chain 4663), 2026-07-25.

- **Fixed supply, deployed instantly:** `launchToken` is one `payable` call
  that atomically deploys the ERC-20, deploys the Uniswap V3 pool, adds
  liquidity, **locks** it, records the launch, and optionally executes the
  creator's own opening buy — all in the same transaction. Supply:
  1,000,000,000 fixed. Pair: WETH. Pool: Uniswap V3, **1% fee tier (10000),
  tick spacing 200.**
- **Launch fee:** flat 0.0005 ETH (`launchFee`, read live).
- **Trading fee:** 1% per trade in a pons pool, split **70% creator / 30%
  protocol** (per the Uniswap-Pools comparison piece below; not independently
  re-verified against V1 contract state in this pass).
- **"Anti-snipe tax" is actually a restriction window, not a tax:** for
  `block.number <= restrictionEndBlock`, and *only on pool→user buys*, the
  token contract enforces (a) max wallet = `totalSupply * maxWalletBps/10000`
  (live value 500 bps = 5%) and (b) a cumulative per-address buy cap =
  `totalSupply * maxTxBps/10000` (live value 550 bps = 5.5%). The **only**
  exemption is the creator's own atomic initial buy, exempt on the launch
  block only. **The live restriction window is 2 blocks** — protection lapses
  almost immediately, which is why landing in block 0/1 is "the whole game"
  for anyone trying to front-run or out-buy the crowd. No transfer tax exists
  after the window; the token is then a plain ERC-20, and sells are never
  restricted.
- **Why front-running isn't a real threat here:** the pool does not exist
  until the launch transaction executes, so the creator's own buy — riding
  in the same transaction — literally cannot be preceded by anyone. Robinhood
  Chain is sequencer-ordered with no public mempool to snipe a *pending* tx
  from; bots can only react to the pool-creation event after the fact, which
  the 2-block wallet-cap window is what actually defends against.
- **Deployer identity matters:** the factory records `deployer = msg.sender`
  directly — routing a launch through a helper contract would make the
  helper the on-chain deployer and owner of creator fees, which is why
  third-party tooling sends launches directly from the creator's own wallet
  rather than proxying them.

Source: `d:\projects\pons-launcher\docs\superpowers\specs\2026-07-25-pons-launcher-design.md`
(entire file; on-chain facts independently re-verified against Blockscout by
that document's author on 2026-07-25) and
`d:\projects\pons-launcher\backend\src\evm\v3\...` sibling design.

### Pons V2 — abandoned the brief, became a bonding-curve + Uniswap-V4-hook protocol

Verified live against `PonsV2LaunchFactory` (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`)
— explicitly the *live* deployment, distinct from an abandoned address the
public docs still list (`0x7E1EAbd5…`, `launchEnabled() == false`, zero
events ever emitted). Per
`d:\projects\pons-launcher\backend\src\evm\v2\abi.js:16-18`: **"v2 is a
different protocol, not a new version of v1. A launch creates a bonding curve
holding the whole supply; a Uniswap v4 pool is only built at graduation."**

- **Bonding curve with a virtual ("phantom") quote reserve:** each launch
  config specifies `supply`, `curveFeeBps`, `phantomQuote` (virtual reserve
  size), `graduationThreshold`, plus the eventual pool's `poolFee` /
  `tickSpacing`. A custom ERC-20 quote asset (not just native ETH) can supply
  its own phantom reserve and threshold in its own decimals — pons V2
  supports pairing against assets beyond ETH (the public web summary
  mentions USDG and tokenized stocks).
- **Predictable addresses, same trick as V1:** `TokenParams` now carries a
  `salt`; `PonsV2LaunchDeployer.predictLaunchAddresses` returns the token and
  curve address that salt will produce *before* the launch is sent — so
  bundle buys can still be pre-signed with no helper contract and no waiting
  on a receipt.
- **The snipe tax is a real, decaying tax — not a wallet cap:** every buy in
  the opening window pays a tax charged **on the recipient**, starting at
  `snipeTaxStartBps` (**99% live**) and **decaying exponentially to zero**
  across `snipeTaxSeconds` (**3 seconds live**). This is a materially
  different anti-snipe primitive than V1's flat 2-block wallet cap — it's
  continuous-time decay rather than a hard cutoff, and it taxes value
  extracted rather than capping position size.
- **Exemption list is a first-class, declared parameter:** `launchToken`
  takes up to **32 addresses** exempt from the opening snipe tax, applied
  atomically inside the launch — the source's own comment calls this "the
  sanctioned pathway for organized teams that bundle their opening buys
  across several wallets." Going through the `launchAndBuy` forwarder (the
  only path with an atomic dev buy) caps the caller-supplied list at
  **31**, because the forwarder appends its own buy recipient before
  forwarding to the factory's 32-item limit — an off-by-one that reverts
  (`ExemptionListTooLong`) rather than truncates if a caller assumes the
  documented 32 applies uniformly.
- **Creator tax + protocol fee policy, snapshotted at launch:** `creatorTaxBps`
  is caller-supplied (capped by `maxCreatorTaxBps`); a `FeePolicySnapshot`
  (protocol fee recipient, protocol fee share, buyback-burn bps, hook fee bps,
  max internal price-impact bps) is read from a shared **meme hook** contract
  at launch time and frozen into the curve — later hook changes cannot affect
  an already-launched token, mirroring hood.fun's "fees fixed per token at
  launch" pattern independently.
- **Buyback mechanism:** an optional `buybackEnabled` flag plus a shared
  `buybackVault` — part of the protocol fee stream is earmarked for buybacks
  rather than pure protocol revenue, a feature none of the other four
  platforms surveyed here document.
- **Graduation:** into a **Uniswap V4 pool** via a shared "Pons hook"
  (`memeHook`), gated by `graduationThreshold`; the ABI also exposes a
  `GraduationRescueTooEarly` / `GraduationStillViable` error pair, implying a
  rescue path if a curve stalls before organically reaching threshold.

Sources: `d:\projects\pons-launcher\backend\src\evm\v2\abi.js` (full file,
verified/transcribed against the live contract's verified source) and
`d:\projects\pons-launcher\backend\src\evm\v2\factory.js` (full file) —
both primary, on-chain-derived documents, not web marketing.

### External confirmation of the V1→V2 pivot and current fee posture

- [Airdrop Alert: What Is Pons Crypto?](https://airdropalert.com/blogs/pons-crypto-launchpad/) (fetch blocked; via search) confirms: V1 paired a fixed 1B supply against WETH in a Uniswap V3 pool; **V2 replaced that with a bonding curve that graduates into a permanently locked Uniswap V4 pool through a shared Pons hook**, adding pairs beyond ETH (USDG, tokenized stocks). Also states V1's flat launch fee (0.0005 ETH) and a 1%-trade-fee / 70-creator / 30-protocol split, and that Pons has launched 250k+ tokens as of early August 2026.
- [The Defiant: Uniswap's new launchpad out-launched Pons](https://thedefiant.io/news/defi/uniswaps-new-launchpad-out-launched-pons-on-its-first-day-on-robinhood-chain) — Uniswap's own launchpad, **Pools / "Crowd Launch"**, undercuts pons directly on fees: **zero launchpad fee**, a 0.25% Uniswap V4 LP fee that auto-compounds into locked liquidity (creators can optionally add 0.05% more), versus pons's 1% pool fee + 0.0005 ETH launch fee. Uniswap founder Hayden Adams is quoted characterizing pons's 1% pool fee as "aka 2% spread" and "the primary method of extraction," positioning Pools as the low-fee alternative. On August 5, 2026, Pools launched 10,506 tokens vs. pons's 7,210 — real, current competitive pressure on pons's fee model. Pools' mechanism is described as a "continuous clearing auction" per a November 2025 Uniswap whitepaper; TWAP-based pricing over a multi-hour bidding window was also referenced in earlier search results as a bundling/bot deterrent, though the article fetched did not itself detail the anti-snipe mechanics.
- `ponslaunchpad.com` (fetched directly) confirms current scale — 2,334 graduated tokens, 167,354 tokens in earlier stages — and states pons is fully non-custodial ("your wallet submits every transaction; pons does not custody assets"), but the public marketing page itself carries no technical detail beyond that.

---

## 6. Comparison table

| Platform | Launch model | Graduation | Pool fee tier | Launch fee | Trade-fee split | Anti-snipe mechanism |
|---|---|---|---|---|---|---|
| pump.fun | Bonding curve (virtual SOL reserve) | Curve sellout (~$69k mcap) → PumpSwap (was Raydium) | n/a (AMM, not V3) | free | 1% flat, split undocumented | none documented (structural only) |
| openfair | Creator's choice: bonding curve **or** instant Uniswap V3 | Curve variant only | Uniswap V3 (fee tier not stated) | not stated | creator-configurable, up to 100% to creator | "optional," mechanism undisclosed |
| hood.fun | Bonding curve (virtual ETH reserve, x·y=k) | Permissionless call at curve sellout → Uniswap V3, LP locked forever | 1% Uniswap V3 | free (gas only) | curve 80/20 creator/protocol; post-grad 1% pool, 80/20, token side burned | 5%-per-wallet cap (default on) + opt-in stricter cap + non-transferability pre-graduation + slippage bounds |
| Noxa (defunct) | **Instant** single-sided Uniswap V3 liquidity, atomic | none (milestone is cosmetic) | 1% Uniswap V3 | not stated | fee-tier only, no custom tax; creator claims accrued WETH | none documented — plausible contributor to spam-driven shutdown |
| **pons V1** (the brief's target) | **Instant** fixed-1B-supply Uniswap V3 pool, atomic | none (no curve) | 1% Uniswap V3 (tick spacing 200) | 0.0005 ETH | 1%, 70/30 creator/protocol | 2-block wallet cap: max wallet 5%, max cumulative buy 5.5%, exempt only the atomic creator buy |
| pons V2 (what pons became) | Bonding curve, virtual quote reserve, multi-quote-asset | Threshold-gated → Uniswap **V4** via shared hook | config-defined | 0.0005 ETH (unconfirmed if changed) | curve fee + creator tax + protocol fee policy, snapshotted at launch | **decaying tax**: 99% → 0% over 3 sec on recipient, with a declared ≤32-address exemption list for bundlers |
| Uniswap Pools / Crowd Launch | Auction-based ("continuous clearing auction") | n/a — direct to Uniswap V4 | 0.25% (+0.05% optional creator cut) | **zero** | auto-compounds into LP, not a creator/protocol split | multi-hour TWAP-style bidding window (per secondary source; not confirmed firsthand) |

---

## 7. Which model matches "recreate pons," and what to borrow

**The brief describes pons V1, not current pons.** If the goal is literally
"recreate pons" as specified — fixed supply, instant Uniswap V3, anti-snipe
tax — **pons V1 is the model to build**, not V2. V2 is a legitimate, more
sophisticated design, but it is a different product (bonding curve +
Uniswap V4 hook + multi-asset pairing + buyback vault) that the brief does
not ask for. Building V2's shape while calling it "pons" would silently
change scope from day one.

**Concretely, pons V1's architecture to reproduce:**
1. One atomic transaction: ERC-20 deploy (fixed supply) → Uniswap V3 pool
   deploy → liquidity add → LP lock → optional creator buy, all-or-nothing.
2. Uniswap V3, not V2/V4 — matches the brief's "instant Uniswap V3" wording
   exactly and is also what Noxa (the only other instant-listing peer) uses.
3. A **short, block-count-based restriction window** (not a percentage tax)
   as the anti-snipe primitive: cap max wallet holding and cap cumulative
   buy-per-address for N blocks post-launch, exempting only the creator's
   own atomic buy. This is cheap to implement, easy to reason about, and
   pons's own numbers (2 blocks, 5%/5.5%) are a reasonable starting default
   worth deliberately re-deriving rather than copying blindly, since 2
   blocks is described even by pons's own tooling author as "protection
   lapses almost immediately."
4. Deployer identity should be the caller's own wallet (`msg.sender`), not a
   helper/router contract, if creator-fee ownership needs to track the real
   launcher — this is the exact reason the sibling bundler tool sends
   launches directly from the creator wallet rather than proxying.

**Patterns worth borrowing from the peers even while staying in the V1
shape**, because they patch real gaps V1 has and none of them requires
becoming a bonding curve:

- **From hood.fun:** non-transferability of the token *before* the
  liquidity/restriction event completes, closing the "pre-seeded pair"
  exploit class — this is a stronger primitive than a wallet cap alone and
  is compatible with an instant-listing model (just gate transfers, not
  curve access). Also worth copying: fee terms snapshotted immutably per
  token at creation, and an LP locker contract that has no owner and no
  withdraw function at all (rather than a locker that is merely
  "unlocked-by-nobody-yet").
- **From pons V2's own anti-snipe design (even though V2's overall shape is
  out of scope):** the *declared exemption list* pattern for legitimate
  bundled team buys is a better primitive than "only the atomic buyer is
  exempt" if the fixed-supply V1 model wants to support a team splitting its
  opening buy across multiple wallets — it converts an otherwise-adversarial
  bundling pattern into an explicit, auditable, on-chain-declared list, capped
  at a small N (pons uses 32, or 31 through a forwarder that appends its own
  recipient — watch for exactly this kind of off-by-one if a similar
  forwarder path is built).
- **From openfair:** creator-configurable fee split (up to keeping 100%) is
  a meaningfully more creator-friendly model than pons's fixed 70/30 and
  costs little to support if the launch config already carries a
  `feeWallet`/recipient field — worth considering as a launch-time parameter
  rather than a protocol constant.
- **From Uniswap Pools' market pressure on pons:** a 1% pool fee is now
  publicly characterized by a major competitor as predatory ("2% spread,"
  "the primary method of extraction"), and that competitor is already
  out-launching pons by volume on the same chain. A fixed-supply/instant-V3
  recreation of pons should not treat 1% as sacred — a lower default fee
  tier (Uniswap V3 supports 0.3%/0.05% tiers, not just 1%) or a
  creator-configurable tier is worth deliberate consideration rather than
  copying pons's number unexamined.
- **From Noxa's collapse:** an instant-listing model with *zero* anti-snipe
  or anti-spam gate at all is not a safe design to copy wholesale — Noxa is
  the empirical case of "instant Uniswap V3, no tax, no cap" going to 60k
  tokens and $12M in fees and then collapsing under spam within roughly two
  months of Robinhood Chain's mainnet launch. This is direct evidence that
  pons V1's restriction window (however short at 2 blocks) is doing real
  work that a from-scratch recreation must not drop for the sake of
  simplicity.

**Bottom line:** build the pons V1 shape (fixed supply, atomic instant
Uniswap V3 listing, short restriction-window anti-snipe on max-wallet and
max-buy), not the pons V2 shape (bonding curve). Strengthen it with
hood.fun's pre-restriction non-transferability and immutable fee snapshot,
consider pons V2's declared-exemption-list pattern if legitimate multi-wallet
team buys need to be supported without opening the door to snipers, and treat
both the fee tier and the fee split as configurable decisions rather than
pons's own fixed numbers, given that a live competitor is already winning
volume by undercutting exactly those two numbers.
