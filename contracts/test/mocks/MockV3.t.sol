// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    INonfungiblePositionManager,
    ISwapRouter,
    IV3SwapRouter
} from "../../src/interfaces/IUniswapV3.sol";
import {MockV3Factory, MockPool, MockPositionManager, MockRouter, MockWETH} from "./MockV3.sol";

/// Minimal mint-on-demand ERC20 standing in for the pool's token0/token1 legs,
/// mirroring the pattern already used by Locker.t.sol.
contract MockToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title MockV3Test
/// @notice TDD anchor for Task 6: this is the "consumer" test that pins the
///         exact shapes the (future) factory needs from Uniswap V3 —
///         createPool -> initialize -> mint -> collect -> swap — against the
///         mock harness in MockV3.sol, plus the per-step "revert" switches
///         Task 8's atomicity tests will flip.
contract MockV3Test is Test {
    MockV3Factory factory;
    MockPositionManager pm;
    MockRouter router;
    MockWETH weth;
    MockToken tokenA;
    MockToken tokenB;

    address user = address(0xBEEF);
    uint24 constant FEE = 3000;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336; // sqrt(1) << 96

    address token0;
    address token1;

    function setUp() public {
        factory = new MockV3Factory();
        pm = new MockPositionManager();
        router = new MockRouter();
        weth = new MockWETH();
        tokenA = new MockToken("TokenA", "TKA");
        tokenB = new MockToken("TokenB", "TKB");

        (token0, token1) = address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));

        tokenA.mint(user, 1_000e18);
        tokenB.mint(user, 1_000e18);

        // Pre-fund the position manager and router so collect()/swap() have
        // real balances to pay out of, mirroring Locker.t.sol's approach.
        tokenA.mint(address(pm), 1_000e18);
        tokenB.mint(address(pm), 1_000e18);
        tokenA.mint(address(router), 1_000e18);
        tokenB.mint(address(router), 1_000e18);
    }

    function _mintParams(uint256 amount0Desired, uint256 amount1Desired)
        internal
        view
        returns (INonfungiblePositionManager.MintParams memory)
    {
        return INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: FEE,
            tickLower: -60,
            tickUpper: 60,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: 0,
            amount1Min: 0,
            recipient: user,
            deadline: block.timestamp
        });
    }

    // --- happy path: create -> initialize -> mint -> collect -> swap ------

    function test_happyPath_createPool_initialize_mint_collect_swap() public {
        vm.startPrank(user);

        address pool = factory.createPool(address(tokenA), address(tokenB), FEE);
        assertTrue(pool != address(0));
        assertEq(factory.getPool(address(tokenA), address(tokenB), FEE), pool);
        assertEq(factory.getPool(address(tokenB), address(tokenA), FEE), pool, "lookup must be order-independent");

        IUniswapV3Pool(pool).initialize(SQRT_PRICE_1_1);
        (uint160 sqrtPriceX96,,,,,, bool unlocked) = IUniswapV3Pool(pool).slot0();
        assertEq(sqrtPriceX96, SQRT_PRICE_1_1);
        assertTrue(unlocked);
        assertEq(IUniswapV3Pool(pool).token0(), token0);
        assertEq(IUniswapV3Pool(pool).token1(), token1);

        tokenA.approve(address(pm), 100e18);
        tokenB.approve(address(pm), 100e18);

        (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) = pm.mint(_mintParams(100e18, 100e18));

        assertEq(tokenId, 1);
        assertGt(liquidity, 0);
        assertEq(amount0, 100e18);
        assertEq(amount1, 100e18);
        assertEq(pm.ownerOf(tokenId), user);

        pm.setCollectAmounts(1e18, 2e18);
        (uint256 c0, uint256 c1) = pm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: user,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        assertEq(c0, 1e18);
        assertEq(c1, 2e18);

        router.setFixedAmountOut(50e18);
        tokenA.approve(address(router), 10e18);
        uint256 balBefore = tokenB.balanceOf(user);
        uint256 amountOut = router.exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(tokenA),
                tokenOut: address(tokenB),
                fee: FEE,
                recipient: user,
                amountIn: 10e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        assertEq(amountOut, 50e18);
        assertEq(tokenB.balanceOf(user) - balBefore, 50e18);

        vm.stopPrank();
    }

    // The with-deadline (ISwapRouter, V1) shape must also route through the
    // same mock router — Task 6 requires both exactInputSingle overloads.
    function test_swapRouter_deadline_shape_also_works() public {
        vm.startPrank(user);
        router.setFixedAmountOut(25e18);
        tokenA.approve(address(router), 5e18);

        uint256 amountOut = router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(tokenA),
                tokenOut: address(tokenB),
                fee: FEE,
                recipient: user,
                deadline: block.timestamp,
                amountIn: 5e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        assertEq(amountOut, 25e18);
        vm.stopPrank();
    }

    function test_weth_deposit_and_withdraw() public {
        vm.deal(user, 1 ether);
        vm.startPrank(user);
        weth.deposit{value: 1 ether}();
        assertEq(weth.balanceOf(user), 1 ether);

        weth.withdraw(0.4 ether);
        assertEq(weth.balanceOf(user), 0.6 ether);
        assertEq(user.balance, 0.4 ether);
        vm.stopPrank();
    }

    // --- revert-at-step mode: each mock exposes its own kill switch --------

    function test_revert_flag_blocks_createPool() public {
        factory.setRevertOnCreatePool(true);
        vm.expectRevert();
        factory.createPool(address(tokenA), address(tokenB), FEE);
    }

    function test_revert_flag_blocks_initialize() public {
        address pool = factory.createPool(address(tokenA), address(tokenB), FEE);
        MockPool(pool).setRevertOnInitialize(true);
        vm.expectRevert();
        IUniswapV3Pool(pool).initialize(SQRT_PRICE_1_1);
    }

    function test_revert_flag_blocks_mint() public {
        pm.setRevertOnMint(true);
        vm.prank(user);
        vm.expectRevert();
        pm.mint(_mintParams(1e18, 1e18));
    }

    function test_revert_flag_blocks_collect() public {
        vm.prank(user);
        tokenA.approve(address(pm), 1e18);
        vm.prank(user);
        tokenB.approve(address(pm), 1e18);
        vm.prank(user);
        (uint256 tokenId,,,) = pm.mint(_mintParams(1e18, 1e18));

        pm.setRevertOnCollect(true);
        vm.expectRevert();
        pm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: user,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
    }

    function test_revert_flag_blocks_swap() public {
        router.setRevertOnSwap(true);
        vm.prank(user);
        tokenA.approve(address(router), 1e18);
        vm.prank(user);
        vm.expectRevert();
        router.exactInputSingle(
            IV3SwapRouter.ExactInputSingleParams({
                tokenIn: address(tokenA),
                tokenOut: address(tokenB),
                fee: FEE,
                recipient: user,
                amountIn: 1e18,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    // Flipping a flag back off must un-block the step (proves it's a real
    // switch, not a one-way trap).
    function test_revert_flag_can_be_toggled_back_off() public {
        factory.setRevertOnCreatePool(true);
        vm.expectRevert();
        factory.createPool(address(tokenA), address(tokenB), FEE);

        factory.setRevertOnCreatePool(false);
        address pool = factory.createPool(address(tokenA), address(tokenB), FEE);
        assertTrue(pool != address(0));
    }
}
