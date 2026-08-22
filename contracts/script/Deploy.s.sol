// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {Locker} from "../src/Locker.sol";

/// @title Deploy
/// @notice Task 10: deploys + wires the permanent `Locker` and the
///         `LaunchFactory` for the pons launchpad, then points `dexId == 0`
///         at the live Uniswap-V3-shaped venue (Robinhood Chain, id 4663)
///         and `launchConfigId == 0` at the pons v1 launch economics.
///
///         **Circular Locker<->LaunchFactory deploy.** `Locker.factory` and
///         `LaunchFactory.locker` are both `immutable`, and each contract's
///         constructor needs the other's already-deployed address — so
///         neither can be deployed first in the naive order. Resolved with
///         the exact nonce-prediction pattern Task 9's fork test
///         (`test/fork/Launch.fork.t.sol`'s `setUp`) and the mock-backed
///         `test/LaunchFactory.t.sol` suite both already use: predict the
///         address `LaunchFactory` will land at (current nonce + 1, since
///         `Locker` is deployed first and consumes the current nonce), hand
///         that PREDICTED address into `Locker`'s constructor, then deploy
///         `LaunchFactory` for real — it lands exactly where predicted, so
///         `Locker.factory` is correct without ever needing a mutable
///         setter. `_deployAndWire` asserts this with a `require`, not an
///         `assert`: an off-by-one in a future refactor of this ordering is
///         an expected, recoverable deploy-script failure mode, not an
///         invariant break.
///
///         (The brief's alternative — a one-time `initFactory(addr)
///         onlyOwner` setter on `Locker` — was NOT taken: it would add a
///         second, ongoing "has this been called yet" state machine to a
///         contract whose entire design point is permanence/simplicity
///         (see `Locker`'s own contract-level NatSpec: no withdraw, no
///         rescue, no arbitrary call), for no benefit over a deploy-time-only
///         nonce prediction that every other test in this repo already
///         relies on.)
///
///         **Broadcast context.** `run()` is the real, `--broadcast`-able
///         entrypoint: `vm.startBroadcast()` with no explicit key defers to
///         whatever sender `forge script` was invoked with (`--private-key`/
///         `--account`/`--sender`, or the default Anvil account against a
///         local node), and `vm.readCallers()` reads that broadcaster
///         address back out — this is "the deployer" for nonce-prediction
///         purposes, since under an active broadcast every subsequent
///         `CALL`/`CREATE` this script makes is attributed to that address,
///         not to this script contract's own address. This task deliberately
///         never runs `forge script --broadcast`; `run()` exists but is not
///         invoked by `test/Deploy.t.sol` (which calls the internal
///         `_deployAndWire` directly, broadcast-free, against local mocks).
///
///         Owner/protocol-wallet default. `_deployAndWire` makes the
///         deploying address both `LaunchFactory`'s/`Locker`'s owner and the
///         `protocolWallet_` fee recipient — the simplest correct default
///         for a first deploy. Per `LaunchFactory`'s own contract-level
///         NatSpec, handing owner-ship to a `TimelockController` + multisig
///         is a real production requirement, but it is a POST-deploy
///         `transferOwnership`/`acceptOwnership` step (`Ownable2Step`), not
///         something this constructor call can do atomically — out of scope
///         for this task.
contract Deploy is Script {
    // -------------------------------------------------------------------
    // Live venue addresses, chain 4663 (Robinhood Chain). Re-checksummed
    // (`cast to-checksum`) and reused VERBATIM from Task 9's
    // `test/fork/Launch.fork.t.sol` — do not re-derive these by hand.
    // -------------------------------------------------------------------
    address internal constant LIVE_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant LIVE_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant LIVE_POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address internal constant LIVE_SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;

    // -------------------------------------------------------------------
    // Pons v1 launch economics (task-10-brief.md).
    // -------------------------------------------------------------------
    uint256 internal constant LAUNCH_FEE = 0.0005 ether;
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    int24 internal constant INITIAL_TICK = -204200;
    uint24 internal constant POOL_FEE = 10000;
    int24 internal constant TICK_SPACING = 200;
    uint16 internal constant MAX_WALLET_BPS = 500;
    uint16 internal constant MAX_TX_BPS = 550;
    uint32 internal constant RESTRICTION_BLOCKS = 2;
    uint256 internal constant GRADUATION_THRESHOLD = 4.2 ether;

    /// @notice The real, broadcast-able entrypoint (`forge script
    ///         script/Deploy.s.sol --broadcast ...`). NOT invoked by this
    ///         task — `run()` is default-dry-run under plain
    ///         `forge script script/Deploy.s.sol` (no `--broadcast` flag),
    ///         which simulates every call here without sending any
    ///         transaction.
    function run() external returns (LaunchFactory factory, Locker locker) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        // `protocolWallet` is `LaunchFactory`'s immutable fee destination —
        // there is no setter, so getting this wrong at deploy time is
        // permanent (see `LaunchFactory.protocolWallet`'s NatSpec). Falling
        // back to `deployer` is only correct for a local/dry-run invocation
        // (no `--broadcast`, or a throwaway testnet deploy with no real
        // treasury yet); a production `--broadcast` MUST set the
        // `PROTOCOL_WALLET` env var to the actual treasury/multisig address,
        // or every launch fee is permanently routed to the deploying EOA.
        address protocolWallet_ = vm.envOr("PROTOCOL_WALLET", deployer);
        (factory, locker) = _deployAndWire(
            deployer, protocolWallet_, LIVE_V3_FACTORY, LIVE_POSITION_MANAGER, LIVE_SWAP_ROUTER, LIVE_WETH
        );
        vm.stopBroadcast();
    }

    /// @notice Deploys `Locker` + `LaunchFactory` (resolving their circular
    ///         immutable references via nonce prediction) and wires
    ///         `dexId == 0`/`launchConfigId == 0`. Internal (not part of any
    ///         contract's external ABI) purely so `test/Deploy.t.sol` can
    ///         exercise this exact wiring logic against local mocks without
    ///         ever going through `vm.startBroadcast`.
    ///
    ///         `deployer` MUST equal the address that will actually execute
    ///         the two `new` calls below (i.e. `address(this)` of whichever
    ///         contract's code is running this function — this contract
    ///         under a real broadcast, or a test harness contract when
    ///         called directly) — `vm.computeCreateAddress` only predicts
    ///         correctly when the nonce it reads belongs to the address that
    ///         is actually about to deploy.
    /// @param deployer The deploying address (see above).
    /// @param protocolWallet_ Destination for the protocol launch fee.
    /// @param dexFactory_ Uniswap-v3-shaped pool factory for `dexId == 0`.
    /// @param positionManager_ NonfungiblePositionManager for `dexId == 0`
    ///        (also `Locker`'s immutable position manager).
    /// @param swapRouter_ SwapRouter02-shaped router for `dexId == 0`.
    /// @param pairToken_ The quote asset (WETH) for `launchConfigId == 0`.
    function _deployAndWire(
        address deployer,
        address protocolWallet_,
        address dexFactory_,
        address positionManager_,
        address swapRouter_,
        address pairToken_
    ) internal returns (LaunchFactory factory, Locker locker) {
        // --- Break the circular Locker<->LaunchFactory deploy (see
        //     contract-level NatSpec): Locker is deployed first here, so it
        //     consumes `deployer`'s CURRENT nonce; LaunchFactory, deployed
        //     immediately after, lands at current-nonce + 1 — predict that
        //     address ahead of time and hand it to Locker's constructor. ---
        address predictedFactory = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        locker = new Locker(predictedFactory, positionManager_, deployer);
        factory = new LaunchFactory(deployer, address(locker), LAUNCH_FEE, protocolWallet_);
        require(address(factory) == predictedFactory, "Deploy: nonce prediction drifted");

        factory.setDexConfig(
            0,
            LaunchFactory.DexConfig({
                name: "robinhood-live-v3",
                factory: dexFactory_,
                positionManager: positionManager_,
                swapRouter: swapRouter_,
                poolFee: POOL_FEE,
                tickSpacing: TICK_SPACING,
                enabled: true
            })
        );

        factory.setLaunchConfig(
            0,
            LaunchFactory.LaunchConfig({
                pairToken: pairToken_,
                graduationThreshold: GRADUATION_THRESHOLD,
                initialTick: INITIAL_TICK,
                supply: SUPPLY,
                maxWalletBps: MAX_WALLET_BPS,
                maxTxBps: MAX_TX_BPS,
                restrictionBlocks: RESTRICTION_BLOCKS,
                reservedFee: 0,
                enabled: true,
                routerRequiresDeadline: false
            })
        );
    }
}
