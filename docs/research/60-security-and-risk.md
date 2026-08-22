# 60 — Security & Risk Assessment

**This document gates the build order.** Nothing in this project touches mainnet, and no
contract in this project custodies a single unit of real value, until every item in
[§7 "What MUST happen before mainnet"](#7-what-must-happen-before-any-mainnet-deploy) is
done and signed off. That is not a formality — it is the actual order of operations the
rest of the docs in this folder assume.

The evidence base for this document is twofold: (1) the reverse-engineered behavior of the
live `ponsfamily.com` launchpad (v1 `PonsLaunchFactory` and v2
`PonsV2LaunchFactory`/`PonsV2LaunchDeployer`/`PonsV2LaunchForwarder`/curve), as recorded by
the sibling `pons-launcher` repo, which calls those contracts in production and had to
learn their exact edge cases to do so safely; and (2) well-established smart-contract
security practice (reentrancy, access control, ERC-20 hostility, DoS, oracle/AMM
manipulation) that applies to any launchpad regardless of whose factory it is. Local
citations are `file:line`. This project (`launchpad-01`) is building its **own** factory,
token, and lock contracts — the pons references below are the closest real-world analogue
of what we are about to build, not code we can import.

---

## 1. The blunt reality

**Deploying unaudited, money-handling contracts to mainnet risks total, irreversible loss.**
Not "risks a bug" — risks the entire treasury, every launched token's liquidity, and every
user's deposited funds, in one transaction, with no recourse. This is not hyperbole for
this category of software:

- A factory that collects launch fees and mints pools is a **fund custodian** from the
  moment it goes live, even before anyone calls it a "vault."
- A launch transaction is **irreversible and unpausable by design** — the whole value
  proposition of an atomic launch is that nothing can stop it mid-flight, which cuts both
  ways: a bug discovered after the first real launch cannot be un-launched.
- Liquidity locked by *this* project's contracts is liquidity this project's contracts can
  also *unlock*, by construction, unless the unlock path is deliberately designed to be
  unreachable early. Every rug pull in this category of DeFi is a variant of "the lock
  wasn't actually a lock."
- This class of contract is the single most heavily attacked category of code that exists
  on public blockchains. Anyone can read the bytecode, anyone can simulate a call against a
  mainnet fork before spending a cent, and the incentive to find a bug before it is patched
  is direct and enormous (the bug **is** the money).

The correct posture is: assume every line will be read by a motivated, well-funded
adversary within minutes of verification, and assume that adversary has better tooling
(Foundry, Slither, Mythril, fork-simulators, MEV infrastructure) than the team that wrote
the contract. Nothing below is optional because "we'll fix it if something goes wrong" —
there is frequently no "after" to fix it in.

---

## 2. Threat model

| Actor | Capability | Motivation |
|---|---|---|
| Sniper bot | Watches for pool-creation / launch events, submits transactions in the same or next block, simulates every call against a fork before sending | Buy the token cheaper than fair, sell into later buyers |
| MEV searcher / sequencer-adjacent actor | Can reorder, sandwich, or (on some chains) see pending state before it lands | Extract value from any transaction with slippage tolerance |
| Malicious token deployer (using *our* launchpad against itself) | Full control over `TokenParams` fields, can deploy an ERC-20 with hostile `transfer`/`transferFrom` logic if the token contract isn't the launchpad's own fixed bytecode | Trick our own trading/quote/distribution paths into misbehaving |
| Malicious "helper" contract interacting with the factory | Can call any external function, reenter, or exploit fee-on-transfer-style tokens | Steal in-flight ETH/tokens during a launch or trade |
| Compromised admin / owner key | Whatever privileged functions the factory or lock exposes | Rug: redirect fees, disable restrictions, drain locked liquidity, rotate configs to a malicious router |
| Operator error (not malicious, just wrong) | Runs the deploy scripts, sets config values, funds wallets | Same blast radius as an attack, with none of the intent |
| Chain-level actor (sequencer, in a sequencer-ordered chain like Robinhood Chain) | Total ordering control within its own chain | Not normally adversarial to the launchpad itself, but changes what "front-running" even means (see §5) |

The one structural fact that shapes everything else: **a launch transaction creates a pool
that has never existed before, and the first swap against it happens inside the same
transaction as its creation.** That collapses the entire "front-running the launch" problem
(nobody can front-run a pool that doesn't exist yet) but does **not** collapse the
"front-running the *next* block" problem, "sandwiching a later trade" problem, or "the
factory itself is malicious/broken" problem. Confusing "atomic launch defeats snipers" with
"the system is secure" is the single most common conceptual trap in this design, and it is
one the pons design docs explicitly reasoned about (see `docs/superpowers/specs/...` in the
sibling repo, quoted throughout below) — it is worth re-deriving from scratch for our own
contracts rather than assuming it transfers.

---

## 3. Factory risk

The factory is the single contract every launch and every fee flows through. It is the
highest-value target in the system because compromising it compromises every token ever
launched through it, not just one.

### 3.1 Fee collection

- **What can go wrong:** `launchFee` (or equivalent) silently under-collected due to a
  rounding/ordering bug in how `msg.value` is split between fee and initial-buy amount; a
  path that lets `launchToken` succeed with `msg.value < launchFee` (should revert, e.g.
  pons v2's `LaunchFeeNotPaid()` error — *pons-launcher/backend/src/evm/v2/abi.js:191*);
  fee funds sent to an address that can't receive them (a contract with no `receive()`/
  `fallback()`), silently stranding value or reverting the whole launch.
- **What we must verify by test, not by reading:** `msg.value - fee = initialBuyAmount`
  arithmetic is exact for every value including `msg.value == fee` (zero dev buy, must not
  revert) and `msg.value < fee` (must revert, never underflow-wrap in an unchecked block).
  Solidity ≥0.8 reverts on underflow by default, but any `unchecked {}` block around this
  arithmetic reintroduces the classic wrap-to-huge-number bug — **grep every `unchecked`
  block in the factory as a first-pass audit step.**
- **Design takeaway:** fee accounting must be a single, tested, pure function
  (`splitValue(msg.value, launchFee) -> (fee, buyAmount)`) exercised by property-based
  tests (fuzz over the full `uint256` range, not just "reasonable" launch fees), not
  arithmetic inlined at the call site.

### 3.2 Atomicity of deploy → pool → (optional) buy

This is the core safety property the pons design leans on entirely
(*pons-launcher/docs/superpowers/specs/2026-07-25-pons-launcher-design.md:17-41*):

> `PonsLaunchFactory.launchToken` is `payable` … Any `msg.value` above `launchFee` becomes
> `initialBuyAmount`, which the factory swaps for the new token **inside the same
> transaction** … There is therefore no race to win for the dev buy. The pool does not
> exist until this transaction executes, and our buy is the first swap inside it.

For our own factory, this property is **only as strong as every external call inside
`launchToken` succeeding or the whole transaction reverting**. Concretely we must verify:

- Token deploy, pool creation, liquidity seeding, position lock, and (optional) initial buy
  either **all** happen or **none** happen — no partial-completion state where, say, the
  token exists but the pool doesn't, or the pool exists but liquidity wasn't locked. This
  is naturally true if every step is a plain internal call with no swallowed reverts (no
  bare `.call()` whose return value is checked with `if (!ok) { /* ignored */ }`), but it
  must be **tested**, specifically with a mock DEX/position-manager that reverts on each
  step in turn, asserting the whole `launchToken` call reverts and no state (no token
  contract at a determinable address, no fee taken) persists.
- **A `CREATE2`/deterministic-address path (needed for pre-signed bundle buys, mirroring
  pons v1's `predictTokenAddress` and v2's `predictLaunchAddresses`) must be verified live,
  not just unit tested**, because a caller silently sending value to a not-yet-deployed
  address **succeeds and burns the funds** — the EVM does not revert a plain ETH transfer
  to an address with no code. This exact failure mode is called out explicitly in the pons
  v2 client code: *pons-launcher/backend/src/evm/v2/factory.js:17-20* — "Two independent
  derivations of the curve address have to agree, because the cost of being wrong is every
  bundle wallet buying at an address with no contract — which on the EVM SUCCEEDS and
  silently keeps the money." Our own prediction function must be cross-checked against a
  static call of the real deploy path before it is trusted by any off-chain caller, and this
  cross-check should itself be an automated test, not an operator habit.
- **The initial-buy leg is a swap against a pool that was just created in the same
  transaction, at whatever price the seeded liquidity implies.** There is no external price
  reference to validate against yet (no history), so `amountOutMinimum` for that specific
  swap is necessarily `0` or derived purely from the deterministic seed ratio — confirm this
  is a deliberate, reviewed decision (pons' own `_executeInitialBuy` passes `0`, see
  *pons-launcher/docs/superpowers/specs/2026-07-25-pons-launcher-design.md:222-226*), not an
  oversight, and confirm nothing downstream (UI, docs) misrepresents this as "slippage
  protected."

### 3.3 Reentrancy

- `launchToken` **must** carry a reentrancy guard (`nonReentrant` in OpenZeppelin's idiom)
  around the full deploy→pool→buy sequence, because it makes multiple external calls
  (token constructor if it does anything beyond storage init, DEX factory, position
  manager, router) before all of its own state (`launchFee` accounting, the
  per-token launch record) is finalized. Pons' own v2 error set explicitly includes
  `ReentrancyGuardReentrantCall()` (*pons-launcher/backend/src/evm/v2/abi.js:211*),
  confirming the real contracts use a guard — treat its presence as required, not
  optional, on **every** state-mutating external entry point: `launchToken`, any `sell`/
  `buy` function on a bonding curve, any `claim`/`sweep`/`graduate` function, and the
  liquidity lock's `unlock`.
- **Checks-effects-interactions** must hold even with a guard present — a reentrancy guard
  stops re-entry into the *same* function, it does not stop a **cross-function** reentrancy
  attack (call `launchToken`, which reenters through a hostile callback into a *different*
  unguarded function that reads stale state). Any function that reads factory-owned mutable
  state (config, fee accounting, launch records) must either also be guarded or must not
  trust state that could be mid-mutation.
- A specific pattern to test explicitly: a **malicious `TokenParams.feeWallet`, or a
  malicious pair-token/quote-token, that reenters on `receive()`/`transfer` hooks.** The
  BundleDistributor contract in the sibling repo explicitly designs around a related class
  of hostility (arbitrary recipients array, hostile ERC-20 in `transferFrom`) — see
  *pons-launcher/backend/src/wallets/... / holdings.js:1-16*: "A hostile ERC-20 can do
  anything it likes inside `transferFrom`, including behaving differently per address."
  Assume any externally-supplied address (fee recipient, pair token, exemption list member)
  is a potential attacker-controlled contract and design the call graph so that no
  invariant depends on that address behaving honestly.

### 3.4 Access control

- **Enumerate every privileged function up front** (add/enable/disable a launch config,
  add/enable/disable a dex config, change `launchFee`, change fee recipient, pause/unpause,
  whitelist a launcher). For each: who can call it, is the change timelocked, is the change
  logged via an event, and — critically — **can it retroactively change the terms of an
  already-launched token?**
- Pons' own client code flags this exact hazard for configs read live: describing why a
  token's *own* immutable launch record is preferred over the live (mutable) config,
  *pons-launcher/backend/src/evm/factory.js:106-109*:

  > "The pool this token actually launched into, per token. Preferred over the launch/dex
  > config, which can be edited by the factory owner after the fact — the record cannot."

  This is the correct pattern and we should build it in from day one: **every launch must
  snapshot the config values it used into an immutable per-token record at launch time**
  (pair token, pool fee, dex/router addresses, restriction parameters, graduation
  threshold). Nothing about an already-launched token's trading rules should be able to
  change because an admin edited a shared config afterward. This is both a security property
  (an admin-key compromise can't retroactively alter live tokens) and a trust property
  (users need to know the rules of a token they hold cannot move under them).
- **`canLaunch()`-style compound gates are a foot-gun for anyone building tooling against
  the factory**, and by extension for our own admin tooling: pons v2 has a `canLaunch()`
  view that is the *real* gate, and a `whitelistedLaunchers` mapping that is only one input
  to it — reading the mapping alone gives a wrong answer
  (*pons-launcher/backend/src/evm/v2/factory.js:126-134*, *abi.js:68-73*). If our factory
  has more than one gating input, expose a single composed `canLaunch()`/`canX()` view that
  is the actual authority, and never let any off-chain code (ours or a third party's)
  reimplement the gating logic by reading raw storage.
- **Ownership of the factory itself:** a single EOA owner is a single point of catastrophic
  failure. At minimum, plan for a multisig (Safe or equivalent) behind any privileged
  function that can affect already-launched tokens' economics, and a **timelock** on
  anything that changes fee recipients, router/dex wiring, or launch-config parameters —
  pons v2's own error set includes `TimelockNotElapsed`, `TimelockExpired`, `NoPendingChange`
  (*pons-launcher/backend/src/evm/v2/abi.js:217-218,194*), which strongly suggests their own
  admin-mutation path is timelocked. Treat "no timelock on an admin function that can
  redirect money" as a launch-blocking finding in review, not a style nit.

### 3.5 Denial of service

- **Unbounded loops over caller-supplied arrays are the classic DoS vector** in exactly
  this kind of contract: an exemption list, a recipient/shares fan-out list, a batch of
  configs. Pons v2 caps its snipe-tax exemption list at 32 entries for exactly this reason
  (gas-bounding a loop the factory itself walks), and the *forwarder* wrapper caps it one
  lower because it appends its own recipient before forwarding
  (*pons-launcher/backend/src/evm/v2/abi.js:143-155*) — a caller who doesn't know this
  reverts, but does not corrupt state or brick anything, because the check happens before
  any state mutation. **Every caller-supplied array in our factory or token must have an
  explicit, enforced upper bound, checked before any external call or state write**, and
  the bound must be chosen so the resulting loop's gas cost is comfortably inside a block
  gas limit with margin (not "exactly at the edge").
- **A single misbehaving external call inside a loop must not be able to block the whole
  transaction for everyone else.** The sibling repo's `BundleDistributor.sol` fan-out
  (*pons-launcher/contracts/BundleDistributor.sol:289-307*) reverts the whole transaction on
  the first failed `transfer` — acceptable there because the caller controls the recipient
  list and it's an owner-only, single-purpose contract, but **not** an acceptable pattern
  for a factory-level flow whose ultimate recipients might be attacker-influenced (e.g., a
  liquidity distribution or fee-splitting path with third-party recipients). Where third
  parties can be recipients, use a **pull-payment** pattern (recipient calls `claim()`
  later) rather than a push loop, so one broken/griefing recipient can't block or grief
  everyone else's funds.
- **Griefing the launch-fee economics via spam launches:** if `launchFee` is too low
  relative to the gas + state cost of a launch, the factory becomes a cheap way to spam
  storage/events; if configs are per-launch-config rather than per-launch, a malicious actor
  filling up a bounded array of configs (if any exists) could DoS legitimate config
  additions. Model the cost of every state-growing operation against an attacker who can
  call it as many times as they can pay gas for.
- **RPC/indexing-layer DoS is a real, already-observed failure mode**, distinct from
  contract-level DoS but directly relevant to anything (our own indexer, sell-picker, or
  analytics) that walks factory event logs: the sibling repo's holdings-scan code hit a
  production hang because an RPC provider silently refused wide-range `eth_getLogs` calls
  and the retry/backoff logic turned that into an effectively infinite loop
  (*pons-launcher/backend/src/evm/v2/holdings.js:96-115*, code comment: "THE UNBOUNDED WALK
  HUNG /api/sellable IN PRODUCTION"). Any off-chain service built against our factory's
  events must bound its own scan windows, retries, and wall-clock budget — this is an
  operational security requirement, not just a performance one, because an indexer that
  hangs silently is exactly the kind of failure that hides a factory-level incident from
  operators (see also §7's alerting requirement).

---

## 4. Token risk

### 4.1 Supply / mint correctness

- **Total supply must be fixed at construction and unmintable thereafter**, unless minting
  is an explicit, reviewed design decision with its own access-control and rate-limit
  analysis. An ERC-20 launched through a permissionless factory that retains a hidden
  `mint()` reachable by *any* privileged address is the single most common rug-pull pattern
  in this space — it must not exist unless a specific, documented feature requires it, and
  if it does exist it needs its own dedicated threat-model entry (who can call it, what
  caps it, is it timelocked, is it visible in the ABI or hidden behind a proxy).
  Recommendation: **no mint function at all** in the launched token; supply is minted once,
  entirely, at construction, matching the pons pattern (`supply` is a config-time constant
  baked into `LaunchConfig`/`LaunchDeployment`, *pons-launcher/backend/src/evm/abi.js:17*,
  *v2/abi.js:44-46*).
- **Decimals, symbol, name must not be attacker-influenced in a way that breaks downstream
  assumptions.** Free-text fields (`name`, `symbol`, `description`, social links) flow
  directly from caller input into on-chain storage in the pons `TokenParams` struct
  (*pons-launcher/backend/src/evm/abi.js:9-12*) — this is fine for the token itself (no
  execution risk from a string), but **any off-chain code (ours) that renders these fields
  must treat them as untrusted, unsanitized user input** (XSS if rendered as HTML, log
  injection if logged raw, etc.). This is a web-app-security note attached to a
  smart-contract-security doc because the trust boundary crosses from chain to UI here.

### 4.2 The snipe-tax / launch-block restriction must be un-bypassable

This is the economic core of the whole product and the single property most worth
adversarially reviewing, because if it can be bypassed, the entire "fair launch" pitch is
false advertising with real money behind it. Two independent designs exist in the pons
lineage and both are worth studying as prior art:

**v1-style: a transfer-hook cap keyed on `_isPairPool(from)`.**
(*pons-launcher/contracts/BundleDistributor.sol:20-30*, describing the token's own hook):

```solidity
bool isRestrictedBuy = _isPairPool(from);
if (!isRestrictedBuy) { super._update(from, to, value); return; }
```

The cap (max wallet, cumulative buy cap) applies **only** when the sender is the pool
itself. The sibling repo's own contract comment identifies the exact loophole this creates
and *exploits it on purpose, transparently, for a legitimate use* (large buy lands on a
distributor contract, which is not the pool, so the fan-out to many wallets is uncapped) —
which means **the same technique is available to an adversary with no legitimate purpose**.
Anything that can receive from the pool once and then redistribute is a way to launder an
arbitrarily large position past a per-wallet cap. If our token uses this hook shape, we must
explicitly decide and document: is a large buy-then-fan-out through an intermediate
contract an accepted, priced-in behavior (as pons treats it), or is it a bug we need to
close (e.g., by capping on `to` as well as gating on `from`, or by tracking beneficial
ownership through a distributor some other way)? **Do not let this be an accidental gap —
make it a reviewed decision either way.**

**v2-style: a decaying snipe tax with a declared exemption list.**
(*pons-launcher/backend/src/evm/v2/abi.js:20-30*): every buy in the opening window pays a
tax starting near 100% and decaying to zero over a short window, charged on the recipient;
up to N addresses can be declared exempt **atomically inside the launch call only**. Risks
specific to this shape, all of which need dedicated tests:

- **The exemption list must only be settable inside the launch transaction itself**, never
  addable afterward by any caller (including the deployer) — otherwise "exemption" becomes
  a permanent backdoor around the tax for whoever can call the setter, defeating the tax
  entirely for insiders while it still bites real buyers. Verify there is no
  `addExemption`/`setSnipeTaxExempt` function reachable after the launch block, or if there
  is, that it is at least as tightly access-controlled and timelocked as any other
  fee-changing admin function (§3.4).
- **The decay function's time source must be unmanipulable.** If it decays by `block.number`
  it inherits whatever block-time assumptions the chain has (fine on a fixed-cadence
  sequenced chain, exploitable if block time is attacker-influenceable, e.g., some L2/L3
  sequencer designs or PoW chains with grinding). If it decays by `block.timestamp`, model
  the known ~tens-of-seconds miner/validator manipulation tolerance most chains allow, and
  confirm the tax window is long enough that this tolerance is immaterial (pons v2's window
  is only ~3 seconds live per the sibling repo's transcription — *abi.js:24* — which is
  **short enough that timestamp manipulation tolerance could matter**; this is exactly the
  kind of parameter that needs a dedicated adversarial review, not just a functional test).
- **The exemption-list cap must be enforced identically wherever it is checked.** The
  sibling repo found the *forwarder* silently accepts one fewer than the *factory*, because
  the forwarder appends its own buy recipient before forwarding — an off-chain integrator
  who didn't discover this by probing the live contract would build a UI that reverts on
  exactly the configuration (a full 32-address bundle plus a dev buy) an operator is most
  likely to want (*pons-launcher/backend/src/evm/v2/abi.js:146-155*). For our **own**
  contracts we control both sides, so this exact bug is avoidable — but the general lesson
  is: **any wrapper contract that composes with a capped array must recompute the cap it
  actually enforces, and this composition must be unit tested against the wrapper, not just
  against the inner contract.**
- **"Only on pool→user buys" must be verified against every possible transfer path,
  including via a router that does an intermediate hop, a flash-loan-funded single-block
  buy/sell, and a same-block buy-then-sell.** Write an explicit test: buy the max allowed,
  attempt to buy again in the same block/tx via a second entry path (direct pool call,
  router call, a helper contract) and confirm the cumulative cap holds cross-path, not just
  per-call-site.
- **The restriction window's absolute duration is a parameter worth stress-testing rather
  than trusting.** Pons v1's own window is *two blocks*
  (*pons-launcher/docs/superpowers/specs/2026-07-25-pons-launcher-design.md:261-264*: "The
  restriction window is only 2 blocks. Protection lapses almost immediately, so landing in
  block 0 or 1 is the whole game.") — whatever window we choose, model explicitly what
  fraction of "fair launch" protection depends on it, and treat shrinking it (by config
  change or by a chain that produces blocks faster than assumed) as a security-relevant
  event, not a UX tweak.

### 4.3 Exemption-list integrity

Beyond the cap-consistency issue above:

- **Exemption membership must be checked against the actual transaction's recipient, not
  against `tx.origin` or a value that can be spoofed by an intermediary contract.** The v2
  ABI checks `snipeTaxExempt(address account)` and `currentSnipeTaxBps(address recipient)`
  against the **recipient** of the buy (*pons-launcher/backend/src/evm/v2/abi.js:135-138*,
  comment: "Checked against the RECIPIENT of the buy, so a bundle wallet buying for itself
  must be on the list.") — confirm our own implementation does the same, and write a test
  where a non-exempt wallet routes a buy *through* an exempt contract to land tokens on
  itself, confirming the tax still applies (or is deliberately not applicable, as a reviewed
  decision, analogous to the v1 fan-out loophole in §4.2).
- **The exemption list must not be forgeable or extendable by the same transaction's other
  arguments** — e.g., a `tokenDeployer`/`recipient` parameter that silently gets added to
  the exemption set without appearing in the explicit exemptions array would be an invisible
  backdoor. Every address that ends up tax-exempt must be traceable to either (a) the
  explicit exemption array, capped and validated, or (b) the single, documented
  "initial-buy recipient, launch block only" exemption pons v1 uses
  (*pons-launcher/docs/superpowers/specs/2026-07-25-pons-launcher-design.md:83-88*). Any
  third path is a bug.

---

## 5. Liquidity lock risk

**The question that matters is not "is there a lock function" — it is "who, concretely, can
cause the locked liquidity to move before its intended unlock condition, and by what call
path."** Every rug pull that presents itself as "the liquidity was locked" is a case where
that question had an answer nobody had reviewed.

Concretely enumerate and adversarially test each of the following for our own lock design,
whatever shape it takes (locked LP-NFT position, timelocked LP-token vault, a
factory-held position with no unlock function at all until graduation):

1. **Who holds the LP position/tokens, literally?** If it's an NFT (e.g., a Uniswap v3/v4
   position), which address is `ownerOf` it — the factory, a dedicated lock contract, or an
   EOA? Pons v1's `LaunchedToken` record includes `positionManager` and `positionId` fields
   (*pons-launcher/backend/src/evm/abi.js:32-34*), which means **the factory (or whatever it
   delegates to) is the position's custodian by construction** — so the factory's own access
   control (§3.4) *is* the liquidity lock's access control. There is no separate "lock
   contract" to reason about in that design; the security of the lock reduces entirely to
   "can anything call `positionManager.collect()` / `decreaseLiquidity()` /
   `burn()`/transfer the NFT away, for this `positionId`, before the intended unlock
   condition?" Answer that with a full call-graph review, not an assumption.
2. **Is there an explicit unlock function, and if so, what gates it?** Time-based
   (`block.timestamp >= unlockAt`), condition-based (graduation threshold reached,
   analogous to pons v2's bonding-curve-to-pool graduation), or admin-triggered
   (`onlyOwner`)? An admin-triggered unlock with no timelock **is not a lock** — it's an
   IOU from whoever holds the admin key. If any unlock path is admin-gated, it must carry
   the same timelock + multisig scrutiny as any other privileged factory function (§3.4),
   and the UI/docs must never describe it to end users as an unconditional lock.
3. **Is there a "rescue" path, and does it have its own timelock?** Pons v2's error set
   includes `GraduationRescueTooEarly(uint256 availableAt)`, `GraduationStillViable()`,
   `NotReadyToGraduate()`, `NothingToGraduate()`, `WrongGraduationPhase()`
   (*pons-launcher/backend/src/evm/v2/abi.js:175-177,200-201,221*) — strongly suggesting the
   live contracts have a deliberate, timelocked escape hatch for a graduation that becomes
   non-viable (e.g., a curve that never reaches its threshold), rather than stranding funds
   forever. This is good practice to emulate: **build the "this failed permanently, how do
   we not strand user funds" path in from day one**, as a timelocked, narrowly-scoped rescue
   — not as a discovered-in-an-emergency admin backdoor with no time bound, which is
   indistinguishable from a rug to an outside observer.
4. **Can the lock be drained via the token contract rather than the position/LP contract?**
   If the launched token has any privileged function (even one intended for a legitimate
   purpose, e.g., a fee-adjustment knob) that can alter the pool's effective reserves,
   disable trading, or blacklist the pool address itself, that is an indirect way to make
   locked liquidity worthless without ever touching the lock. Audit the token contract for
   *any* function that changes behavior based on `msg.sender == owner`/`deployer`, and
   confirm none of them can be used to functionally rug a pool whose LP position is
   nominally "locked."
5. **Graduation is a state transition with money on both sides of it — model it as its own
   mini-factory.** In the pons v2 shape, a bonding curve holds real ETH/quote-asset reserves
   right up until graduation moves them into a permanent AMM pool. Every risk in §3
   (reentrancy, atomicity, access control, DoS) applies again, independently, to whatever
   function performs that transition, because it is itself a fund-moving operation gated by
   a threshold that (per §4.2's lesson) must be read from an immutable per-launch record,
   not a live mutable config.
6. **Never let "locked" be a documentation claim without an on-chain, independently
   verifiable enforcement.** If the answer to "who can move this before the unlock
   condition" is "nobody, by construction, because there is no function that can" — prove
   it with a test that tries every conceivable call path (owner, non-owner, the token
   contract itself via a callback, a reentrant call from within the launch/graduation
   transaction) and asserts each one reverts.

---

## 6. Trading / quote path risk

This is the surface most exposed to the open adversarial market (bots, MEV, arbitrageurs),
not just to a compromised insider.

- **`amountOutMinimum`/`minTokensOut`/`minQuoteOut` is a deliberate design decision at every
  call site, not a default to leave at zero out of laziness.** The sibling repo makes this
  decision explicitly and differently at different call sites, and each decision is
  recorded:
  - The atomic initial buy inside a launch has **no** price history to slip against, so `0`
    is correct there (*pons-launcher/docs/superpowers/specs/2026-07-25-pons-launcher-design.md:222-226*).
  - A pre-signed bundle buy, signed before the pool exists, similarly has nothing to quote
    against, so `SLIPPAGE_PCT` was deliberately removed as a no-op config knob
    (*same file, same lines*) — but the per-address cap (§4.2) is what actually bounds
    exposure, and that substitution must be true for **any** design that drops a price
    floor, not assumed.
  - A **live** trade against an established pool (any ordinary swap, or the sell-all flow)
    is a completely different situation and **must** have a real, non-zero floor unless the
    zero is an explicit, user-visible, opted-in choice. The sibling repo's own "sell-all"
    design deliberately chooses `minQuoteOut = 0` for a *specific, stated reason*
    (fastest possible exit, operator-approved, risk written down at decision time —
    *pons-launcher/docs/superpowers/specs/2026-08-06-sell-all-design.md:19-22*: "Accepted
    risk: a sell into a drained curve or behind a front-runner can return near zero and
    still succeed."). **The lesson is not "zero is fine" — it is "every zero-floor decision
    must be this explicit, this documented, and this deliberately scoped."** A default UI
    flow for an ordinary end-user swap must never silently inherit a zero floor from a
    different flow's justified exception.
- **Router/DEX integration must not trust a router-shape assumption that later drifts.**
  Pons switches between two different `exactInputSingle` ABI shapes (one with a `deadline`
  field, one without) based on a config flag (`routerRequiresDeadline`)
  (*pons-launcher/backend/src/evm/abi.js:54-64*) — get this wrong and either the call
  reverts (safe, if noisy) or, worse, silently miscalls a function with an incompatible
  argument layout. **Any function selector built from a struct whose shape depends on a
  runtime flag needs a test matrix covering every flag value, and ABI-encoding correctness
  needs its own dedicated test independent of a happy-path integration test.**
- **Deadline handling matters and is easy to get backwards.** A swap without a deadline (or
  with `deadline = type(uint256).max`) can sit valid indefinitely if it's ever exposed via a
  path that allows delayed execution (it should not be, for anything we build server-side
  and broadcast immediately, but this becomes relevant the moment any user-facing "sign now,
  submit later" flow exists). Any deadline we do set must be short enough to bound MEV/stale
  quote exposure without being so short that ordinary confirmation latency causes spurious
  reverts.
- **Treat every externally-supplied token address in the trading path as a potential hostile
  contract**, exactly as the sibling repo's holdings/sell-picker code does
  (*pons-launcher/backend/src/evm/v2/holdings.js:1-40*): a hostile ERC-20 can behave
  differently in `transferFrom` per caller, can return `true` on `approve`/`transfer` while
  doing something else, can consume unbounded gas, or can attempt reentrancy through a
  transfer hook. **Provenance must never be established by asking the token about itself**
  (`token.deployer()`, `token.launchFactory()`) — it must be established by asking the
  contract we already trust (our own factory's own launch record), exactly as pons does:
  *pons-launcher/backend/src/evm/factory.js:90-97* — "Deliberately NOT the token's own
  `deployer()`/`launchFactory()` getters: those are self-reported, and a dusted ERC-20 can
  claim whatever it likes about itself." Any code we write that decides "is this one of
  ours" for the purpose of enabling a privileged action (fee claim, sell routing, display in
  a trusted list) must gate on our own factory's record, never on the token's self-reported
  state.
- **Approvals must be minimal and short-lived.** `approve(spender, exact_amount_needed)`
  immediately before use, never a standing/unlimited allowance left behind — this is
  explicitly a design decision in the sibling repo's sell-all spec
  (*pons-launcher/docs/superpowers/specs/2026-08-06-sell-all-design.md:38-40*: "No standing
  allowance is left behind, so a wallet reused for a later launch carries no lingering
  permission to a contract it no longer trades with.") Apply the same discipline to any
  contract-to-contract approval inside the launchpad itself (e.g., a factory approving a
  router to spend a wrapped-native token during the initial buy).
- **Price/tick manipulation at seed time.** Whatever mechanism sets the pool's initial price
  (an `initialTick` for a concentrated-liquidity pool, or a phantom/virtual reserve for a
  bonding curve) is effectively an oracle input with no external check the first time it's
  used — confirm it is derived entirely from the immutable per-launch config (§3.4) and
  cannot be influenced by `msg.sender`-controlled parameters at launch time in a way that
  lets a launcher mint themselves a favorable starting price beyond what the public config
  intends.

---

## 7. What MUST happen before any mainnet deploy

This is a gate, not a checklist to skim. Every item below blocks mainnet deploy until done.

### 7.1 Testing (must all exist and pass, with the properties named, not just "tests pass")

1. **Unit tests for every function**, including every custom error/revert path — not just
   the happy path. For the factory: fee-splitting arithmetic across the full input range,
   every access-control gate with both an authorized and unauthorized caller, every
   caller-supplied-array bound (empty array, one-under-limit, at-limit, over-limit).
2. **Invariant/property-based (fuzz) tests**, not just example-based unit tests, for:
   - Total supply conservation across launch + any subsequent trading (nothing is minted or
     destroyed that shouldn't be).
   - The per-address buy cap holding across *every* call path that can deliver tokens from
     the pool during the restriction window, including through intermediate contracts,
     multi-hop routers, and same-block repeated calls.
   - The exemption list never containing more addresses than the enforced cap, at every
     call site that can populate it (factory-direct and any wrapper/forwarder).
   - "Nothing can move the locked liquidity before the unlock condition" as an explicit,
     asserted invariant, fuzzed over arbitrary caller addresses and arbitrary call
     sequences (Foundry's `invariant_` tests or Echidna are the standard tools for this).
3. **Static analysis** (Slither at minimum; Mythril/Semgrep-for-Solidity as a second
   opinion) run to zero unexplained high/medium findings. Every finding must be either
   fixed or have a written, reviewed justification for why it's a false positive or
   accepted risk — "the tool complained but we think it's fine" is not a disposition,
   it's an unreviewed risk.
4. **Fork tests against the actual target chain**, not just a local Anvil/Hardhat network
   with mocked dependencies: deploy the real factory/token/lock against a mainnet fork,
   using the *real* DEX factory, position manager, router, and WETH-equivalent addresses
   the deployment will actually use. This is the only way to catch integration-shape bugs
   like pons' own `routerRequiresDeadline` branch, or an unexpected revert reason from a
   third-party contract's actual bytecode versus its documented ABI.
5. **A dry-run mode that signs/simulates everything and broadcasts nothing**, exercised as
   its own test suite, mirroring the sibling repo's `DRY_RUN=true` default and its explicit
   test coverage of "a fake-provider integration test asserting the launch transaction is
   broadcast before any buy, and that an early-reverting buy does not abort the rest of the
   bundle" (*pons-launcher/docs/superpowers/specs/2026-07-25-pons-launcher-design.md:237-241*).
   This is as much an operational-safety control as a test: it is what lets a new
   deployment or a new operator rehearse the entire flow with zero financial exposure.
6. **Explicit adversarial test cases for every risk enumerated in §3–§6 above**, each named
   after the specific failure mode (e.g., `test_RevertWhen_ExemptionListExceedsCapViaForwarder`,
   `test_Invariant_LockedPositionUnmovableBeforeUnlockTime`,
   `test_RevertWhen_HostileTokenReentersOnTransfer`), so the test suite is legible as a
   security checklist to a future reviewer, not just a coverage number.

### 7.2 Independent / adversarial review

- **At least one independent review by someone who did not write the contracts**, working
  from the threat model in §2 and the enumerated risks in §3–§6, before any testnet
  deployment that will handle anything resembling real value (including "worthless"
  testnet tokens people might still be tricked into valuing).
- **A professional third-party audit is required before mainnet**, full stop, for any
  contract that will custody real user funds (fees collected, liquidity locked, user
  deposits of any kind). "We reviewed it ourselves carefully" is not a substitute for an
  audit by a firm with no stake in the project shipping on time — the entire point of an
  external audit is the absence of the schedule pressure and sunk-cost bias the building
  team cannot help but have.
- **A public bug bounty**, scaled to the value at risk, live for a meaningful window before
  mainnet TVL grows past a small, capped pilot amount. Bounties catch classes of bugs
  (economic/game-theoretic exploits, unusual call-path combinations) that audits
  systematically under-cover because audits are time-boxed and bounties are not.
- **Re-review after every change.** A contract that passed audit and then had "one small
  fix" applied afterward is, from a security standpoard, an unaudited contract — the fix
  itself is exactly where new bugs are statistically most likely to be introduced (it's new
  code, written under pressure, reviewed less carefully than the original because "it's just
  a small fix").

### 7.3 Testnet + fork-test regimen — why it is mandatory, not optional

- **A public testnet deployment, run for a real length of time under real (if lower-stakes)
  adversarial conditions, is the only way to observe emergent behavior that unit tests
  cannot predict**: real bots will attempt to snipe a testnet launch if it's discoverable,
  real gas-price volatility will exercise edge cases in gas-limit assumptions, and real RPC
  provider quirks (rate limits, log-range refusals, spurious errors) will surface exactly
  the class of operational failure the sibling repo already hit in production
  (*pons-launcher/backend/src/evm/v2/holdings.js:96-115*, and the retrying-provider note at
  *pons-launcher/docs/superpowers/specs/2026-07-25-pons-launcher-design.md:121*: "the public
  RH RPC returns spurious `-32601`"). None of this shows up in a local Anvil test.
- **Fork tests catch what testnets can't**: testnets rarely have the same DEX/router
  deployments, the same liquidity depth, or the same third-party contract bytecode as
  mainnet. A mainnet fork test is the only way to validate against the *actual* contracts
  the launchpad will call in production — this is precisely why the pons client code
  insists on treating documentation-listed factory addresses as unreliable and instead
  verifying live behavior directly (*pons-launcher/backend/src/evm/v2/abi.js:10-14*: "NOT
  the address in the docs… That deployment has never emitted an event… found by scanning
  the chain… treat that documentation page as unreliable for addresses"). If a project as
  small as the sibling repo had to independently verify live contract behavior rather than
  trust documentation, our own launchpad's dependencies (whatever DEX/AMM it builds on)
  must be verified the same way, on a fork, before mainnet.
- **A staged mainnet rollout with a hard cap is the correct middle ground**, not a binary
  testnet→full-mainnet jump: first mainnet launches should be capped in size (small launch
  fee ceiling, small graduation threshold, or an explicit allowlist of launch configs), with
  monitoring and an emergency pause available, before the system is trusted with unbounded
  value. Treat "we've been live on mainnet for N launches with no incident" as evidence that
  accumulates, not as a milestone reached once and then forgotten.

### 7.4 Operational readiness (necessary, not sufficient, alongside the contract work)

- **Alerting must exist before any long-running or high-value operation.** The sibling
  project's own v4 operational notes are explicit that this was a real gap in a lower-stakes
  system: "Nothing alerts. A halted campaign writes an activity entry and stops. There is no
  push, and the console's 15s poll stops the moment nothing is running, so the readout
  freezes too." A launchpad holding real fees and real locked liquidity needs active,
  push-based alerting (not "check the dashboard") on: factory pause state changes, admin
  function calls, unusually large single-launch value, and any revert pattern spike.
- **Key management for any privileged (owner/admin/multisig-signer) role must be treated
  with the same rigor as the contracts themselves** — hardware-backed signing, documented
  key-rotation procedure, and (per §3.4) a genuine multisig with a timelock, not a single
  hot EOA "for now, we'll migrate later." Migrating "later" reliably does not happen before
  it matters.
- **A documented, rehearsed incident-response plan** for "we found a bug in a live
  contract": what can be paused, what cannot, who has the authority to act, and what the
  user communication plan is. Writing this after an incident starts is too late by
  definition.

---

## 8. How this gates the build order

Concretely, for this project:

1. Contracts (factory, token, lock, any graduation/curve mechanism) are designed and
   written with every item in §3–§6 as an explicit design constraint, not a retrofit.
2. The test suite in §7.1 is built alongside the contracts (test-driven, not
   after-the-fact) and is a merge-blocking CI gate.
3. Independent/adversarial review (§7.2, first bullet) happens before any testnet
   deployment that could plausibly be mistaken for something with value.
4. Testnet + fork-test regimen (§7.3) runs for a real period, with real attempts to break
   the snipe protections and the lock, before a professional audit is commissioned — fixing
   findings from a cheap internal pass before paying for an external audit's time on bugs we
   could have found ourselves is both cheaper and yields a better audit.
5. A professional audit (§7.2) and (budget-permitting) a live bug bounty happen before any
   mainnet deployment that will hold real value above a small, explicitly-capped pilot.
6. Mainnet rollout is staged and capped (§7.3, last bullet), with alerting and incident
   response (§7.4) live from the first mainnet transaction, not added after the first
   incident.

No later document in this project (architecture, contract spec, UI spec) should describe a
mainnet launch path that skips or reorders these gates. If a later document proposes doing
so, that is itself a finding to raise, not a schedule to accommodate.

---

## Sources

**Local (sibling repo, `pons-launcher`, reverse-engineering the live ponsfamily.com
contracts this project is recreating):**

- `pons-launcher/docs/superpowers/specs/2026-07-25-pons-launcher-design.md:17-41,60-92,222-278`
  — atomic launch/buy mechanics, restriction window, `TokenParams`, exemption rules, the
  2-block restriction window, retrying-RPC note, testing decisions.
- `pons-launcher/backend/src/evm/abi.js:1-88` — v1 `FACTORY_ABI`, `LAUNCH_CONFIG`,
  `LAUNCHED_TOKEN`, dual swap-router ABI shapes.
- `pons-launcher/backend/src/evm/v2/abi.js:1-241` — v2 factory/forwarder/curve ABIs, snipe
  tax and exemption-list mechanics, exemption cap discrepancy between factory and forwarder,
  full custom-error list (`V2_ERROR_ABI`) evidencing reentrancy guard, timelocks, and
  graduation-rescue design in the live contracts.
- `pons-launcher/backend/src/evm/v2/factory.js:1-155` — `canLaunch()` vs
  `whitelistedLaunchers` gating pitfall; address-prediction cross-check rationale (silent
  fund loss sending to a no-code address).
- `pons-launcher/backend/src/evm/factory.js:90-117` — immutable per-token launch record
  preferred over mutable live config; provenance must come from the trusted registry, not
  the token's self-reported state.
- `pons-launcher/contracts/BundleDistributor.sol:1-376` — real, in-repo Solidity: owner-only
  privileged spend paths, immutable non-transferable owner, hostile-ERC20-aware transfer
  handling, the `_isPairPool(from)` cap-bypass mechanism and its deliberate, transparent use.
- `pons-launcher/backend/src/evm/v2/holdings.js:1-115` — hostile-ERC20 provenance/dusting
  risk, RPC log-range DoS incident and its bounding fix.
- `pons-launcher/docs/superpowers/specs/2026-08-06-sell-all-design.md:19-40` — deliberate
  zero-floor risk acceptance, minimal/short-lived approval discipline.
- `pons-launcher/README.md:21-54,281-329` — restriction window summary, "verified on-chain"
  facts, top-level security posture for the operator-facing tool.
- `v4-operational-notes.md` (user memory, sibling project) — "Nothing alerts" operational
  gap, the one known double-fund reconciliation path; cited here as a direct precedent for
  why alerting (§7.4) is a launch-blocking requirement, not a nice-to-have.

**General smart-contract security practice (well-established, not project-specific):**
reentrancy guards / checks-effects-interactions, minimal-approval patterns, pull-over-push
payment design, timelocked + multisig admin control, static analysis (Slither/Mythril) and
invariant/fuzz testing (Foundry/Echidna) as pre-audit hygiene, and staged/capped mainnet
rollout — these are standard practice across the industry (OpenZeppelin's
`ReentrancyGuard`/`Ownable2Step` patterns, Trail of Bits' and ConsenSys Diligence's public
audit methodology writeups, and Foundry's invariant-testing documentation are the canonical
references for any team wanting the primary sources).
