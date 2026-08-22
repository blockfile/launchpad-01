# Contracts (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build our own pons-v1 launchpad contracts — an atomic factory that deploys a fixed-supply ERC-20, seeds + permanently-locks a Uniswap V3 pool, records provenance, and enforces a 2-block anti-snipe cap — fully unit/fuzz/fork tested.

**Architecture:** A Foundry project in `contracts/` inside the launchpad-01 pnpm monorepo. Three contracts (`Token`, `LaunchFactory`, `Locker`) + interfaces to the live Robinhood-Chain Uniswap V3. TDD throughout; every security-critical property is a Foundry `invariant_`/fuzz test. ABIs + addresses are published to `packages/shared` for the indexer (B) and frontend (C).

**Tech Stack:** Foundry (forge/anvil 1.7.1), Solidity 0.8.24, OpenZeppelin Contracts v5, Uniswap V3 periphery interfaces. Reference: [`docs/superpowers/specs/2026-08-22-contracts-design.md`](../specs/2026-08-22-contracts-design.md) and [`docs/research/00-digest.md`](../../research/00-digest.md).

## Global Constraints

- **Foundry is at `~/.foundry/bin`, NOT on PATH.** Every shell that runs forge/anvil/cast must first: `export PATH="$PATH:/c/Users/Ivan/.foundry/bin"`.
- Solidity `0.8.24`, optimizer on (runs=200), `evm_version = "paris"` (safe for the Arbitrum-Orbit chain; re-verify PUSH0/Shanghai support against chain 4663 before mainnet).
- Chain 4663 (Robinhood Chain), testnet 46630. RPC `https://rpc.mainnet.chain.robinhood.com`.
- Pons-v1 parameters, verbatim: supply `1_000_000_000e18`, launch fee `0.0005 ether` (`500000000000000` wei), pool fee `10000` (1%), tickSpacing `200`, `maxWalletBps = 500` (5%), `maxTxBps = 550` (5.5%), restriction window `2` contract-visible blocks, split `70/30` creator/protocol, `MAX_PROTOCOL_FEE_SHARE = 50`.
- Live addresses (re-verify on-chain before embedding): WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, UniswapV3Factory `0x1F7D7550b1b028f7571E69A784071F0205FD2eFA`, NonfungiblePositionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`, SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`, Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`.
- **No `mint()` anywhere.** Supply minted once at construction.
- **Security regimen gates mainnet** (spec §Definition of done): unit + fuzz/invariant + fork + static analysis + testnet + external audit. This plan delivers everything up to and including testnet-readiness; mainnet is out of scope for the plan.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File structure

```
launchpad-01/
  pnpm-workspace.yaml, package.json, .gitignore
  packages/shared/            # skeleton now; ABIs/addresses published in Task 11
  contracts/
    foundry.toml
    lib/openzeppelin-contracts/        (forge install)
    src/
      lib/FeeMath.sol                  (Task 2)
      Token.sol                        (Tasks 3-4)
      Locker.sol                       (Task 5)
      LaunchFactory.sol                (Tasks 7-8)
      interfaces/IUniswapV3.sol        (Task 6)
    test/
      FeeMath.t.sol, Token.t.sol, Token.invariant.t.sol,
      Locker.t.sol, LaunchFactory.t.sol
      mocks/MockV3.sol                 (Task 6)
      fork/Launch.fork.t.sol           (Task 9)
    script/Deploy.s.sol                (Task 10)
```

---

### Task 1: Monorepo + Foundry scaffolding

**Files:** Create `pnpm-workspace.yaml`, `package.json`, `.gitignore`, `contracts/foundry.toml`, `contracts/test/Smoke.t.sol`; run `forge install`.

**Interfaces:** Produces: a compiling Foundry project; `forge test` runs.

- [ ] **Step 1:** Create root `pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "indexer"
  - "web"
```
Create root `package.json`:
```json
{ "name": "launchpad-01", "private": true, "packageManager": "pnpm@9" }
```
Create `.gitignore`:
```
node_modules/
contracts/out/
contracts/cache/
contracts/broadcast/**/dry-run/
.env
```
Create `packages/shared/package.json`:
```json
{ "name": "@launchpad/shared", "version": "0.0.0", "type": "module", "main": "src/index.ts" }
```
and `packages/shared/src/index.ts` with `export {};`.

- [ ] **Step 2:** Create `contracts/foundry.toml`:
```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"
optimizer = true
optimizer_runs = 200
evm_version = "paris"
remappings = ["@openzeppelin/=lib/openzeppelin-contracts/"]
fs_permissions = [{ access = "read", path = "./out" }]

[rpc_endpoints]
robinhood = "https://rpc.mainnet.chain.robinhood.com"

[fuzz]
runs = 512
[invariant]
runs = 256
depth = 32
```

- [ ] **Step 3:** Install OpenZeppelin (from `contracts/`, PATH exported):
```bash
export PATH="$PATH:/c/Users/Ivan/.foundry/bin"
cd d:/projects/launchpad-01/contracts && forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
```
(If `--no-git` is unsupported by this forge, use `forge install OpenZeppelin/openzeppelin-contracts@v5.1.0` — a submodule is fine in this repo.)

- [ ] **Step 4:** Write a smoke test `contracts/test/Smoke.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
contract SmokeTest is Test {
    function test_forge_runs() public pure { assertEq(uint256(1) + 1, 2); }
}
```
(forge-std ships with `forge install`; if missing, `forge install foundry-rs/forge-std`.)

- [ ] **Step 5:** Run `export PATH="$PATH:/c/Users/Ivan/.foundry/bin"; cd d:/projects/launchpad-01/contracts && forge test -vv` — expect the smoke test PASS.

- [ ] **Step 6:** Commit: `git add -A && git commit` — `chore: scaffold monorepo + Foundry project`.

---

### Task 2: `FeeMath.splitValue` — the value/fee split (fuzzed)

**Files:** Create `contracts/src/lib/FeeMath.sol`, `contracts/test/FeeMath.t.sol`.

**Interfaces:** Produces: `library FeeMath { function splitValue(uint256 value, uint256 fee) internal pure returns (uint256 feeOut, uint256 buyOut); }`. Reverts `InsufficientValue()` when `value < fee`.

- [ ] **Step 1: Write the failing test** `test/FeeMath.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {FeeMath} from "../src/lib/FeeMath.sol";
contract FeeMathTest is Test {
    function test_exact_fee_gives_zero_buy() public pure {
        (uint256 f, uint256 b) = FeeMath.splitValue(1 ether, 1 ether);
        assertEq(f, 1 ether); assertEq(b, 0);
    }
    function test_splits_remainder_to_buy() public pure {
        (uint256 f, uint256 b) = FeeMath.splitValue(3 ether, 1 ether);
        assertEq(f, 1 ether); assertEq(b, 2 ether);
    }
    function test_reverts_below_fee() public {
        vm.expectRevert(FeeMath.InsufficientValue.selector);
        FeeMath.splitValue(1 ether - 1, 1 ether);
    }
    function testFuzz_conserves_value(uint256 value, uint256 fee) public pure {
        vm.assume(value >= fee);
        (uint256 f, uint256 b) = FeeMath.splitValue(value, fee);
        assertEq(f, fee); assertEq(f + b, value);
    }
}
```

- [ ] **Step 2: Run, expect FAIL** (FeeMath not found): `forge test --match-contract FeeMathTest`.

- [ ] **Step 3: Implement** `src/lib/FeeMath.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
library FeeMath {
    error InsufficientValue();
    /// @return feeOut the protocol launch fee, buyOut the remainder available for the atomic dev buy.
    function splitValue(uint256 value, uint256 fee) internal pure returns (uint256 feeOut, uint256 buyOut) {
        if (value < fee) revert InsufficientValue();
        feeOut = fee;
        buyOut = value - fee; // safe: value >= fee checked above; no unchecked{}
    }
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(contracts): FeeMath.splitValue with fuzz`.

---

### Task 3: `Token` — fixed supply + on-chain metadata (no hook yet)

**Files:** Create `contracts/src/Token.sol`, `contracts/test/Token.t.sol`.

**Interfaces:** Produces: `Token` (ERC20). Constructor `Token(TokenMeta meta, uint256 supply, address mintTo)` mints the whole supply to `mintTo`. Public getters `logo()`, `description()`, `socials()`. `struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }`, `struct TokenMeta { string name; string symbol; string logo; string description; Socials socials; }`. No mint function. (Task 4 adds the anti-snipe fields to this same constructor — the factory is the only caller, so the extended signature in Task 4 supersedes this one; keep Task 4's constructor when both are done.)

- [ ] **Step 1: Write the failing test** `test/Token.t.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";
contract TokenMetaTest is Test {
    Token tok;
    function setUp() public {
        Token.Socials memory s = Token.Socials("t","tg","d","w","f");
        Token.TokenMeta memory m = Token.TokenMeta("Name","SYM","ipfs://logo","desc", s);
        tok = new Token(m, 1_000_000_000e18, address(0xBEEF));
    }
    function test_fixed_supply_minted_to_target() public view {
        assertEq(tok.totalSupply(), 1_000_000_000e18);
        assertEq(tok.balanceOf(address(0xBEEF)), 1_000_000_000e18);
        assertEq(tok.decimals(), 18);
    }
    function test_metadata_stored() public view {
        assertEq(tok.name(), "Name");
        assertEq(tok.symbol(), "SYM");
        assertEq(tok.logo(), "ipfs://logo");
        assertEq(tok.description(), "desc");
    }
}
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `src/Token.sol` — ERC20 (OZ `@openzeppelin/contracts/token/ERC20/ERC20.sol`), constructor stores metadata immutably-in-storage and mints `supply` to `mintTo`. No `mint`/`_mint` exposed post-construction. Provide `logo()/description()/socials()` getters. (Full ERC20 name/symbol via the OZ constructor.)
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(contracts): fixed-supply Token with on-chain metadata`.

---

### Task 4: `Token` — the anti-snipe transfer-cap hook (security-critical)

**Files:** Modify `contracts/src/Token.sol`; create `contracts/test/Token.invariant.t.sol`; extend `test/Token.t.sol`.

**Interfaces:** Produces: constructor extended to `Token(TokenMeta, uint256 supply, address mintTo, address pairPool, uint32 restrictionBlocks, uint16 maxWalletBps, uint16 maxTxBps, address launchBuyer)`. The `_update` override enforces the cap. `launchBlock = block.number` at construction; `restrictionsEndBlock = block.number + restrictionBlocks`. `error CapExceeded()`, `error LaunchBlockBuyBlocked()`.

- [ ] **Step 1: Write the failing tests** in `test/Token.t.sol` (add), covering the exact rules:
```solidity
// helper: deploy with pool=address(this-as-pool), then simulate pool->user "buys" by pranking as pool
// Rules to assert:
// 1. In launchBlock: a transfer FROM pool to a non-launchBuyer reverts LaunchBlockBuyBlocked; to launchBuyer succeeds.
// 2. At launchBlock+1 (roll): FROM pool, amount > 5.5% of supply reverts CapExceeded; <=5.5% but pushing holder over 5% held reverts CapExceeded; within both passes.
// 3. At restrictionsEndBlock (roll): any FROM-pool amount passes (limits lifted).
// 4. A sell (user->pool) and a wallet->wallet transfer are NEVER capped, even in-window.
```
Write these as concrete tests with `vm.roll`, `vm.prank(pool)`, and exact amounts (5% = 50_000_000e18, 5.5% = 55_000_000e18 of 1e9 supply). Also a fuzz test that a random in-window pool→user transfer to a fresh holder reverts iff amount > maxTx or resulting balance > maxWallet.

- [ ] **Step 2: Write** `test/Token.invariant.t.sol` — an invariant handler that performs random buys (pool→user), sells, and transfers across random actors while `block.number < restrictionsEndBlock`, asserting the invariant: **no non-exempt holder's balance ever exceeds maxWallet during the window, via any path** (`invariant_capHoldsInWindow`). Bound actor count.

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement** the `_update(address from, address to, uint256 value)` override in `Token.sol`:
  - Compute `maxWallet = totalSupply()*maxWalletBps/10000`, `maxTx = totalSupply()*maxTxBps/10000`.
  - Only gate when `from == pairPool` (a buy). Sells/transfers pass straight to `super._update`.
  - If `block.number == launchBlock` and `to != launchBuyer`: revert `LaunchBlockBuyBlocked`.
  - Else if `block.number < restrictionsEndBlock` and `to != launchBuyer`: require `value <= maxTx` and `balanceOf(to) + value <= maxWallet`, else revert `CapExceeded`.
  - Else: no restriction.
  - Then `super._update(from, to, value)`.
  Keep `pairPool` settable exactly once by the factory (constructor arg is cleanest — the factory predicts the pool address, or sets it in the same tx via an `onlyFactory initPool(pool)` before the first pool→user transfer; choose the constructor arg if the pool address is known pre-deploy, else `initPool`. Document which and why in a code comment.)

- [ ] **Step 5: Run, expect PASS** (unit + invariant): `forge test --match-path 'test/Token*'`.
- [ ] **Step 6: Commit** — `feat(contracts): Token anti-snipe cap hook + invariant tests`.

---

### Task 5: `Locker` — permanent LP custody + fee collection

**Files:** Create `contracts/src/Locker.sol`, `contracts/test/Locker.t.sol`.

**Interfaces:** Consumes: `INonfungiblePositionManager` (defined here or in Task 6 — if Task 6 not yet done, declare a minimal local interface with `collect(...)` and `IERC721.safeTransferFrom`). Produces: `Locker(address factory, address positionManager, address owner)`; `lockPosition(address token, uint256 positionId) external onlyFactory`; `collectFees(address token) external returns (uint256 amount0, uint256 amount1)`; `setFeeRedirect(address token, address wallet) external` (deployer-only per token); owner-managed `feeCollectors` allow-list; `Ownable2Step`; `MAX_PROTOCOL_FEE_SHARE = 50`; per-token `protocolFeeShare` snapshotted on lock. **No withdraw / no arbitrary-call function exists.**

- [ ] **Step 1: Write the failing test** `test/Locker.t.sol`:
```solidity
// Assert, using a mock position manager holding a mock NFT:
// 1. lockPosition reverts if caller != factory (onlyFactory).
// 2. After lock, the position NFT is owned by the Locker and there is NO function on Locker that transfers it out (compile-time: no such external fn; runtime: attempt via any exposed selector fails).
// 3. collectFees splits collected amounts 70/30 to (creatorWallet, protocolWallet) per the snapshotted protocolFeeShare; only feeCollectors (or anyone — decide, matching spec: owner-managed allow-list) may call.
// 4. setFeeRedirect only by the token's deployer; changes where the creator share goes.
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `src/Locker.sol` per the interface. `lockPosition` records `{deployer, creatorWallet, protocolFeeShare}` for the token and takes custody (the factory `safeTransferFrom`s the NFT to the Locker in the launch tx, or the Locker pulls it — pick the pattern the position manager supports). `collectFees` calls `positionManager.collect(...)` to this Locker, then splits. Implement `IERC721Receiver.onERC721Received` returning the selector. **Do not** implement any withdraw/rescue.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(contracts): permanent Locker with fee split`.

---

### Task 6: Uniswap V3 interfaces + mock harness

**Files:** Create `contracts/src/interfaces/IUniswapV3.sol`, `contracts/test/mocks/MockV3.sol`.

**Interfaces:** Produces: `IUniswapV3Factory` (`createPool`, `getPool`), `IUniswapV3Pool` (`initialize(uint160)`, `slot0()`), `INonfungiblePositionManager` (`mint(MintParams)`, `collect(CollectParams)`, `safeTransferFrom`), `ISwapRouter02` (`exactInputSingle` both deadline/no-deadline shapes), `IWETH` (`deposit`, `withdraw`, ERC20). Mocks: `MockV3Factory/MockPool/MockPositionManager/MockRouter/MockWETH` that emulate happy-path launch + a configurable "revert at step N" mode for atomicity tests.

- [ ] **Step 1:** Write `test/mocks/MockV3.sol` first as the consumer that pins the shapes the factory needs (a test that the mock can: create a pool, initialize it, mint a position returning a tokenId, collect fees, and route a swap). Assert the mock behaves.
- [ ] **Step 2: Run, expect FAIL** (interfaces missing).
- [ ] **Step 3: Implement** `src/interfaces/IUniswapV3.sol` (minimal, only functions used) and the mocks. **Confirm the real function selectors/shapes against the live position manager/router via `cast interface <addr> --rpc-url robinhood`** and match them (the digest warns this is a *custom* V3 deployment; the periphery shape is standard but confirm `exactInputSingle`'s struct and the two-shape router).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(contracts): live-V3 interfaces + mock harness`.

---

### Task 7: `LaunchFactory` — structs, config, provenance, CREATE2 predict (no launch)

**Files:** Create `contracts/src/LaunchFactory.sol`, `contracts/test/LaunchFactory.t.sol`.

**Interfaces:** Produces the structs from the spec (`TokenParams`, `Socials`, `LaunchConfig`, `DexConfig`, `LaunchedToken`), storage + getters `getLaunchConfig(id)/getDexConfig(id)/getLaunchedToken(addr)/launchFee()`, `predictTokenAddress(TokenParams, uint256 launchConfigId, uint256 dexId, bytes32 salt, address deployer) view returns (address)`, `canLaunch(address) view returns (bool)`, owner-only `setLaunchConfig/setDexConfig` (behind a documented timelock in deploy), `Ownable2Step`, immutable `locker`.

- [ ] **Step 1: Write the failing test** — config round-trips; `launchFee()` returns the constructor value; `canLaunch` returns true for an allowed launcher and false when disabled; `predictTokenAddress` is deterministic and **matches** the address produced by actually CREATE2-deploying a `Token` with the same salt+args (compute the initcode hash the factory uses and assert equality). Include the CREATE2-prediction cross-check explicitly.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the struct/storage/getter/predict/canLaunch surface. `predictTokenAddress` must use the **exact** initcode (creationCode + encoded constructor args) the launch path uses, so Task 8's deploy lands at the predicted address.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(contracts): LaunchFactory config + CREATE2 prediction`.

---

### Task 8: `LaunchFactory.launchToken` — the atomic launch (against mocks)

**Files:** Modify `contracts/src/LaunchFactory.sol`; extend `test/LaunchFactory.t.sol`.

**Interfaces:** Produces: `launchToken(TokenParams params, uint256 launchConfigId, uint256 dexId, bytes32 salt) external payable returns (address token)`; emits `TokenLaunched(address indexed token, address indexed deployer, address pool, uint256 launchConfigId, uint256 dexId, uint256 supply, uint256 initialBuyAmount)`. Uses `FeeMath.splitValue`. Reentrancy-guarded (OZ `ReentrancyGuard`).

- [ ] **Step 1: Write the failing tests** (wire the factory to the MockV3 from Task 6):
  - Happy path: `launchToken{value: fee + buy}` → deploys token at the predicted address; pool created + initialized; full supply seeded one-sided; LP-NFT owned by the Locker; `getLaunchedToken(token).exists == true` with correct fields; `TokenLaunched` emitted with matching args; the `fee` went to the protocol wallet; the dev buy (if buy>0) delivered tokens to `feeWallet`/launcher.
  - `value != fee + initialBuyAmount` reverts.
  - **Atomicity:** with the mock set to revert at each of {pool-create, initialize, mint, lock, dev-buy}, the whole tx reverts and **no token/pool/record persists** (assert `getLaunchedToken` empty, no code at predicted addr).
  - Fuzz the `value` split via the happy path.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `launchToken` per spec §LaunchFactory (steps 1–8): `splitValue` check → CREATE2 deploy `Token` (passing pairPool = the pool it will create; resolve the pool-address-known-before-deploy ordering — either predict the V3 pool address deterministically and pass it to the token constructor, or deploy token, create pool, then `token.initPool(pool)` before seeding; use `initPool` and gate it `onlyFactory`, matching Task 4's note) → create+init pool → mint one-sided position to Locker → `locker.lockPosition` → write record → optional dev buy via router with `amountOutMinimum = 0` (documented) → emit. Guard with `nonReentrant`, checks-effects-interactions.
- [ ] **Step 4: Run, expect PASS.** `forge test --match-contract LaunchFactory`.
- [ ] **Step 5: Commit** — `feat(contracts): atomic launchToken + atomicity/fuzz tests`.

---

### Task 9: Fork tests against the live Uniswap V3 (chain 4663)

**Files:** Create `contracts/test/fork/Launch.fork.t.sol`.

**Interfaces:** Consumes the real live addresses (Global Constraints). No new production code — this validates Tasks 4–8 against the real DEX.

- [ ] **Step 1: Write** the fork test: in `setUp`, `vm.createSelectFork("robinhood")`; deploy `Locker` + `LaunchFactory`; set `DexConfig(0)` to the **live** V3 factory/positionManager/router + WETH; set `LaunchConfig(0)` to the pons params. Test `test_fork_launch_and_trade`: launch a token with a dev buy; assert the real pool exists (`IUniswapV3Factory.getPool != 0`), liquidity is held by the Locker, provenance recorded; then perform a **real buy** via the live `SwapRouter02.exactInputSingle` from a funded address and assert the in-window cap reverts an over-cap buy and allows an under-cap one; assert a sell is never capped. Add `test_fork_blocknumber_cadence` asserting contract-visible `block.number` advances slower than wall-clock (documenting the ~16s cadence) — or at minimum assert the window math uses `block.number`.
- [ ] **Step 2: Run** `export PATH=...; cd contracts && forge test --match-path 'test/fork/*' -vvv` (needs network). Expect it to compile+run against the fork. If the public RPC is flaky (digest §2), retry; if a paid RPC is needed, note it and set `robinhood` to it via env.
- [ ] **Step 3:** Fix any real-interface mismatches surfaced (the mock shapes vs. the live custom deployment) in Task 6 interfaces + the factory, re-run.
- [ ] **Step 4: Commit** — `test(contracts): mainnet-fork launch + trade + cap`.

---

### Task 10: Deploy script + testnet rehearsal

**Files:** Create `contracts/script/Deploy.s.sol`.

**Interfaces:** Produces broadcast artifacts under `contracts/broadcast/` used by Task 11.

- [ ] **Step 1: Write** `Deploy.s.sol` (Foundry `Script`): resolve the factory↔locker circular immutability by deploying with CREATE2 predicted addresses (compute the Locker/Factory addresses, deploy Locker pointing at the predicted Factory, then deploy Factory pointing at the real Locker) — OR make `Locker.factory` a one-time `initFactory(addr) onlyOwner` setter; pick one and document. Then `setDexConfig(0)` to the live V3 addresses and `setLaunchConfig(0)` to the pons params. Include a `--broadcast`-guarded real path and a default dry-run.
- [ ] **Step 2:** Write a test `test/Deploy.t.sol` that runs the script's logic against a local fork/anvil and asserts the wired configs are correct and a launch succeeds end-to-end post-deploy.
- [ ] **Step 3: Run** the deploy test (PASS). Do NOT broadcast to any network in this task.
- [ ] **Step 4: Commit** — `feat(contracts): deploy script + wiring test`.

---

### Task 11: Publish ABIs + addresses to `packages/shared`

**Files:** Create `packages/shared/scripts/gen-abis.mjs`, `packages/shared/abis/`, `packages/shared/addresses/`; modify `packages/shared/src/index.ts`.

**Interfaces:** Produces: `packages/shared/abis/{LaunchFactory,Token,Locker,UniswapV3Pool,ERC20}.ts` (each `export const ... = [...] as const`) and `packages/shared/addresses/{4663,46630}.json`. This is the frozen A→B and A→C interface.

- [ ] **Step 1:** Write `gen-abis.mjs` — read `contracts/out/<Name>.sol/<Name>.json`, extract `.abi`, write `abis/<Name>.ts` as `export const <name>Abi = <json> as const;`. Read `contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json` (when present) for deployed addresses; otherwise write a placeholder `{ "factory": null, "locker": null, "weth": "0x0Bd7…", ... }` with the known DEX addresses filled.
- [ ] **Step 2:** Write a test (node:test or a `forge`-independent vitest) asserting the generated `launchFactoryAbi` contains the `TokenLaunched` event and the `launchToken` function; run it.
- [ ] **Step 3:** Run `forge build` then `node packages/shared/scripts/gen-abis.mjs`; commit the generated files. Update `src/index.ts` to re-export the abis + addresses + a zod-free typed addresses map.
- [ ] **Step 4: Commit** — `feat(shared): publish contract ABIs + addresses`.

---

### Task 12: Static analysis + security-gate checklist

**Files:** Create `docs/security/checklist.md`.

- [ ] **Step 1:** Attempt Slither: `pip install slither-analyzer` then `cd contracts && slither .`. If pip/slither is unavailable in the environment, record that in the checklist as "run before audit" rather than skipping silently.
- [ ] **Step 2:** Run `forge test` full suite + `forge coverage` (if available); record coverage of custom errors.
- [ ] **Step 3:** Write `docs/security/checklist.md` mapping each spec §Definition-of-done item to its evidence (test name / tool run / "pending audit"), explicitly leaving the external-audit + mainnet items **open** as the gate.
- [ ] **Step 4: Commit** — `docs(security): sub-project A security checklist`.

---

## Self-review

- **Spec coverage:** Token fixed-supply+metadata (T3) + anti-snipe hook (T4); Locker permanent+fees (T5); Factory atomic launch+config+provenance+CREATE2+event (T7,T8); FeeMath (T2); V3 integration (T6,T8); fork tests (T9); deploy (T10); shared ABIs/addresses (T11); security regimen (T4 invariants, T8 atomicity, T9 fork, T12 static+checklist). All spec §Definition-of-done items map to a task (external audit + mainnet explicitly out of scope, flagged).
- **Placeholder scan:** the two structurally-large tasks (T8 launch, T9 fork) specify the full behavior, the exact test assertions, and the ordered implementation steps; the one genuinely deferred detail — the live custom-V3 selector shapes — is a real `cast interface`/fork **verification step** (T6, T9), not a hand-wave.
- **Type consistency:** `TokenMeta`/`Socials` (T3) reused in T4's extended constructor; `LaunchedToken`/`LaunchConfig`/`DexConfig` (T7) consumed by T8; `TokenLaunched` signature (T8) is what T11 asserts and publishes; `pairPool`/`initPool` decision (T4) is honored by T8's launch ordering.
- **Two accepted properties** (buy-then-fan-out loophole kept; no locker rescue) are encoded: T5 asserts *no* withdraw path exists; T4's invariant is scoped to per-wallet cap on the direct pool→user path (the fan-out path is out of the invariant by design, matching the accepted loophole).
