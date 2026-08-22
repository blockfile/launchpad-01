# Fee-Safety Fix Report

Branch: `fix/contracts-fee-safety` (off `main`).
Scope: fix reachable paths that permanently strand or misdirect accrued SWAP FEES
(creator's 70% + protocol's 30% shares held in the locked LP). No changes to the
intended permanence properties (permanent LP lock, no withdraw/rescue,
`amountOutMinimum = 0` on the atomic dev buy). All guards added are input
validation, not rescue paths.

All changes verified with `forge build` + `forge test` (non-fork + fork).
**Result: 96 tests passed, 0 failed, 0 skipped** (94 non-fork + 2 fork). The fork
suite (`test/fork/Launch.fork.t.sol`, live Robinhood Chain 4663 RPC) was reachable
this run and passed, which additionally validates F6's `feeAmountTickSpacing`
call against the REAL Uniswap V3 factory.

---

## F1 (HIGH) — renounceOwnership + empty fee-collector allow-list can permanently freeze all fee collection

**Change (a):** Overrode `renounceOwnership()` in both `Locker` and `LaunchFactory`
to revert with a new custom error `RenounceDisabled()`, unconditionally (no
`onlyOwner`, so any caller gets the clear error). Mirrors the contracts'
permanence-by-construction design.
- `contracts/src/Locker.sol`: `error RenounceDisabled();` + `function renounceOwnership() public pure override { revert RenounceDisabled(); }`
- `contracts/src/LaunchFactory.sol`: same, as defense-in-depth.

**Change (b):** In `Deploy.s.sol::_deployAndWire`, after deploy, whitelisted an
operational fee collector so the allow-list is never empty from genesis:
`locker.setFeeCollector(protocolWallet_, true)` (signature confirmed in
`Locker.sol`: `setFeeCollector(address collector, bool allowed) external onlyOwner`).
Called as `deployer` (the Locker's constructor-set owner), so it succeeds under
both a real broadcast and the test harness.

**Change (c) — tests:**
- `test/Locker.t.sol::test_renounceOwnership_reverts` — Locker renounce reverts `RenounceDisabled`.
- `test/LaunchFactory.t.sol::test_renounceOwnership_reverts` — LaunchFactory renounce reverts `RenounceDisabled`.
- `test/Deploy.t.sol::test_deployed_locker_has_working_fee_collector` — asserts
  `locker.feeCollectors(protocolWallet) == true` from genesis, then launches a token
  and proves the whitelisted protocol wallet can actually call `collectFees` (no
  `NotFeeCollector` revert) while a non-whitelisted caller is rejected.

---

## F2 (HIGH) — setProtocolWallet accepts address(this), silently sinking the protocol fee share into the Locker forever

**Change:** Added `if (wallet == address(this)) revert SelfAddress();` in
`Locker.setProtocolWallet` (new shared error `SelfAddress()`), after the existing
zero-address check.
- `contracts/src/Locker.sol`

**Test:** `test/Locker.t.sol::test_setProtocolWallet_reverts_on_self_address` —
`setProtocolWallet(address(locker))` reverts `SelfAddress`.

---

## F3 (MED) — setFeeRedirect has the identical address(this) gap

**Change:** Added the same `if (wallet == address(this)) revert SelfAddress();`
guard in `Locker.setFeeRedirect`, after the existing zero-address check.
- `contracts/src/Locker.sol`

**Test:** `test/Locker.t.sol::test_setFeeRedirect_reverts_on_self_address` —
redirecting a locked token's creator share to `address(locker)` reverts `SelfAddress`.

---

## F4 (MED) — Deploy.s.sol never wires Locker.protocolWallet to the treasury

**Change:** In `Deploy.s.sol::_deployAndWire`, added
`locker.setProtocolWallet(protocolWallet_)` after deploy (ordered before the F1
fee-collector whitelist; there is no ownership handoff in this script — that is a
documented post-deploy step). Overrides the constructor default (`protocolWallet =
owner_ = deployer`) so every token's 30% protocol swap-fee share is routed to the
treasury, not the deploy EOA.
- `contracts/script/Deploy.s.sol`

**Test:** `test/Deploy.t.sol::test_locker_and_factory_are_mutually_wired` — added
`assertEq(locker.protocolWallet(), protocolWallet)`.

---

## F5 (MED) — document only, NO fee-path redesign

**Change:** Left the immutable `protocolWallet` + push `.call` mechanism unchanged
(redesign is out of scope; mainnet audit-gated). Documented the operational
constraint that `protocolWallet` MUST be an EOA or a reliably-ETH/ERC-20-receiving
address in three places:
- `contracts/src/LaunchFactory.sol` — expanded NatSpec on the `protocolWallet` immutable.
- `contracts/script/Deploy.s.sol` — expanded the `PROTOCOL_WALLET` comment in `run()`.
- `docs/security/checklist.md` — added an operational-constraint note to the DoS section (item 6).

No test (documentation-only, as specified).

---

## F6 (LOW-MED) — setDexConfig doesn't validate tickSpacing against the fee tier

**Change:**
- Added `feeAmountTickSpacing(uint24) returns (int24)` to the `IUniswapV3Factory`
  interface (`contracts/src/interfaces/IUniswapV3.sol`) — a standard V3 factory function.
- In `LaunchFactory.setDexConfig`, added:
  `if (config.tickSpacing != IUniswapV3Factory(config.factory).feeAmountTickSpacing(config.poolFee)) revert TickSpacingMismatch();`
  (new error `TickSpacingMismatch()`), queried live from the configured factory so
  it can never drift from that venue's real rule. Ordered after the existing
  `PositionManagerMismatch` check.
- Implemented `feeAmountTickSpacing` in the test `MockV3Factory`
  (`contracts/test/mocks/MockV3.sol`), seeded with the canonical Uniswap V3 mapping
  (100→1, 500→10, 3000→60, 10000→200) so it behaves exactly like the live factory.

**Fixture follow-up (not a test weakening):** `LaunchFactoryTest`'s `_ponsDexConfig()`
previously used a bare non-contract `factory: address(0xFAC7024)`. Because
`setDexConfig` now calls into `config.factory`, that fixture was pointed at a real
`MockV3Factory` deployed in `setUp` (same pattern the launch/deploy suites already
use). All existing assertions in those tests are unchanged.

**Tests (`test/LaunchFactory.t.sol`):**
- `test_setDexConfig_reverts_on_tickSpacing_mismatch` — poolFee 10000 with
  tickSpacing 199 reverts `TickSpacingMismatch`.
- `test_setDexConfig_accepts_canonical_tickSpacing` — canonical pons tier
  (poolFee 10000 / tickSpacing 200) passes, and a second canonical tier
  (poolFee 3000 / tickSpacing 60) also passes (proves the check reads the factory's
  real mapping, not a hardcoded 200).
- Additionally validated end-to-end against the LIVE factory: the fork suite's
  `setDexConfig(poolFee 10000 / tickSpacing 200)` passed against the real Uniswap V3
  factory on chain 4663.

---

## `forge test` summary

```
Ran 12 test suites: 96 tests passed, 0 failed, 0 skipped (96 total tests)
  - non-fork suites: 94 passed
  - test/fork/Launch.fork.t.sol (live chain 4663): 2 passed
    [PASS] test_fork_anti_snipe_cap()
    [PASS] test_fork_launch()
```

New/updated fee-safety tests (all PASS):
- Locker.t.sol: test_renounceOwnership_reverts, test_setProtocolWallet_reverts_on_self_address, test_setFeeRedirect_reverts_on_self_address
- LaunchFactory.t.sol: test_renounceOwnership_reverts, test_setDexConfig_reverts_on_tickSpacing_mismatch, test_setDexConfig_accepts_canonical_tickSpacing
- Deploy.t.sol: test_deployed_locker_has_working_fee_collector, test_locker_and_factory_are_mutually_wired (F4 assertion added)

No existing test was weakened. The one fixture change (`_ponsDexConfig`'s `factory`
address → a real `MockV3Factory`) is a necessary consequence of F6 making
`setDexConfig` call into `config.factory`; it preserves every existing assertion.
