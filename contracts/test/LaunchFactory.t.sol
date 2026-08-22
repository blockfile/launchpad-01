// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {Token} from "../src/Token.sol";
import {Locker} from "../src/Locker.sol";
import {FeeMath} from "../src/lib/FeeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter, IV3SwapRouter, ISwapRouter02} from "../src/interfaces/IUniswapV3.sol";
import {MockV3Factory, MockPool, MockPositionManager, MockWETH, MockRevert} from "./mocks/MockV3.sol";
import {TickMath} from "../src/lib/TickMath.sol";

/// @notice Test-only harness exposing LaunchFactory's internal CREATE2
///         helpers so the test suite can independently verify
///         `predictTokenAddress` against a *real* CREATE2 deploy executed
///         from the exact same contract address (CREATE2 addresses depend
///         on the deploying contract's own address, so the deploy must
///         happen on a LaunchFactory instance, not the test contract).
///         `deployWithInitcode` is deliberately business-logic-free (just
///         `_deploy`, the raw create2 opcode wrapper) — the test builds the
///         initcode bytes itself, independently of
///         `LaunchFactory._buildTokenInitcode`, so this cross-check does not
///         just call the same mapping code twice.
contract LaunchFactoryHarness is LaunchFactory {
    constructor(address owner_, address locker_, uint256 launchFee_, address protocolWallet_)
        LaunchFactory(owner_, locker_, launchFee_, protocolWallet_)
    {}

    function deployWithInitcode(bytes32 salt, bytes memory initcode) external returns (address) {
        return _deploy(salt, initcode);
    }

    /// @dev Exposes the tick-alignment math for direct unit testing. The
    ///      end-to-end `launchToken` tests all happen to use a tick that's
    ///      already a multiple of the configured tickSpacing, so they never
    ///      exercise the rounding-adjustment branches in
    ///      `_floorToSpacing`/`_ceilToSpacing` — this harness lets a test
    ///      check those directly with deliberately misaligned ticks.
    function oneSidedTickRange(int24 initialTick, int24 tickSpacing, bool tokenIsToken0)
        external
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        return _oneSidedTickRange(initialTick, tickSpacing, tokenIsToken0);
    }
}

contract LaunchFactoryTest is Test {
    LaunchFactoryHarness factory;

    address owner = address(0x0121EA);
    address locker = address(0x10C4E5);
    address protocolWallet = address(0x9877E);
    uint256 constant LAUNCH_FEE = 0.0005 ether;

    function setUp() public {
        factory = new LaunchFactoryHarness(owner, locker, LAUNCH_FEE, protocolWallet);
    }

    function _ponsLaunchConfig() internal pure returns (LaunchFactory.LaunchConfig memory) {
        return LaunchFactory.LaunchConfig({
            pairToken: address(0xBEEF), // stand-in WETH
            graduationThreshold: 4.2 ether,
            initialTick: -204200,
            supply: 1_000_000_000e18,
            maxWalletBps: 500,
            maxTxBps: 550,
            restrictionBlocks: 2,
            reservedFee: 0,
            enabled: true,
            routerRequiresDeadline: false
        });
    }

    function _ponsDexConfig() internal pure returns (LaunchFactory.DexConfig memory) {
        return LaunchFactory.DexConfig({
            name: "robinhood-v3",
            factory: address(0xFAC7024),
            positionManager: address(0x9091),
            swapRouter: address(0x50171E12),
            poolFee: 10000,
            tickSpacing: 200,
            enabled: true
        });
    }

    // -------------------------------------------------------------------
    // Config round-trips
    // -------------------------------------------------------------------

    function test_setLaunchConfig_and_getLaunchConfig_roundtrip() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();

        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.LaunchConfig memory got = factory.getLaunchConfig(0);
        assertEq(got.pairToken, cfg.pairToken);
        assertEq(got.graduationThreshold, cfg.graduationThreshold);
        assertEq(got.initialTick, cfg.initialTick);
        assertEq(got.supply, cfg.supply);
        assertEq(got.maxWalletBps, cfg.maxWalletBps);
        assertEq(got.maxTxBps, cfg.maxTxBps);
        assertEq(got.restrictionBlocks, cfg.restrictionBlocks);
        assertEq(got.reservedFee, cfg.reservedFee);
        assertEq(got.enabled, cfg.enabled);
        assertEq(got.routerRequiresDeadline, cfg.routerRequiresDeadline);
    }

    function test_setLaunchConfig_reverts_if_not_owner() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.setLaunchConfig(0, cfg);
    }

    function test_setDexConfig_and_getDexConfig_roundtrip() public {
        LaunchFactory.DexConfig memory cfg = _ponsDexConfig();

        vm.prank(owner);
        factory.setDexConfig(0, cfg);

        LaunchFactory.DexConfig memory got = factory.getDexConfig(0);
        assertEq(got.name, cfg.name);
        assertEq(got.factory, cfg.factory);
        assertEq(got.positionManager, cfg.positionManager);
        assertEq(got.swapRouter, cfg.swapRouter);
        assertEq(got.poolFee, cfg.poolFee);
        assertEq(got.tickSpacing, cfg.tickSpacing);
        assertEq(got.enabled, cfg.enabled);
    }

    function test_setDexConfig_reverts_if_not_owner() public {
        LaunchFactory.DexConfig memory cfg = _ponsDexConfig();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.setDexConfig(0, cfg);
    }

    // -------------------------------------------------------------------
    // launchFee()
    // -------------------------------------------------------------------

    function test_launchFee_returns_constructor_value() public view {
        assertEq(factory.launchFee(), LAUNCH_FEE);
    }

    function test_launchFee_is_whatever_the_constructor_was_given() public {
        LaunchFactoryHarness f2 = new LaunchFactoryHarness(owner, locker, 123456789, protocolWallet);
        assertEq(f2.launchFee(), 123456789);
    }

    // -------------------------------------------------------------------
    // getLaunchedToken() — no launch path yet, must read as empty
    // -------------------------------------------------------------------

    function test_getLaunchedToken_empty_for_unknown_token() public view {
        LaunchFactory.LaunchedToken memory rec = factory.getLaunchedToken(address(0xABCD));
        assertFalse(rec.exists);
        assertEq(rec.token, address(0));
        assertEq(rec.supply, 0);
    }

    // -------------------------------------------------------------------
    // canLaunch
    // -------------------------------------------------------------------

    function test_canLaunch_true_by_default_public_open() public view {
        assertTrue(factory.canLaunch(address(0x1234)));
    }

    function test_canLaunch_false_when_launch_disabled() public {
        vm.prank(owner);
        factory.setLaunchEnabled(false);
        assertFalse(factory.canLaunch(address(0x1234)));
    }

    function test_canLaunch_whitelist_gating_when_public_closed() public {
        address allowed = address(0xA11CE);
        address notAllowed = address(0xB0B);

        vm.startPrank(owner);
        factory.setPublicLaunchOpen(false);
        factory.setWhitelistedLauncher(allowed, true);
        vm.stopPrank();

        assertTrue(factory.canLaunch(allowed));
        assertFalse(factory.canLaunch(notAllowed));
    }

    function test_canLaunch_whitelisted_still_false_if_globally_disabled() public {
        address allowed = address(0xA11CE);

        vm.startPrank(owner);
        factory.setPublicLaunchOpen(false);
        factory.setWhitelistedLauncher(allowed, true);
        factory.setLaunchEnabled(false);
        vm.stopPrank();

        assertFalse(factory.canLaunch(allowed));
    }

    // -------------------------------------------------------------------
    // predictTokenAddress + the CREATE2 cross-check
    // -------------------------------------------------------------------

    /// @dev Independently mirrors `LaunchFactory._buildTokenInitcode` —
    ///      deliberately re-derived here (not calling the factory's
    ///      internal function) so this test exercises the *actual* mapping
    ///      rules, not just "the same function called twice."
    function _expectedInitcode(
        LaunchFactory.TokenParams memory params,
        LaunchFactory.LaunchConfig memory cfg,
        address factoryAddr,
        address deployer
    ) internal pure returns (bytes memory) {
        Token.Socials memory tokenSocials = Token.Socials({
            twitter: params.socials.twitter,
            telegram: params.socials.telegram,
            discord: params.socials.discord,
            website: params.socials.website,
            farcaster: params.socials.farcaster
        });
        Token.TokenMeta memory meta = Token.TokenMeta({
            name: params.name,
            symbol: params.symbol,
            logo: params.logo,
            description: params.description,
            socials: tokenSocials
        });
        address launchBuyer = params.feeWallet != address(0) ? params.feeWallet : deployer;

        return abi.encodePacked(
            type(Token).creationCode,
            abi.encode(
                meta, cfg.supply, factoryAddr, address(0), cfg.restrictionBlocks, cfg.maxWalletBps, cfg.maxTxBps, launchBuyer
            )
        );
    }

    function _defaultParams(address feeWallet) internal pure returns (LaunchFactory.TokenParams memory) {
        LaunchFactory.Socials memory socials =
            LaunchFactory.Socials({twitter: "t", telegram: "tg", discord: "d", website: "w", farcaster: "f"});
        return LaunchFactory.TokenParams({
            name: "Test Token",
            symbol: "TST",
            logo: "ipfs://logo",
            description: "a test token",
            socials: socials,
            feeWallet: feeWallet
        });
    }

    function test_predictTokenAddress_matches_actual_create2_deploy_zero_feeWallet() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        address deployer = address(0xD00D);
        bytes32 salt = keccak256("salt-1");

        address predicted = factory.predictTokenAddress(params, 0, 0, salt, deployer);

        bytes memory expectedInitcode = _expectedInitcode(params, cfg, address(factory), deployer);
        address deployed = factory.deployWithInitcode(salt, expectedInitcode);

        assertEq(deployed, predicted, "predicted address must match the real CREATE2 deploy");
        assertTrue(deployed.code.length > 0, "deployed address must actually have code");

        // Sanity: the deployed Token really did receive the mapped args.
        Token deployedToken = Token(deployed);
        assertEq(deployedToken.balanceOf(address(factory)), cfg.supply);
        assertEq(deployedToken.launchBuyer(), deployer); // feeWallet was zero
        assertEq(deployedToken.pairPool(), address(0));
        assertEq(deployedToken.restrictionBlocks(), cfg.restrictionBlocks);
        assertEq(deployedToken.maxWalletBps(), cfg.maxWalletBps);
        assertEq(deployedToken.maxTxBps(), cfg.maxTxBps);
    }

    function test_predictTokenAddress_matches_actual_create2_deploy_nonzero_feeWallet() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(1, cfg);

        address feeWallet = address(0xFEE1);
        LaunchFactory.TokenParams memory params = _defaultParams(feeWallet);
        address deployer = address(0xD00D2);
        bytes32 salt = keccak256("salt-2");

        address predicted = factory.predictTokenAddress(params, 1, 0, salt, deployer);

        bytes memory expectedInitcode = _expectedInitcode(params, cfg, address(factory), deployer);
        address deployed = factory.deployWithInitcode(salt, expectedInitcode);

        assertEq(deployed, predicted);
        assertEq(Token(deployed).launchBuyer(), feeWallet); // feeWallet wins over deployer
    }

    function test_predictTokenAddress_is_deterministic() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        address deployer = address(0xD00D);
        bytes32 salt = keccak256("salt-3");

        address a = factory.predictTokenAddress(params, 0, 0, salt, deployer);
        address b = factory.predictTokenAddress(params, 0, 0, salt, deployer);
        assertEq(a, b);
    }

    function test_predictTokenAddress_changes_with_salt() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        address deployer = address(0xD00D);

        address a = factory.predictTokenAddress(params, 0, 0, keccak256("salt-A"), deployer);
        address b = factory.predictTokenAddress(params, 0, 0, keccak256("salt-B"), deployer);
        assertTrue(a != b);
    }

    function test_predictTokenAddress_changes_with_dexId_unused_but_deployer_changes_it() public {
        // dexId does not affect the address (Token's constructor args never
        // depend on it) but the deployer/launchBuyer selection does.
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("salt-same");

        address predictedDex0 = factory.predictTokenAddress(params, 0, 0, salt, address(0xAAA1));
        address predictedDex7 = factory.predictTokenAddress(params, 0, 7, salt, address(0xAAA1));
        assertEq(predictedDex0, predictedDex7, "dexId must not affect the predicted Token address");

        address predictedOtherDeployer = factory.predictTokenAddress(params, 0, 0, salt, address(0xAAA2));
        assertTrue(predictedDex0 != predictedOtherDeployer, "a different deployer must change the address");
    }

    // -------------------------------------------------------------------
    // One-sided tick range math (Task 8) — deliberately misaligned ticks,
    // since the end-to-end launch tests all happen to use an
    // already-spacing-aligned tick and would never exercise the
    // rounding-adjustment branches otherwise.
    // -------------------------------------------------------------------

    function test_oneSidedTickRange_token0_aligned_tick_unchanged() public view {
        (int24 lower, int24 upper) = factory.oneSidedTickRange(-204200, 200, true);
        assertEq(lower, -204200);
        assertEq(upper, 887200); // maxUsableTick for spacing 200
    }

    function test_oneSidedTickRange_token1_aligned_tick_unchanged() public view {
        (int24 lower, int24 upper) = factory.oneSidedTickRange(-204200, 200, false);
        assertEq(lower, -887200); // minUsableTick for spacing 200
        assertEq(upper, -204200);
    }

    function test_oneSidedTickRange_token0_ceils_misaligned_negative_tick() public view {
        // -204199 is one off from the -204200 multiple; token0 case takes
        // the ceiling (smallest multiple >= tick), which rounds *toward*
        // zero here: -204000, not -204200.
        (int24 lower,) = factory.oneSidedTickRange(-204199, 200, true);
        assertEq(lower, -204000);
    }

    function test_oneSidedTickRange_token1_floors_misaligned_negative_tick() public view {
        // Same misaligned tick, token1 case takes the floor (largest
        // multiple <= tick): -204200, the multiple just past -204199 going
        // further from zero (-204000 is > -204199, so it's not eligible).
        (, int24 upper) = factory.oneSidedTickRange(-204199, 200, false);
        assertEq(upper, -204200);
    }

    function test_oneSidedTickRange_floor_and_ceil_diverge_from_each_other() public view {
        // A tick sitting mid-way between two spacing multiples: floor and
        // ceil must land on two *different* multiples (not just "some
        // multiple"), proving the rounding actually moved the tick rather
        // than leaving it untouched or coincidentally landing on the same
        // value both ways.
        (int24 lowerToken0,) = factory.oneSidedTickRange(-204250, 200, true);
        (, int24 upperToken1) = factory.oneSidedTickRange(-204250, 200, false);
        assertEq(lowerToken0, -204200, "ceil(-204250) should round toward zero to -204200");
        assertEq(upperToken1, -204400, "floor(-204250) should round away from zero to -204400");
        assertTrue(lowerToken0 != upperToken1);
    }

    function test_oneSidedTickRange_token0_ceils_misaligned_positive_tick() public view {
        (int24 lower,) = factory.oneSidedTickRange(204199, 200, true);
        assertEq(lower, 204200);
    }

    function test_oneSidedTickRange_token1_floors_misaligned_positive_tick() public view {
        (, int24 upper) = factory.oneSidedTickRange(204199, 200, false);
        assertEq(upper, 204000);
    }
}

// =============================================================================
// launchToken — the atomic launch (Task 8)
// =============================================================================

/// @notice Task-8-only extension of Task 6's `MockV3.MockPositionManager`.
///         Previously added a non-standard `positionTokens` selector here to
///         work around `Locker.lockPosition` calling it — that was WRONG
///         (a critical review finding): the real NonfungiblePositionManager
///         has no `positionTokens`, so every real launch's `lockPosition`
///         call would have reverted. Fixed at the source instead:
///         `Locker.lockPosition` and `INonfungiblePositionManagerMinimal`
///         now use the real `positions(uint256)` 12-tuple, and
///         `MockV3.MockPositionManager` itself now implements `positions()`
///         (a real, correctly-shaped ABI method, not a workaround) — so this
///         subclass no longer needs any positionTokens-style shim at all.
///         Only the dev-buy liquidity bridge below remains.
contract TestPositionManager is MockPositionManager {
    /// @dev Task-8-only bridge: the atomic dev buy needs the swap
    ///      router to hand over a real balance of the *same* Token that was
    ///      just CREATE2-deployed inside this very `launchToken` call. Live
    ///      Uniswap's pool/position-manager/router are one interconnected
    ///      liquidity system, so the router naturally draws on the pool's
    ///      just-seeded liquidity; Task 6's mocks split those into separate,
    ///      disconnected contracts, and the Token doesn't exist yet to
    ///      pre-fund a router with before the launch transaction runs.
    ///      `sweep` is an unrestricted escape hatch (test-only, never
    ///      deployed anywhere real) letting `TestSwapRouter` draw on the
    ///      balance this position manager received during `mint`, standing
    ///      in for that shared liquidity.
    function sweep(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }
}

/// @notice Task-8-only swap router mock: implements both `exactInputSingle`
///         overloads (mirroring Task 6's `MockRouter`, including reusing its
///         `MockRevert` step-tagged error), but instead of paying out of its
///         own pre-funded balance, draws the output token from
///         `liquiditySource` via `sweep` — see `TestPositionManager`'s
///         doc-comment for why that bridge exists.
contract TestSwapRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    TestPositionManager public immutable liquiditySource;
    uint256 public fixedAmountOut;
    bool public revertOnSwap;

    constructor(TestPositionManager liquiditySource_) {
        liquiditySource = liquiditySource_;
    }

    function setFixedAmountOut(uint256 amountOut) external {
        fixedAmountOut = amountOut;
    }

    function setRevertOnSwap(bool value) external {
        revertOnSwap = value;
    }

    function exactInputSingle(IV3SwapRouter.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        amountOut = _swap(params.tokenIn, params.tokenOut, params.amountIn, params.recipient);
    }

    function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        amountOut = _swap(params.tokenIn, params.tokenOut, params.amountIn, params.recipient);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        private
        returns (uint256 amountOut)
    {
        if (revertOnSwap) revert MockRevert("swap");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = fixedAmountOut;
        if (amountOut > 0) liquiditySource.sweep(tokenOut, recipient, amountOut);
    }
}

/// @notice One hand-verifiable numerical check on the vendored `TickMath`
///         (see task-8-report.md for the full byte-for-byte diff against
///         Uniswap's canonical source used to vendor it). At `tick == 0`
///         every bit-shift branch in `getSqrtRatioAtTick` is skipped (0 has
///         no set bits), so `ratio` never leaves its initial value of
///         exactly `2**128`; the final `(ratio >> 32)` step is then exactly
///         `2**96` with a zero remainder (no round-up). This is the one
///         reference point provable by direct hand-calculation rather than
///         by trusting a copied decimal constant.
contract TickMathSanityTest is Test {
    function test_tick_zero_is_price_one() public pure {
        assertEq(TickMath.getSqrtRatioAtTick(0), uint160(2 ** 96));
    }
}

contract LaunchFactoryLaunchTest is Test {
    LaunchFactory factory;
    Locker locker;
    MockWETH weth;
    MockV3Factory v3Factory;
    TestPositionManager positionManager;
    TestSwapRouter router;

    address owner = address(0x0121EA);
    address protocolWallet = address(0x9877E);
    address deployer = address(0xD0D0D0);

    uint256 constant LAUNCH_FEE = 0.0005 ether;
    uint256 constant LAUNCH_CONFIG_ID = 0;
    uint256 constant DEX_ID = 0;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint24 constant POOL_FEE = 10000;
    int24 constant INITIAL_TICK = -204200;
    int24 constant TICK_SPACING = 200;

    function setUp() public {
        weth = new MockWETH();
        v3Factory = new MockV3Factory();
        positionManager = new TestPositionManager();
        router = new TestSwapRouter(positionManager);
        router.setFixedAmountOut(1_000e18); // harmless default so any dev buy exercises the sweep bridge

        // Locker's `factory` is immutable, fixed at Locker's own construction —
        // but LaunchFactory's constructor also wants the Locker's address. Break
        // the cycle by predicting the factory's plain-CREATE address two nonces
        // ahead of this contract's current nonce: `new Locker(...)` below
        // consumes the *current* nonce, so the factory (created right after)
        // lands at current-nonce + 1.
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        locker = new Locker(predictedFactory, address(positionManager), owner);
        factory = new LaunchFactory(owner, address(locker), LAUNCH_FEE, protocolWallet);
        assertEq(address(factory), predictedFactory, "nonce prediction drifted");

        LaunchFactory.LaunchConfig memory cfg = LaunchFactory.LaunchConfig({
            pairToken: address(weth),
            graduationThreshold: 4.2 ether,
            initialTick: INITIAL_TICK,
            supply: SUPPLY,
            maxWalletBps: 500,
            maxTxBps: 550,
            restrictionBlocks: 2,
            reservedFee: 0,
            enabled: true,
            routerRequiresDeadline: false
        });
        LaunchFactory.DexConfig memory dex = LaunchFactory.DexConfig({
            name: "test-v3",
            factory: address(v3Factory),
            positionManager: address(positionManager),
            swapRouter: address(router),
            poolFee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            enabled: true
        });

        vm.startPrank(owner);
        factory.setLaunchConfig(LAUNCH_CONFIG_ID, cfg);
        factory.setDexConfig(DEX_ID, dex);
        vm.stopPrank();
    }

    function _predictNextCreate(address deployer_) internal view returns (address) {
        return vm.computeCreateAddress(deployer_, vm.getNonce(deployer_));
    }

    function _defaultParams(address feeWallet) internal pure returns (LaunchFactory.TokenParams memory) {
        LaunchFactory.Socials memory socials =
            LaunchFactory.Socials({twitter: "t", telegram: "tg", discord: "d", website: "w", farcaster: "f"});
        return LaunchFactory.TokenParams({
            name: "Test Token",
            symbol: "TST",
            logo: "ipfs://logo",
            description: "a test token",
            socials: socials,
            feeWallet: feeWallet
        });
    }

    function _assertNothingPersisted(address predictedToken) internal view {
        assertEq(predictedToken.code.length, 0, "no code should exist at the predicted address");
        assertFalse(factory.getLaunchedToken(predictedToken).exists, "no provenance record should exist");
    }

    // -------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------

    function test_launchToken_happy_path() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("happy-path");
        uint256 devBuy = 0.01 ether;
        uint256 value = LAUNCH_FEE + devBuy;
        uint256 devBuyTokensOut = 777e18;

        address predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, deployer);
        address predictedPool = _predictNextCreate(address(v3Factory));
        router.setFixedAmountOut(devBuyTokensOut);

        vm.deal(deployer, value);
        vm.expectEmit(true, true, true, true, address(factory));
        emit LaunchFactory.TokenLaunched(predictedToken, deployer, predictedPool, LAUNCH_CONFIG_ID, DEX_ID, SUPPLY, devBuy);
        vm.prank(deployer);
        address token = factory.launchToken{value: value}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        assertEq(token, predictedToken, "CREATE2 deploy must land at the predicted address");
        assertTrue(token.code.length > 0);

        address pool = v3Factory.getPool(token, address(weth), POOL_FEE);
        assertEq(pool, predictedPool);
        assertTrue(MockPool(pool).initialized(), "pool must be initialized");
        assertTrue(MockPool(pool).sqrtPriceX96() > 0);

        LaunchFactory.LaunchedToken memory rec = factory.getLaunchedToken(token);
        assertTrue(rec.exists);
        assertEq(rec.token, token);
        assertEq(rec.deployer, deployer);
        assertEq(rec.pairedToken, address(weth));
        assertEq(rec.positionManager, address(positionManager));
        assertEq(rec.dexId, DEX_ID);
        assertEq(rec.launchConfigId, LAUNCH_CONFIG_ID);
        assertEq(rec.supply, SUPPLY);
        assertEq(rec.poolFee, POOL_FEE);
        assertEq(rec.initialBuyAmount, devBuy);
        assertEq(rec.restrictionsEndBlock, Token(token).restrictionsEndBlock());

        // Full supply seeded one-sided (our simplified mock lands the pulled
        // balance on the position manager itself, minus what the dev buy
        // then swept out to the launcher).
        assertEq(Token(token).balanceOf(address(positionManager)), SUPPLY - devBuyTokensOut);

        // LP-NFT permanently in the Locker, protocolFeeShare snapshotted.
        assertEq(positionManager.ownerOf(rec.positionId), address(locker));
        (bool locked,,, uint256 protocolFeeShare,,,) = locker.tokenLocks(token);
        assertTrue(locked);
        assertEq(protocolFeeShare, factory.PROTOCOL_FEE_SHARE());

        // Protocol launch fee collected.
        assertEq(protocolWallet.balance, LAUNCH_FEE);

        // Dev buy delivered tokens to the launcher (feeWallet was zero, so
        // launchBuyer == deployer).
        assertEq(Token(token).balanceOf(deployer), devBuyTokensOut);
    }

    function test_launchToken_happy_path_no_dev_buy() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("no-dev-buy");

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        address token = factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        assertEq(factory.getLaunchedToken(token).initialBuyAmount, 0);
        assertEq(Token(token).balanceOf(deployer), 0);
        assertEq(Token(token).balanceOf(address(positionManager)), SUPPLY);
        assertEq(protocolWallet.balance, LAUNCH_FEE);
    }

    function test_launchToken_honors_feeWallet_as_launchBuyer() public {
        address feeWallet = address(0xFEE5);
        LaunchFactory.TokenParams memory params = _defaultParams(feeWallet);
        bytes32 salt = keccak256("fee-wallet");
        uint256 devBuy = 0.02 ether;

        router.setFixedAmountOut(50e18);
        vm.deal(deployer, LAUNCH_FEE + devBuy);
        vm.prank(deployer);
        address token = factory.launchToken{value: LAUNCH_FEE + devBuy}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        assertEq(Token(token).balanceOf(feeWallet), 50e18);
        assertEq(Token(token).balanceOf(deployer), 0);

        (, address rec_deployer, address creatorWallet,,,,) = locker.tokenLocks(token);
        assertEq(rec_deployer, deployer);
        assertEq(creatorWallet, feeWallet);
    }

    // -------------------------------------------------------------------
    // Pool opening price must be correct regardless of token/WETH sort
    // order (coordinator review, critical): `config.initialTick` is
    // authored assuming the new token is token0. When it sorts as token1
    // instead, the raw tick must be negated before `initialize`, or the
    // pool opens at the *reciprocal* price (~1e9x wrong here) with nothing
    // reverting to catch it.
    // -------------------------------------------------------------------

    /// @dev CREATE2 addresses are effectively pseudorandom relative to a
    ///      fixed WETH address, so neither sort order is reachable by
    ///      picking one fixed salt — grind salts until the predicted token
    ///      address lands on the wanted side of `weth`.
    function _findSaltForOrdering(LaunchFactory.TokenParams memory params, bool wantIsToken0)
        internal
        view
        returns (bytes32 salt, address predictedToken)
    {
        for (uint256 i = 0; i < 2000; i++) {
            salt = keccak256(abi.encode("ordering-search", i));
            predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, deployer);
            bool isToken0 = predictedToken < address(weth);
            if (isToken0 == wantIsToken0) return (salt, predictedToken);
        }
        revert("no salt found for the wanted ordering within the search bound");
    }

    function test_launchToken_initializes_pool_at_raw_tick_when_token_is_token0() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        (bytes32 salt, address predictedToken) = _findSaltForOrdering(params, true);
        assertTrue(predictedToken < address(weth), "sanity: token must sort as token0 here");

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        address token = factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);
        assertEq(token, predictedToken);

        address pool = v3Factory.getPool(token, address(weth), POOL_FEE);
        assertEq(
            MockPool(pool).sqrtPriceX96(),
            TickMath.getSqrtRatioAtTick(INITIAL_TICK),
            "token0 case: pool must open at the raw (unnegated) configured tick"
        );
    }

    function test_launchToken_initializes_pool_at_negated_tick_when_token_is_token1() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        (bytes32 salt, address predictedToken) = _findSaltForOrdering(params, false);
        assertTrue(predictedToken > address(weth), "sanity: token must sort as token1 here");

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        address token = factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);
        assertEq(token, predictedToken);

        address pool = v3Factory.getPool(token, address(weth), POOL_FEE);
        assertEq(
            MockPool(pool).sqrtPriceX96(),
            TickMath.getSqrtRatioAtTick(-INITIAL_TICK),
            "token1 case: pool must open at the NEGATED configured tick, not the raw one"
        );
        // Extra guard against the exact regression: the raw (un-negated)
        // tick's price must NOT be what actually got used.
        assertTrue(MockPool(pool).sqrtPriceX96() != TickMath.getSqrtRatioAtTick(INITIAL_TICK));
    }

    /// @dev The one-sided seed range must be built around the pool's ACTUAL
    ///      price (post sort-order correction), not the raw config tick —
    ///      otherwise the range and the price it's meant to sit outside of
    ///      would disagree whenever the token sorts as token1. Checked here
    ///      by confirming the full supply still lands one-sided (zero
    ///      dev-buy sweep, so the position manager must hold the entire
    ///      supply) even in the token1 ordering.
    function test_launchToken_one_sided_seed_still_full_supply_when_token_is_token1() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        (bytes32 salt,) = _findSaltForOrdering(params, false);

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        address token = factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        assertEq(Token(token).balanceOf(address(positionManager)), SUPPLY);
    }

    // -------------------------------------------------------------------
    // Value-split validation
    // -------------------------------------------------------------------

    function test_launchToken_reverts_on_insufficient_value() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("insufficient-value");

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        vm.expectRevert(FeeMath.InsufficientValue.selector);
        factory.launchToken{value: LAUNCH_FEE - 1}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);
    }

    function testFuzz_launchToken_valueSplit(uint96 devBuyRaw) public {
        uint256 devBuy = bound(uint256(devBuyRaw), 0, 5 ether);
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256(abi.encode("fuzz", devBuy));
        uint256 value = LAUNCH_FEE + devBuy;

        vm.deal(deployer, value);
        vm.prank(deployer);
        address token = factory.launchToken{value: value}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        assertEq(factory.getLaunchedToken(token).initialBuyAmount, devBuy);
        assertEq(protocolWallet.balance, LAUNCH_FEE);
        assertEq(address(factory).balance, 0, "factory must not retain any ETH");
    }

    // -------------------------------------------------------------------
    // canLaunch / config gating
    // -------------------------------------------------------------------

    function test_launchToken_reverts_if_canLaunch_false() public {
        vm.prank(owner);
        factory.setLaunchEnabled(false);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        vm.expectRevert(LaunchFactory.LaunchNotAllowed.selector);
        factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, keccak256("gated"));
    }

    function test_launchToken_reverts_if_launchConfig_disabled() public {
        LaunchFactory.LaunchConfig memory cfg = factory.getLaunchConfig(LAUNCH_CONFIG_ID);
        cfg.enabled = false;
        vm.prank(owner);
        factory.setLaunchConfig(LAUNCH_CONFIG_ID, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        vm.expectRevert(LaunchFactory.LaunchConfigDisabled.selector);
        factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, keccak256("cfg-disabled"));
    }

    function test_launchToken_reverts_if_dexConfig_disabled() public {
        LaunchFactory.DexConfig memory dex = factory.getDexConfig(DEX_ID);
        dex.enabled = false;
        vm.prank(owner);
        factory.setDexConfig(DEX_ID, dex);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        vm.expectRevert(LaunchFactory.DexConfigDisabled.selector);
        factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, keccak256("dex-disabled"));
    }

    // -------------------------------------------------------------------
    // Atomicity: a per-step mock revert must undo *everything*
    // -------------------------------------------------------------------

    function test_launchToken_atomicity_createPool_reverts() public {
        v3Factory.setRevertOnCreatePool(true);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("atomicity-createPool");
        address predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, deployer);

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(MockRevert.selector, "createPool"));
        factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        _assertNothingPersisted(predictedToken);
    }

    function test_launchToken_atomicity_initialize_reverts() public {
        // The pool doesn't exist until `createPool` deploys it inside this
        // same atomic call, so it can't be pre-armed by address — arm it via
        // the factory-level "next pool" flag instead (see
        // `MockV3Factory.revertNextPoolOnInitialize`'s doc-comment).
        v3Factory.setRevertNextPoolOnInitialize(true);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("atomicity-initialize");
        address predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, deployer);

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(MockRevert.selector, "initialize"));
        factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        _assertNothingPersisted(predictedToken);
        assertEq(v3Factory.getPool(predictedToken, address(weth), POOL_FEE), address(0), "pool must not persist either");
    }

    function test_launchToken_atomicity_mint_reverts() public {
        positionManager.setRevertOnMint(true);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("atomicity-mint");
        address predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, deployer);

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(MockRevert.selector, "mint"));
        factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        _assertNothingPersisted(predictedToken);
    }

    function test_launchToken_atomicity_lock_reverts() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("atomicity-lock");
        address predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, deployer);

        // Pre-mark the predicted token address as already locked, so the
        // real launch's own `lockPosition` call hits `AlreadyLocked` — this
        // uses only already-committed, unmodified production Locker
        // behavior (no mock revert switch needed for this particular step).
        vm.prank(address(factory));
        locker.lockPosition(predictedToken, 999, deployer, deployer, 30);

        vm.deal(deployer, LAUNCH_FEE);
        vm.prank(deployer);
        vm.expectRevert(Locker.AlreadyLocked.selector);
        factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        _assertNothingPersisted(predictedToken);
    }

    function test_launchToken_atomicity_devBuy_reverts() public {
        router.setRevertOnSwap(true);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("atomicity-devbuy");
        uint256 devBuy = 0.01 ether;
        address predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, deployer);

        vm.deal(deployer, LAUNCH_FEE + devBuy);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(MockRevert.selector, "swap"));
        factory.launchToken{value: LAUNCH_FEE + devBuy}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        // Even though pool creation, seeding, and locking all "succeeded"
        // before the revert, the whole transaction unwinds — including the
        // Token's CREATE2 deploy.
        _assertNothingPersisted(predictedToken);
        assertEq(protocolWallet.balance, 0, "fee must not have been collected either");
    }
}
