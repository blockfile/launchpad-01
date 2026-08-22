// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {Locker} from "../src/Locker.sol";
import {MockV3Factory, MockPool, MockPositionManager, MockRouter, MockWETH} from "./mocks/MockV3.sol";

/// @notice Test-only harness exposing `Deploy._deployAndWire` so this suite
///         can run the deploy script's exact wiring logic (the circular
///         nonce-prediction deploy + `setDexConfig`/`setLaunchConfig`)
///         without ever going through `vm.startBroadcast` — mirrors the
///         `LaunchFactoryHarness` pattern already used in
///         `test/LaunchFactory.t.sol`. `deployAndWire` passes `address(this)`
///         (the harness's own address) as `_deployAndWire`'s `deployer`,
///         since this harness is the contract that actually executes the
///         `new Locker(...)`/`new LaunchFactory(...)` calls inside it — see
///         `_deployAndWire`'s NatSpec on why that address must match.
contract DeployHarness is Deploy {
    function deployAndWire(
        address protocolWallet_,
        address dexFactory_,
        address positionManager_,
        address swapRouter_,
        address pairToken_
    ) external returns (LaunchFactory factory, Locker locker) {
        return _deployAndWire(address(this), protocolWallet_, dexFactory_, positionManager_, swapRouter_, pairToken_);
    }
}

/// @title Deploy.t.sol
/// @notice Task 10: runs `Deploy`'s wiring logic (`DeployHarness.deployAndWire`
///         -> `Deploy._deployAndWire`) against LOCAL Task-6 `MockV3` venue
///         mocks (no RPC, no fork — always runs as part of the plain
///         no-fork suite), asserts the resulting `LaunchFactory`/`Locker`
///         wiring is exactly what the script set, and then runs one real
///         mock-backed `launchToken` end-to-end to prove the wiring actually
///         supports a working launch (deployed pool, locked LP-NFT,
///         authoritative provenance record, `TokenLaunched` event) — not
///         just that the getters echo back what was set.
contract DeployTest is Test {
    DeployHarness harness;
    LaunchFactory factory;
    Locker locker;

    MockWETH weth;
    MockV3Factory v3Factory;
    MockPositionManager positionManager;
    MockRouter router;

    address protocolWallet = address(0x9877E);
    address launcher = address(0xD0D0D0);

    uint256 constant LAUNCH_FEE = 0.0005 ether;
    uint256 constant LAUNCH_CONFIG_ID = 0;
    uint256 constant DEX_ID = 0;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint24 constant POOL_FEE = 10000;
    int24 constant TICK_SPACING = 200;
    int24 constant INITIAL_TICK = -204200;
    uint16 constant MAX_WALLET_BPS = 500;
    uint16 constant MAX_TX_BPS = 550;
    uint32 constant RESTRICTION_BLOCKS = 2;
    uint256 constant GRADUATION_THRESHOLD = 4.2 ether;
    uint256 constant PROTOCOL_FEE_SHARE = 30;

    function setUp() public {
        weth = new MockWETH();
        v3Factory = new MockV3Factory();
        positionManager = new MockPositionManager();
        router = new MockRouter();

        harness = new DeployHarness();
        (factory, locker) = harness.deployAndWire(
            protocolWallet, address(v3Factory), address(positionManager), address(router), address(weth)
        );

        vm.deal(launcher, 10 ether);
    }

    function _defaultParams() internal pure returns (LaunchFactory.TokenParams memory) {
        LaunchFactory.Socials memory socials =
            LaunchFactory.Socials({twitter: "t", telegram: "tg", discord: "d", website: "w", farcaster: "f"});
        return LaunchFactory.TokenParams({
            name: "Deploy Test Token",
            symbol: "DEPT",
            logo: "ipfs://deploy-test-logo",
            description: "deploy-script wiring test token, never really launched",
            socials: socials,
            feeWallet: address(0)
        });
    }

    // =====================================================================
    // Wiring assertions
    // =====================================================================

    function test_locker_and_factory_are_mutually_wired() public view {
        assertEq(factory.locker(), address(locker), "factory.locker() must be the deployed Locker");
        assertEq(locker.factory(), address(factory), "locker.factory() must be the deployed LaunchFactory");
        assertEq(locker.positionManager(), address(positionManager));
        assertEq(locker.owner(), address(harness));
        assertEq(factory.owner(), address(harness));
        // F4: the deploy script must wire the Locker's protocol fee destination
        // to the treasury, not leave it as the constructor default (the deploy
        // EOA). Otherwise every token's 30% protocol swap-fee share silently
        // goes to the deployer instead of the treasury.
        assertEq(locker.protocolWallet(), protocolWallet, "locker.protocolWallet must be wired to the treasury");
    }

    function test_launch_fee_is_the_pons_value() public view {
        assertEq(factory.launchFee(), LAUNCH_FEE, "launchFee must be 0.0005 ether");
    }

    function test_dex_config_zero_is_wired_to_the_venue_mocks() public view {
        LaunchFactory.DexConfig memory dex = factory.getDexConfig(DEX_ID);
        assertEq(dex.name, "robinhood-live-v3");
        assertEq(dex.factory, address(v3Factory));
        assertEq(dex.positionManager, address(positionManager));
        assertEq(dex.swapRouter, address(router));
        assertEq(dex.poolFee, POOL_FEE);
        assertEq(dex.tickSpacing, TICK_SPACING);
        assertTrue(dex.enabled);
    }

    function test_launch_config_zero_is_wired_to_pons_params() public view {
        LaunchFactory.LaunchConfig memory cfg = factory.getLaunchConfig(LAUNCH_CONFIG_ID);
        assertEq(cfg.pairToken, address(weth));
        assertEq(cfg.graduationThreshold, GRADUATION_THRESHOLD);
        assertEq(cfg.initialTick, INITIAL_TICK);
        assertEq(cfg.supply, SUPPLY);
        assertEq(cfg.maxWalletBps, MAX_WALLET_BPS);
        assertEq(cfg.maxTxBps, MAX_TX_BPS);
        assertEq(cfg.restrictionBlocks, RESTRICTION_BLOCKS);
        assertEq(cfg.reservedFee, 0);
        assertTrue(cfg.enabled);
        assertFalse(cfg.routerRequiresDeadline);
    }

    // =====================================================================
    // End-to-end: the wiring this script produced actually supports a
    // working launch (no dev buy needed to prove this — `launchToken`'s
    // dev-buy step is entirely skipped when `msg.value == launchFee`
    // exactly, per `FeeMath.splitValue`, so the plain Task-6 `MockRouter`
    // wired above never needs to actually execute a swap here).
    // =====================================================================

    function test_launch_succeeds_end_to_end_after_deploy() public {
        LaunchFactory.TokenParams memory params = _defaultParams();
        bytes32 salt = keccak256("deploy-script-launch");

        address predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, launcher);

        vm.expectEmit(true, true, false, false, address(factory));
        emit LaunchFactory.TokenLaunched(predictedToken, launcher, address(0), 0, 0, 0, 0);

        vm.prank(launcher);
        address token = factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        assertEq(token, predictedToken, "CREATE2 deploy must land at the predicted address");
        assertTrue(token.code.length > 0, "token must actually have code");

        // --- Pool created + initialized via the wired venue mocks ---
        address pool = v3Factory.getPool(token, address(weth), POOL_FEE);
        assertTrue(pool != address(0), "pool must have been created via the wired DexConfig factory");
        assertTrue(MockPool(pool).initialized(), "pool must be initialized");

        // --- Authoritative provenance record ---
        LaunchFactory.LaunchedToken memory rec = factory.getLaunchedToken(token);
        assertTrue(rec.exists);
        assertEq(rec.token, token);
        assertEq(rec.deployer, launcher);
        assertEq(rec.pairedToken, address(weth));
        assertEq(rec.positionManager, address(positionManager));
        assertEq(rec.dexId, DEX_ID);
        assertEq(rec.launchConfigId, LAUNCH_CONFIG_ID);
        assertEq(rec.supply, SUPPLY);
        assertEq(rec.poolFee, POOL_FEE);
        assertEq(rec.initialBuyAmount, 0, "no dev buy: msg.value == launchFee exactly");

        // --- LP-NFT permanently locked in the wired Locker ---
        (bool locked, address lockDeployer, address creatorWallet, uint256 protocolFeeShare, uint256 positionId,,) =
            locker.tokenLocks(token);
        assertTrue(locked, "position must be locked");
        assertEq(lockDeployer, launcher);
        assertEq(creatorWallet, launcher, "feeWallet was zero: creatorWallet falls back to the launcher");
        assertEq(protocolFeeShare, PROTOCOL_FEE_SHARE);
        assertEq(
            IERC721(address(positionManager)).ownerOf(positionId),
            address(locker),
            "the LP-NFT must be owned by the Locker"
        );

        // --- Protocol launch fee collected to the wired protocolWallet ---
        assertEq(protocolWallet.balance, LAUNCH_FEE);
    }

    // =====================================================================
    // F1(c): the script's wiring leaves a working fee collector from genesis
    // =====================================================================

    /// @dev The deploy script whitelists an operational fee collector (the
    ///      protocol wallet) so the `feeCollectors` allow-list is never empty
    ///      from genesis — otherwise, with `renounceOwnership` disabled but
    ///      the owner key still loseable, every token's swap fees could become
    ///      permanently uncollectible. Prove it end-to-end: the whitelisted
    ///      wallet can actually trigger `collectFees` on a freshly-launched
    ///      token, while a non-whitelisted caller is rejected.
    function test_deployed_locker_has_working_fee_collector() public {
        assertTrue(locker.feeCollectors(protocolWallet), "protocol wallet must be a fee collector from genesis");

        LaunchFactory.TokenParams memory params = _defaultParams();
        bytes32 salt = keccak256("fee-collector-launch");
        vm.prank(launcher);
        address token = factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        // A non-whitelisted caller cannot collect.
        vm.prank(address(0xBADC0FFEE));
        vm.expectRevert(Locker.NotFeeCollector.selector);
        locker.collectFees(token);

        // The whitelisted protocol wallet can. Default mock collect amounts
        // are zero, so this proves the allow-list gate lets it through (no
        // `NotFeeCollector` revert), which is exactly the F1 property.
        vm.prank(protocolWallet);
        locker.collectFees(token);
    }
}
