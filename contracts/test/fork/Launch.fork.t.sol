// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
import {Token} from "../../src/Token.sol";
import {Locker} from "../../src/Locker.sol";
import {TickMath} from "../../src/lib/TickMath.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    ISwapRouter,
    IV3SwapRouter,
    ISwapRouter02,
    IWETH
} from "../../src/interfaces/IUniswapV3.sol";

/// @title Launch.fork.t.sol
/// @notice Task 9: validates Tasks 4-8 (Token, Locker, LaunchFactory) against
///         the REAL Uniswap V3 deployment on Robinhood Chain (id 4663) via a
///         `vm.createSelectFork`. Every mock (`test/mocks/MockV3.sol`) is
///         swapped out for the live `IUniswapV3Factory`/`IUniswapV3Pool`/
///         `ISwapRouter02`/`IWETH` at their confirmed-live addresses (see
///         `docs/research/00-digest.md` §2). Where the real interface would
///         have differed from what the production contracts assume, the
///         instruction was to fix the PRODUCTION contract, not the test —
///         see task-9-report.md for whether that happened here.
///
///         `setUp` re-runs (and re-forks) before every single test function,
///         so `test_fork_launch` and `test_fork_anti_snipe_cap` each launch
///         their own fresh Token against a pristine post-fork pool; nothing
///         is shared between them.
contract LaunchForkTest is Test {
    // -------------------------------------------------------------------
    // Confirmed-live addresses, chain 4663 (docs/research/00-digest.md §2,
    // task-9-brief.md "Global Constraints"). Re-checksummed via
    // `cast to-checksum` against the brief's literal strings before use here
    // — the V3 factory address in the brief was given with a checksum
    // mismatch on 4 characters (same underlying 20 bytes; solc rejects a
    // wrongly-cased address *literal* as a compile error, so the corrected
    // checksum is used verbatim below; the other three matched already).
    // -------------------------------------------------------------------
    address constant LIVE_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant LIVE_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant LIVE_POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant LIVE_SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;

    LaunchFactory factory;
    Locker locker;

    address owner = address(0x0121EA);
    address protocolWallet = address(0x9877E);
    address deployer = address(0xD0D0D0);

    uint256 constant LAUNCH_FEE = 0.0005 ether;
    uint256 constant LAUNCH_CONFIG_ID = 0;
    uint256 constant DEX_ID = 0;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint24 constant POOL_FEE = 10000;
    int24 constant TICK_SPACING = 200;
    int24 constant INITIAL_TICK = -204200;

    function setUp() public {
        _forkRobinhoodWithRetry();

        // --- Break the Locker<->LaunchFactory circular deploy by nonce
        //     prediction (see task-9-brief.md). This contract deploys
        //     Locker first (consumes the current nonce), then LaunchFactory
        //     immediately after (current nonce + 1) — predict that address
        //     ahead of time and pass it into Locker's immutable `factory`.
        address predictedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        locker = new Locker(predictedFactory, LIVE_POSITION_MANAGER, owner);
        factory = new LaunchFactory(owner, address(locker), LAUNCH_FEE, protocolWallet);
        assertEq(address(factory), predictedFactory, "nonce prediction drifted");

        LaunchFactory.LaunchConfig memory cfg = LaunchFactory.LaunchConfig({
            pairToken: LIVE_WETH,
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
            name: "robinhood-live-v3",
            factory: LIVE_V3_FACTORY,
            positionManager: LIVE_POSITION_MANAGER,
            swapRouter: LIVE_SWAP_ROUTER,
            poolFee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            enabled: true
        });

        vm.startPrank(owner);
        factory.setLaunchConfig(LAUNCH_CONFIG_ID, cfg);
        factory.setDexConfig(DEX_ID, dex);
        vm.stopPrank();

        vm.deal(deployer, 1_000_000 ether);
    }

    /// @dev The public RPC is documented as flaky (spurious -32601/rate
    ///      limits — docs/research/00-digest.md §2). `vm.createSelectFork`
    ///      reverts with a normal Solidity error on failure, so it can be
    ///      retried from a `try/catch` like any other external call. If it
    ///      is persistently unreachable, this reverts loudly (not a silent
    ///      skip) so a failing run is never mistaken for a pass.
    function _forkRobinhoodWithRetry() internal {
        uint256 attempts = 5;
        for (uint256 i = 0; i < attempts; i++) {
            try vm.createSelectFork("robinhood") returns (uint256) {
                return;
            } catch Error(string memory reason) {
                emit log_named_string("createSelectFork attempt failed", reason);
            } catch (bytes memory lowLevelData) {
                emit log_named_bytes("createSelectFork attempt failed (raw revert data)", lowLevelData);
            }
        }
        revert("robinhood RPC unreachable after retries (see task-9-report.md for BLOCKED status)");
    }

    function _defaultParams(address feeWallet) internal pure returns (LaunchFactory.TokenParams memory) {
        LaunchFactory.Socials memory socials =
            LaunchFactory.Socials({twitter: "t", telegram: "tg", discord: "d", website: "w", farcaster: "f"});
        return LaunchFactory.TokenParams({
            name: "Fork Test Token",
            symbol: "FORK",
            logo: "ipfs://fork-test-logo",
            description: "mainnet-fork validation token, never really launched",
            socials: socials,
            feeWallet: feeWallet
        });
    }

    // =====================================================================
    // test_fork_launch
    // =====================================================================

    /// @notice End-to-end launch against the real Uniswap V3 deployment:
    ///         deploy -> real pool created+initialized at the correct price
    ///         -> real one-sided LP-NFT locked in the Locker -> provenance
    ///         recorded -> real atomic dev buy delivers real tokens.
    function test_fork_launch() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("fork-launch-happy-path");
        uint256 devBuy = 0.01 ether;
        uint256 value = LAUNCH_FEE + devBuy;

        address predictedToken = factory.predictTokenAddress(params, LAUNCH_CONFIG_ID, DEX_ID, salt, deployer);

        // Only the indexed topics (token, deployer) are checked here — the
        // real pool's address is CREATE2-derived by the *live* Uniswap V3
        // factory using its own (unavailable-to-us) pool init-code hash, so
        // it can't be predicted client-side the way the mock-based test
        // predicts a plain-CREATE address. The pool is instead verified
        // directly below via the real factory's own `getPool`.
        vm.expectEmit(true, true, false, false, address(factory));
        emit LaunchFactory.TokenLaunched(predictedToken, deployer, address(0), 0, 0, 0, 0);

        // Recorded so the pool's *opening* price can be read straight off its
        // own `Initialize(uint160,int24)` event below — NOT off a post-call
        // `slot0()` read, which would already reflect this same call's
        // atomic dev buy having moved the price away from the opening tick
        // (caught by this test itself: an earlier draft asserted `slot0()`
        // against the pre-buy expected price and failed for exactly that
        // reason — a test bug, not a production one).
        vm.recordLogs();

        vm.prank(deployer);
        address token = factory.launchToken{value: value}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        assertEq(token, predictedToken, "CREATE2 deploy must land at the predicted address");
        assertTrue(token.code.length > 0, "token must actually have code");

        // --- The REAL UniswapV3Factory must report a real, non-zero pool ---
        address pool = IUniswapV3Factory(LIVE_V3_FACTORY).getPool(token, LIVE_WETH, POOL_FEE);
        assertTrue(pool != address(0), "real UniswapV3Factory.getPool must return a non-zero pool");
        assertTrue(pool.code.length > 0, "the real pool address must actually have code");

        // --- The pool's OPENING price (its own `Initialize` event, emitted
        //     by `IUniswapV3Pool.initialize` inside `_createPoolAndSeed`,
        //     before the dev buy ever runs) must be isToken0-correct ---
        bool isToken0 = token < LIVE_WETH;
        int24 expectedTick = isToken0 ? INITIAL_TICK : -INITIAL_TICK;
        uint160 expectedSqrtPriceX96 = TickMath.getSqrtRatioAtTick(expectedTick);
        uint160 initializedSqrtPriceX96 = _readPoolInitializeSqrtPriceX96(pool);
        assertEq(
            initializedSqrtPriceX96, expectedSqrtPriceX96, "pool must have INITIALIZED at the isToken0-correct price"
        );

        // Sanity: the dev buy that ran inside this same call must have
        // actually moved the price off that opening tick (proves the two
        // reads above are genuinely independent, not coincidentally equal).
        (uint160 currentSqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertTrue(currentSqrtPriceX96 != initializedSqrtPriceX96, "the dev buy must have moved the price");

        // --- Authoritative provenance ---
        LaunchFactory.LaunchedToken memory rec = factory.getLaunchedToken(token);
        assertTrue(rec.exists, "getLaunchedToken(token).exists must be true");
        assertEq(rec.token, token);
        assertEq(rec.deployer, deployer);
        assertEq(rec.pairedToken, LIVE_WETH);
        assertEq(rec.positionManager, LIVE_POSITION_MANAGER);
        assertEq(rec.dexId, DEX_ID);
        assertEq(rec.launchConfigId, LAUNCH_CONFIG_ID);
        assertEq(rec.supply, SUPPLY);
        assertEq(rec.isToken0, isToken0);
        assertEq(rec.poolFee, POOL_FEE);
        assertEq(rec.initialBuyAmount, devBuy);
        assertEq(rec.restrictionsEndBlock, Token(token).restrictionsEndBlock());

        // --- LP-NFT permanently owned by the Locker, via the REAL position
        //     manager's own `ownerOf` (real ERC721 surface, not a mock) ---
        assertEq(
            IERC721(LIVE_POSITION_MANAGER).ownerOf(rec.positionId),
            address(locker),
            "the real position manager must report the Locker as the LP-NFT owner"
        );

        // --- The atomic dev buy delivered REAL tokens to the launch buyer
        //     (feeWallet was zero, so launchBuyer == deployer) ---
        assertTrue(Token(token).balanceOf(deployer) > 0, "the real dev buy must have delivered tokens");
    }

    /// @dev Scans the logs recorded (via `vm.recordLogs()`) during the
    ///      enclosing `launchToken` call for `pool`'s own real
    ///      `Initialize(uint160 sqrtPriceX96, int24 tick)` event (neither
    ///      field indexed, per the canonical Uniswap V3 pool) and decodes
    ///      `sqrtPriceX96` out of it. This is the pool's *opening* price,
    ///      unaffected by any swap that happens later in the same
    ///      transaction (e.g. the atomic dev buy) — unlike a `slot0()` read
    ///      taken after the fact.
    function _readPoolInitializeSqrtPriceX96(address pool) internal view returns (uint160 sqrtPriceX96) {
        bytes32 initializeTopic0 = keccak256("Initialize(uint160,int24)");
        Vm.Log[] memory entries = vm.getRecordedLogs();
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].emitter == pool && entries[i].topics.length > 0 && entries[i].topics[0] == initializeTopic0)
            {
                (uint160 price,) = abi.decode(entries[i].data, (uint160, int24));
                return price;
            }
        }
        revert("pool's Initialize event not found in recorded logs");
    }

    // =====================================================================
    // test_fork_anti_snipe_cap
    // =====================================================================

    /// @notice Anti-snipe enforcement exercised through REAL swaps against
    ///         the live pool/router (not a mock): an over-cap buy reverts
    ///         (masked "TF" by the pool's own TransferHelper — see
    ///         docs/research/00-digest.md §1.2), an under-cap buy succeeds,
    ///         a sell of that same balance is never capped even though it
    ///         would have been an over-cap *buy*, and rolling `block.number`
    ///         past `restrictionsEndBlock` lifts the cap entirely.
    function test_fork_anti_snipe_cap() public {
        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("fork-anti-snipe-cap");

        // No dev buy here: keep the pool's one-sided liquidity at the full
        // un-touched supply so the cap-calibration math below has the
        // simplest possible starting state.
        vm.prank(deployer);
        address token = factory.launchToken{value: LAUNCH_FEE}(params, LAUNCH_CONFIG_ID, DEX_ID, salt);

        uint256 restrictionsEndBlock = factory.getLaunchedToken(token).restrictionsEndBlock;

        // Roll out of the strict launch-block ban (block.number == launchBlock,
        // where only the launchBuyer's own atomic buy may execute) and into
        // the capped window (launchBlock+1), still short of
        // restrictionsEndBlock == launchBlock+2.
        vm.roll(block.number + 1);
        assertTrue(block.number < restrictionsEndBlock, "must still be inside the capped restriction window");

        address sniper = makeAddr("fork-sniper");
        vm.deal(sniper, 10_000_000 ether);

        uint256 maxWallet = (SUPPLY * 500) / 10000; // 5% of supply, per LaunchConfig.maxWalletBps

        (uint256 underEth, uint256 overEth) = _calibrateEthAmounts(token, sniper);

        // --- Over-cap buy: reverts, masked "TF" by the real pool's
        //     TransferHelper.safeTransfer (Token's own CapExceeded revert
        //     bubbles up through the pool's low-level output transfer,
        //     whose `require(success && ..., "TF")` discards the real
        //     reason — exactly the masking documented live). ---
        vm.startPrank(sniper);
        IWETH(LIVE_WETH).deposit{value: overEth}();
        IERC20(LIVE_WETH).approve(LIVE_SWAP_ROUTER, overEth);
        vm.expectRevert(bytes("TF"));
        ISwapRouter02(LIVE_SWAP_ROUTER).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: LIVE_WETH,
                tokenOut: token,
                fee: POOL_FEE,
                recipient: sniper,
                amountIn: overEth,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
        assertEq(Token(token).balanceOf(sniper), 0, "the reverted over-cap buy must not have moved any tokens");

        // --- Under-cap buy: succeeds, delivers real tokens ---
        vm.startPrank(sniper);
        IWETH(LIVE_WETH).deposit{value: underEth}();
        IERC20(LIVE_WETH).approve(LIVE_SWAP_ROUTER, underEth);
        uint256 tokensOut = ISwapRouter02(LIVE_SWAP_ROUTER).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: LIVE_WETH,
                tokenOut: token,
                fee: POOL_FEE,
                recipient: sniper,
                amountIn: underEth,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
        assertTrue(tokensOut > 0, "the under-cap buy must deliver real tokens");
        assertTrue(tokensOut <= maxWallet, "calibrated under-cap buy must actually stay under maxWallet");
        assertEq(Token(token).balanceOf(sniper), tokensOut);

        // --- Sell is never capped, even selling this whole balance back
        //     (which, as a *buy*, would already be within cap here — the
        //     point is the direction, not the size: `_update` only gates
        //     `from == pairPool`, never `to == pairPool`). ---
        vm.startPrank(sniper);
        IERC20(token).approve(LIVE_SWAP_ROUTER, tokensOut);
        uint256 wethOut = ISwapRouter02(LIVE_SWAP_ROUTER).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: LIVE_WETH,
                fee: POOL_FEE,
                recipient: sniper,
                amountIn: tokensOut,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
        assertTrue(wethOut > 0, "the sell must succeed and deliver real WETH");
        assertEq(Token(token).balanceOf(sniper), 0, "the full sell must drain the sniper's balance");

        // --- Rolling block.number to (>=) restrictionsEndBlock lifts the
        //     cap entirely: the SAME previously-reverting `overEth` amount
        //     must now succeed. Proves the window math is keyed on
        //     `block.number`, not merely time elapsed. ---
        vm.roll(restrictionsEndBlock);
        vm.startPrank(sniper);
        IWETH(LIVE_WETH).deposit{value: overEth}();
        IERC20(LIVE_WETH).approve(LIVE_SWAP_ROUTER, overEth);
        uint256 postWindowOut = ISwapRouter02(LIVE_SWAP_ROUTER).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: LIVE_WETH,
                tokenOut: token,
                fee: POOL_FEE,
                recipient: sniper,
                amountIn: overEth,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
        assertTrue(postWindowOut > 0, "the same previously-over-cap amount must succeed once restrictions lift");
    }

    /// @dev Empirically calibrates two real ETH amounts against the ACTUAL
    ///      live pool's price/liquidity after this specific launch, rather
    ///      than hand-deriving Uniswap's concentrated-liquidity swap math
    ///      client-side. Doubles `amt` starting from a tiny probe until a
    ///      real swap of that size itself reverts (the anti-snipe cap
    ///      enforcement lives inside `Token._update` and REVERTS the whole
    ///      swap on breach — masked "TF" — so a probe's revert/success IS
    ///      the cap boundary, not a proxy measurement for it; an earlier
    ///      draft tried to measure `tokensOut` and compare it to a
    ///      pre-computed threshold, which broke the moment a probe amount
    ///      itself landed over cap, since the swap then reverts before ever
    ///      returning a `tokensOut` value at all). `overEth` is the first
    ///      amount whose probe reverted; `underEth` is the prior (half)
    ///      amount, which by the doubling-search construction did not.
    function _calibrateEthAmounts(address token, address prober) internal returns (uint256 underEth, uint256 overEth) {
        uint256 amt = 0.0001 ether;
        for (uint256 i = 0; i < 40; i++) {
            if (!_probeSwapSucceeds(token, prober, amt)) {
                overEth = amt;
                underEth = amt / 2;
                // Belt-and-suspenders: confirm the halved amount actually
                // succeeds too (true by construction for every i > 0, but
                // re-probed explicitly rather than assumed, since i == 0
                // never had a prior step to lean on).
                require(
                    _probeSwapSucceeds(token, prober, underEth),
                    "calibration invariant violated: underEth's probe also reverted"
                );
                return (underEth, overEth);
            }
            amt *= 2;
        }
        revert("could not calibrate an over-cap ETH amount within the search bound");
    }

    /// @dev Executes a REAL buy of `ethIn` against the live pool/router from
    ///      a snapshot, reporting whether the swap succeeded or reverted,
    ///      then unwinds every state change via `vm.snapshotState`/
    ///      `vm.revertToState` — a calibration probe must never leak into
    ///      the state the real (non-probing) assertions run against.
    function _probeSwapSucceeds(address token, address prober, uint256 ethIn) internal returns (bool succeeded) {
        uint256 snap = vm.snapshotState();
        vm.startPrank(prober);
        IWETH(LIVE_WETH).deposit{value: ethIn}();
        IERC20(LIVE_WETH).approve(LIVE_SWAP_ROUTER, ethIn);
        try ISwapRouter02(LIVE_SWAP_ROUTER).exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: LIVE_WETH,
                tokenOut: token,
                fee: POOL_FEE,
                recipient: prober,
                amountIn: ethIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256) {
            succeeded = true;
        } catch {
            succeeded = false;
        }
        vm.stopPrank();
        vm.revertToState(snap);
    }
}
