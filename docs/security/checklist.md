# Security gate checklist — launchpad contracts

> **NOT MAINNET-READY until the audit gate (item 10) clears.** Everything below items
> 1–9 is evidence produced by the implementation team itself. Per the spec
> (`docs/superpowers/specs/2026-08-22-contracts-design.md` §Definition of done), this
> contract set is an irreversible, unpausable fund custodian — self-attestation is
> necessary but not sufficient. Independent adversarial review, a professional
> third-party audit, a bug bounty window, and a staged/capped rollout with
> hardware-backed multisig keys are **explicitly open** and are not satisfied by
> anything in this document.

Generated: 2026-08-22, branch `feat/contracts`, against the state of `contracts/` at
the top of commit history for this checklist (see the commit this file ships in).

## Summary table

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Fee/value math (`splitValue`, fuzzed, `unchecked{}` audited) | **DONE** | `test/FeeMath.t.sol`: `test_exact_fee_gives_zero_buy`, `test_splits_remainder_to_buy`, `test_reverts_below_fee`, `testFuzz_conserves_value` (512 runs, full `uint256` domain). No `unchecked{}` in `FeeMath.sol`. |
| 2 | Atomicity + CREATE2 cross-check | **DONE** | `test/LaunchFactory.t.sol` 5-step revert matrix (`test_launchToken_atomicity_{createPool,initialize,mint,lock,devBuy}_reverts`); `test_predictTokenAddress_matches_actual_create2_deploy_{zero,nonzero}_feeWallet`; runtime `assert(token == predicted)` in `launchToken`; fork-verified end-to-end (`test_fork_launch`). |
| 3 | Reentrancy guards (every state-mutating entry point) | **PARTIAL** | `LaunchFactory.launchToken` is `nonReentrant` + CEI-ordered (tested by the atomicity matrix). `Locker.collectFees` has **no** `nonReentrant` guard — Slither `reentrancy-events` confirms. See triage below: not fund-loss-exploitable against the current trusted token set, but flagged as a pre-audit hardening item, not closed. |
| 4 | Invariant/fuzz: supply conservation, cap-across-paths, exemption scope, lock immovability | **DONE** (scope-documented) | `Token.invariant.t.sol` `invariant_capHoldsInWindow` (256 runs / 8,192 calls / 0 reverts) on the direct pool→user path; router path closed by `test_fork_anti_snipe_cap` against the live V3 router; supply conservation is structural (`Token` has no burn path, single constructor `_mint`); exemption tests `test_launchBlock_buy_to_{launchBuyer,nonLaunchBuyer}_*`; lock immovability `test_no_selector_moves_the_position_out`. The buy-then-fan-out aggregation gap is an accepted, documented design property (not a bug), out of this invariant's scope by spec. |
| 5 | Access control enumerated, config snapshotted immutably, `canLaunch()` sole gate | **DONE**, minor test gaps noted | `Ownable2Step` on `LaunchFactory`/`Locker`; `onlyFactory` on `Locker.lockPosition`; `canLaunch` composition tested (`test_canLaunch_*`, 4 tests incl. the whitelist-footgun case). `setLaunchConfig`/`setDexConfig` have explicit not-owner revert tests; `setLaunchEnabled`/`setPublicLaunchOpen`/`setWhitelistedLauncher` (LaunchFactory) and `setFeeCollector`/`setProtocolWallet` (Locker) are `onlyOwner` in source and unflagged by Slither, but have **no dedicated not-owner revert test**. Config snapshot immutability verified by construction (`LaunchedToken` written once from a copied `LaunchContext`, independent of later config edits). |
| 6 | DoS — bounded arrays, pull payments | **DONE** (N/A + design review) | No caller-supplied array parameters exist anywhere in the public/external ABI (grep-verified) — the "bounded array" requirement is vacuously satisfied. Both payment paths are effectively griefing-proof: the ETH push (`protocolWallet.call`) targets an immutable, admin-set (not caller-supplied) address, and both ERC20 pushes (`Locker._distribute`, dev-buy delivery) move plain OZ `ERC20`/`SafeERC20` tokens, which have no recipient-side callback to grief a push. This is a design-review conclusion, not a dedicated DoS test. |
| 7 | Static analysis — Slither + Mythril to zero unexplained findings | **PARTIAL** | Slither run and fully triaged below: 23 findings (11 Medium / 6 Low / 6 Informational), 0 High, 0 exploitable reentrancy-eth/no-eth/arbitrary-send/controlled-delegatecall/suicidal findings. **Mythril was not run** — out of this task's brief scope (Step 1 named Slither only). Run Mythril before the audit gate closes. |
| 8 | Mainnet-fork tests against live DEX/router/WETH | **DONE** (prior-verified, not re-run this session) | `test/fork/Launch.fork.t.sol`: `test_fork_launch`, `test_fork_anti_snipe_cap`, both passing per Task 9's record against chain 4663's live Uniswap V3 (positions() tuple, mint params, no-deadline router, tick negation all matched production with no interface mismatch). Not re-executed in this session (requires network RPC); this task only re-ran the non-fork suite per its own instructions. |
| 9 | Dry-run/simulate suite, then testnet (46630) deployment + rehearsal | **PARTIAL — PENDING (testnet)** | `script/Deploy.s.sol` + `test/Deploy.t.sol` (`test_launch_succeeds_end_to_end_after_deploy`, wiring tests) constitute the dry-run/simulate suite and pass. **No actual testnet (46630) broadcast/deployment or rehearsal has occurred** — `Deploy.s.sol`'s own NatSpec confirms `run()` has never been invoked with `--broadcast`, and owner is currently defaulted to the deploying EOA (timelock/multisig handoff is an explicitly out-of-scope post-deploy step). |
| 10 | Gate to mainnet: independent adversarial review → professional audit → bug bounty → staged/capped rollout w/ alerting + incident response → hardware/multisig keys from tx 1 | **OPEN — PENDING (external audit) / PENDING (mainnet gate)** | Not started. This is the gate; nothing in this repo satisfies it. |

## Detailed notes

### 1. Fee/value math

`contracts/src/lib/FeeMath.sol` is a single pure function, `splitValue(value, fee) -> (feeOut, buyOut)`:
reverts `InsufficientValue` iff `value < fee`; otherwise `feeOut = fee`, `buyOut = value - fee`
in an explicit (non-`unchecked`) subtraction, with a comment recording why it's safe. `test/FeeMath.t.sol`
directly tests the `value == fee` boundary (must not revert, `buyOut == 0`) and the `value < fee` boundary
(must revert), plus a 512-run fuzz test asserting `feeOut + buyOut == value` and `feeOut == fee` for all
`(value, fee)` pairs in the full `uint256` domain (the fuzzer naturally samples both `value < fee` — where
the harness expects a revert branch implicitly excluded by the property holding only on the non-reverting
path — and boundary/edge values). No other file in `src/` contains `unchecked{}`.

### 2. Atomicity

`LaunchFactory.launchToken` is `nonReentrant`, and its five side-effecting steps (CREATE2 deploy → pool
create/init/seed/lock → provenance record → fee transfer → optional dev buy) are individually reverted by
five tests, each forcing a mock DEX component to revert at that exact step and asserting the whole
transaction reverts with no partial state. Address prediction is cross-checked two ways: (a) two dedicated
unit tests compare `predictTokenAddress`'s output against the address actually returned by `launchToken`'s
CREATE2 deploy, for both a zero and non-zero `feeWallet`; (b) `launchToken` itself contains a runtime
`assert(token == predicted)` recomputed via the independent manual-keccak256 formula, so any future
divergence between the two implementations would revert every launch, not just fail a test; (c) the fork
suite exercises the real deploy path against live Uniswap V3 and passes.

### 3. Reentrancy guards — the one real gap

`LaunchFactory.launchToken` is protected by OZ's `ReentrancyGuard` and its state writes are ordered
checks-effects-interactions at the macro level. Slither's higher-severity reentrancy detectors
(`reentrancy-eth`, `reentrancy-no-eth`) did **not** fire anywhere in the codebase — a genuinely good sign,
not an oversight; the detector suite is expected to be sensitive to this pattern and stayed quiet.

`Locker.collectFees`, however, has no `nonReentrant` modifier, and Slither's `reentrancy-events` detector
flags exactly why: `FeesCollected` is emitted after the external `positionManager.collect()` call, which
means a reentrant call from within `collect()` could interleave a nested `collectFees` call before the
outer one's event lands (event-ordering artifact, relevant to off-chain indexers). More importantly for
fund safety: analysis shows collect() has no double-spend path even under reentrancy, since Uniswap's
`NonfungiblePositionManager` decrements the position's owed-fees internally on `collect()` itself — a
reentrant nested `collectFees` call would simply collect zero on its second call. Combined with the fact
that both tokens in play (WETH and the launched fixed-supply `Token`) are plain OZ ERC20s with no transfer
hooks, there is no currently-reachable reentrancy path that moves more value than intended. **This is not
closed, though** — it depends on an assumption (no hook-bearing token is ever paired) that isn't enforced
in code. Recommended pre-audit hardening: add `ReentrancyGuard` to `Locker` and guard `collectFees`, or
track "already collected this block" locally. Left as an open item for the audit to weigh in on, not marked
done.

### 4. Invariants / fuzz

`Token.invariant.t.sol`'s `TokenCapHandler` fuzzes buy (`pairPool -> actor`), sell (`actor -> pairPool`),
wallet-to-wallet transfer, and block-advance actions across a small actor set, then asserts
`invariant_capHoldsInWindow` holds after every sequence (256 runs, 8,192 total calls, 0 unexpected reverts).
By design (documented in the handler's own scope note, matching the plan's accepted-property callout) this
invariant is scoped to the *direct* `pairPool -> user` buy path — a user who lands under-cap and then
fans out to other wallets via ordinary transfers is an accepted, spec-sanctioned property, not a gap for
this invariant to chase. The "router" delivery path is exercised for real (not just simulated) by
`test_fork_anti_snipe_cap` against the live Uniswap V3 SwapRouter on a fork — since `Token._update` is the
single choke point every ERC20 transfer/transferFrom passes through regardless of caller, the cap's
enforcement is structurally caller-path-agnostic, and the fork test is direct evidence of that for the
router case specifically. Supply conservation is structural, not just tested: `Token` exposes no burn
path anywhere (`_burn` is never called), and the entire supply is minted exactly once, in the constructor.
The launch-block exemption is scoped by the `launchBuyer` immutable and tested both ways
(`test_launchBlock_buy_to_launchBuyer_passes` / `_to_nonLaunchBuyer_reverts`). Lock immovability is a
direct, explicit test (`test_no_selector_moves_the_position_out`) plus the structural fact that `Locker`
exposes no withdraw/rescue/arbitrary-call selector at all.

### 5. Access control

Every privileged setter across both contracts is `onlyOwner` (`Ownable2Step`) or `onlyFactory`; Slither's
access-control-adjacent detectors did not flag any missing modifier. `canLaunch`'s composition (global
kill switch AND (public-open OR individually-whitelisted)) is tested for all four combinations, explicitly
including the "whitelisted but globally disabled" footgun case pons v2 is documented to have. Gaps: two
of `LaunchFactory`'s owner setters (`setLaunchEnabled`, `setPublicLaunchOpen`, `setWhitelistedLauncher`)
and both of `Locker`'s (`setFeeCollector`, `setProtocolWallet`) are exercised for their *effect* in existing
tests but have no dedicated "reverts if not owner" test (only `setLaunchConfig`/`setDexConfig` do). The
modifier is present in source and Slither-clean; this is a test-coverage gap, not a known code defect —
recommend closing before audit sign-off for completeness. `LaunchedToken` provenance is a per-launch
snapshot (copied into a memory `LaunchContext` before any external call, written once) — a later admin
edit to `LaunchConfig`/`DexConfig` cannot retroactively alter an already-launched token's recorded terms.

### 6. DoS

No public or external function anywhere in `src/` takes an array-typed parameter (grep-verified across
`LaunchFactory.sol`, `Locker.sol`, `Token.sol`), so "bound every caller-supplied array" has nothing to
bound — there is no batch/multi-item entry point in this design. Both places value moves to a
caller-influenced address were reviewed for griefing: the protocol launch fee is an ETH push
(`protocolWallet.call{value: ...}`) but the destination is an immutable, deploy-time-fixed address, never
caller-supplied per-transaction; the dev-buy delivery and `Locker`'s fee splits are plain
`SafeERC20`/`ERC20` token pushes, which (unlike ETH or ERC721/777) have no recipient-side hook a hostile
recipient could use to force a revert. No dedicated DoS test exists for this; it is a design-review
conclusion recorded here for the audit to independently confirm or challenge.

### 7. Static analysis (Slither)

Installed via `pip install slither-analyzer` (version 0.11.6) into the ambient Python 3.12 environment;
ran via `slither . --exclude-dependencies` from `contracts/` with Foundry's `forge`/`solc` on `PATH`
(crytic-compile auto-detected the Foundry project, no `slither.config.json` was needed). 31 contracts,
102 detectors, 23 findings, 0 compilation errors.

| Detector | Count | Impact | Triage |
|---|---|---|---|
| `divide-before-multiply` | 4 | Medium | **False positive.** All four are `_oneSidedTickRange`/`_floorToSpacing`/`_ceilToSpacing`'s intentional tick-to-spacing floor/ceil rounding (`(tick / spacing) * spacing`) — the div-then-mul *is* the rounding operation, not a precision-loss bug. No value/fee math is involved. |
| `incorrect-equality` | 1 | Medium | **False positive / accepted.** `block.number == launchBlock` in `Token._update` identifies "the launch block" exactly. `block.number` cannot be adversarially manipulated to a past value the way a token balance can; this detector's real target pattern (exact-balance/timestamp equality checks) doesn't apply here. |
| `unused-return` | 6 | Medium | **Accepted, standard pattern.** Two are `IERC20(...).approve(...)` on well-behaved OZ-style tokens (the launched `Token` and WETH) whose `approve` always returns `true`/never silently fails; one ignores `mint()`'s unneeded `liquidity`/`amount0`/`amount1` outputs (only `positionId` is used); two ignore `exactInputSingle`'s `amountOut` (no slippage check is used anywhere by design — see `launchToken`'s own NatSpec on `amountOutMinimum = 0`); one ignores 10 of `positions()`'s 12 return fields (only `token0`/`token1` are needed). None represent a silently-swallowed failure. Recommend `SafeERC20.forceApprove` in a future hardening pass for defense-in-depth, not required for correctness. |
| `missing-zero-check` | 4 | Low | **3 false positive / 1 accepted-by-design.** `Locker.constructor`'s `protocolWallet = owner_` is guarded transitively — `Ownable(owner_)`'s own constructor already reverts on `owner_ == address(0)` before `Locker`'s constructor body runs. `Token.constructor`'s `pairPool_` has no zero-check because `address(0)` is the valid, documented "pool not yet created" sentinel (wired later via `initPool`). `launchBuyer_ == address(0)` cannot be reached via `LaunchFactory` (always `feeWallet` or `msg.sender`, never zero) and even if it were, OZ's `ERC20` reverts transfers-to-zero before `_update` runs. `Token.initPool(pool)`'s missing zero-check is the one worth a note: if ever called with `pool == address(0)`, `pairPool` would silently stay unset (since `initPool` only rejects a non-zero *existing* value) and anti-snipe restrictions would never activate — not reachable by an external attacker (only `factory` can call it, always with `createPool`'s real return value), but a latent defensive gap if that call site ever changes. |
| `reentrancy-benign` | 1 | Low | **Accepted, by design.** State write (`_recordLaunch`) after `_createPoolAndSeed`'s external calls, inside a `nonReentrant`-guarded function with intentional macro-level CEI ordering (documented in `launchToken`'s NatSpec, exercised by the 5-step atomicity matrix). Slither's own "benign" bucket exists precisely for this non-exploitable pattern. |
| `reentrancy-events` | 1 | Low | **Open — see §3 above.** Not marked accepted; recorded as a pre-audit hardening recommendation (add `nonReentrant` to `Locker.collectFees`). |
| `assembly` | 1 | Informational | **Accepted, by design.** The one inline-assembly block is the raw `create2` opcode in `_deploy`, deliberately kept as a generic wrapper so it and `_computeCreate2Address` are independent implementations of the same CREATE2 semantics (see item 2). |
| `pragma` | 1 | Informational | **Accepted, standard practice.** Own contracts pin `0.8.24` exactly; vendored OpenZeppelin floats `^0.8.20`. Pinning first-party code while letting a vendored dependency float within a compatible range is the recommended pattern, not version drift. |
| `low-level-calls` | 1 | Informational | **Accepted, mitigated.** The one low-level call (`protocolWallet.call{value: ctx.fee}("")`) checks its return value and reverts the whole launch (`FeeTransferFailed`) on failure — the standard robust pattern for ETH transfers, deliberately chosen over `.transfer()`/`.send()` to avoid the 2300-gas stipend trap. |
| `redundant-statements` | 1 | Informational | **False positive.** `dexId;` in `predictTokenAddress` is the standard idiom for explicitly marking a parameter intentionally unused (documented in the surrounding NatSpec), not dead code. |
| `too-many-digits` | 1 | Informational | **False positive.** Slither misattributes this to the `abi.encodePacked(type(Token).creationCode, ...)` expression — a known false-positive pattern when inlined `creationCode` bytes are present; there is no numeric literal being typo-checked here. |
| `unindexed-event-address` | 1 | Informational | **Accepted, cosmetic.** `Locker.ProtocolWalletSet(address wallet)` isn't indexed — a gas/filterability nitpick with no security relevance. |

**Zero** findings from Slither's higher-severity reentrancy/access-control/arbitrary-send/suicidal/
delegatecall detector families. Every one of the 23 findings above has an explicit disposition — none are
"unexplained." One (`reentrancy-events`) is left genuinely open as a recommended hardening item, not
waved away.

**Mythril was not run.** The spec (§Definition-of-done item 7) names Slither *and* Mythril; this task's
brief (`task-12-brief.md` Step 1) scoped only Slither. Recorded here as **pending — run before audit**.

### 8. Mainnet-fork tests

Not re-executed in this session (fork tests require a live RPC endpoint and this task's instructions only
called for re-running the non-fork suite). Per Task 9's record (`progress.md`), `test/fork/Launch.fork.t.sol`
passes 2/2 against chain 4663's live Uniswap V3 deployment, with the real `positions()` tuple shape, mint
params, no-deadline router selector, and tick-negation logic all matching production with zero interface
mismatch.

### 9. Dry-run suite + testnet deployment

`script/Deploy.s.sol` wires `LaunchConfig`/`DexConfig` with the live-verified V3 addresses and pons
parameters; `test/Deploy.t.sol` exercises the wiring end-to-end against local mocks
(`test_launch_succeeds_end_to_end_after_deploy`, plus wiring-assertion tests) and passes. This constitutes
the "dry-run/simulate suite." **No testnet (46630) broadcast has occurred** — `Deploy.s.sol`'s own NatSpec
states `run()` (the `--broadcast`-able entrypoint) has never been invoked, and today's default wiring
hands `owner`/`protocolWallet` to the deploying EOA, with the documented production requirement (handing
ownership to a `TimelockController` + multisig via `Ownable2Step`'s two-step transfer) explicitly deferred
as a separate, not-yet-taken post-deploy step. **PENDING (testnet)** — this must happen, with a rehearsed
runbook, before any mainnet consideration.

### 10. Gate to mainnet

Not started, and not partially started — recorded here as the explicit, unclosed gate: independent
adversarial review, a professional third-party audit, a live bug bounty window, a staged and capped
mainnet rollout with alerting and a rehearsed incident-response plan, and hardware-backed multisig keys in
place from the very first mainnet transaction. **PENDING (external audit) / PENDING (mainnet gate).**

## Coverage

Attempted per the task instructions:

```
export PATH="$PATH:/c/Users/Ivan/.foundry/bin"
cd contracts && forge coverage --no-match-coverage 'test/fork'
```

Failed at compile time:

```
Error: Compiler run failed:
Error: Compiler error (.../libyul/backends/evm/AsmCodeGen.cpp:67): Stack too deep.
Try compiling with `--via-ir` ... Variable headStart is 1 slot(s) too deep inside the stack.
```

Retried with the suggested workaround:

```
forge coverage --no-match-coverage 'test/fork' --ir-minimum
```

Still failed, one slot over, inside `LaunchFactory._buildTokenInitcode`'s
`abi.encodePacked(type(Token).creationCode, abi.encode(<8 args>))`:

```
Error: Yul exception: Cannot swap Variable expr_49110_offset with Variable expr_mpos:
too deep in the stack by 1 slots [...]
```

Confirmed this is not test-selectable: re-running with `--no-match-contract 'LaunchFactoryTest|DeployTest'`
(excluding every test contract that references `LaunchFactory`/`Deploy`) produced the identical error,
because `forge coverage` compiles the whole 65-file project as one unit regardless of which tests are
selected — `LaunchFactory.sol` itself is always in the compilation set. `forge coverage` unconditionally
disables the optimizer and (outside `--ir-minimum`) `viaIR` to keep source mappings accurate, which is
precisely the combination that removes enough register/stack budget to overflow this one function; the
production build (default profile: optimizer on, 200 runs, no `viaIR`) compiles and the full test suite
passes without issue, so this is a coverage-tooling limitation, not a build or correctness problem.

**Per the task brief's own contingency instruction, this is recorded rather than skipped, with the
per-behavior test enumeration above (§ Detailed notes, item 4 in particular) standing in as the coverage
evidence for `LaunchFactory.sol` until the tool limitation is resolved.** Recommended before audit: either
split `_buildTokenInitcode`'s single `abi.encodePacked` call into smaller pieces purely to relieve
coverage's stack pressure (no behavior change), or re-attempt with a newer `forge`/`solc` release whose
Yul stack allocator may no longer land exactly on this boundary. `FeeMath.sol`, `Token.sol`, and
`Locker.sol` do not exhibit this failure in isolation (their functions are far smaller), but a
file-scoped coverage run was not obtainable for the reason above (whole-project single compilation unit) —
no partial numeric coverage percentages could be extracted this session.

## Final test run (this session)

```
export PATH="$PATH:/c/Users/Ivan/.foundry/bin"
cd contracts && forge test --no-match-path 'test/fork/*'
```

```
Ran 11 test suites in 1.25s (1.38s CPU time): 84 tests passed, 0 failed, 0 skipped (84 total tests)
```

Fork suite (`test/fork/Launch.fork.t.sol`, 2 tests) not re-run this session — see item 8 above.
