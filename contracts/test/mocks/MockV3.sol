// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    INonfungiblePositionManager,
    ISwapRouter,
    IV3SwapRouter,
    ISwapRouter02,
    IWETH
} from "../../src/interfaces/IUniswapV3.sol";

// MockV3: test-only harness emulating the happy-path Uniswap V3 launch flow
// (createPool -> initialize -> mint -> collect -> swap) against the real ABI
// shapes pinned in `IUniswapV3.sol`, plus a per-step "revert on demand"
// switch on each mock so Task 8's atomicity tests can force any single step
// of a factory launch to fail and assert nothing was left half-done.
//
// Each mock's revert flag is independent and toggled directly on that mock
// (there is no shared "step number" registry) — a test calls
// `mock.setRevertOnX(true)` for exactly the step it wants to fail, runs the
// flow, asserts revert + no side effects, then can flip it back off and
// prove the flow succeeds normally.

/// @notice Shared revert reason every mock's kill switch throws, tagged
///         with which step failed.
error MockRevert(string step);

/// @notice Stands in for the Uniswap V3 factory. Pool addresses are keyed by
///         sorted (token0, token1, fee), mirroring the real factory so
///         `getPool` is order-independent regardless of which order the
///         caller passed tokenA/tokenB in.
contract MockV3Factory is IUniswapV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public pools;
    bool public revertOnCreatePool;

    /// @dev Canonical Uniswap V3 fee-tier -> tick-spacing mapping, seeded to
    ///      match the real factory so `LaunchFactory.setDexConfig`'s
    ///      tickSpacing validation (see `TickSpacingMismatch`) behaves against
    ///      this mock exactly as it would against the live factory. Unknown
    ///      fee tiers read back 0, mirroring the real factory. The public
    ///      mapping's auto-getter satisfies
    ///      `IUniswapV3Factory.feeAmountTickSpacing`.
    mapping(uint24 => int24) public feeAmountTickSpacing;

    constructor() {
        feeAmountTickSpacing[100] = 1;
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10000] = 200;
    }

    /// @dev Task-8 addition: a pool doesn't exist until `createPool` deploys
    ///      it inside the same atomic `launchToken` call that then
    ///      immediately calls `initialize` on it — so there's no address a
    ///      test could call `MockPool.setRevertOnInitialize` on *before*
    ///      that transaction runs. This factory-level flag is consulted at
    ///      the moment a pool is created and passed straight into its
    ///      constructor, letting a test arm "the next pool this factory
    ///      creates reverts on its first `initialize`" ahead of time.
    ///      Defaults false; every existing test/behavior is unchanged.
    bool public revertNextPoolOnInitialize;

    function setRevertOnCreatePool(bool value) external {
        revertOnCreatePool = value;
    }

    function setRevertNextPoolOnInitialize(bool value) external {
        revertNextPoolOnInitialize = value;
    }

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        if (revertOnCreatePool) revert MockRevert("createPool");

        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(pools[token0][token1][fee] == address(0), "MockV3Factory: pool exists");

        pool = address(new MockPool(token0, token1, fee, revertNextPoolOnInitialize));
        pools[token0][token1][fee] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return pools[token0][token1][fee];
    }
}

/// @notice Stands in for a Uniswap V3 pool. Only tracks what the factory's
///         launch flow needs: initialize() sets the starting price, slot0()
///         reads it back, token0()/token1() expose the sorted pair.
contract MockPool is IUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint160 public sqrtPriceX96;
    bool public initialized;
    bool public revertOnInitialize;

    constructor(address token0_, address token1_, uint24 fee_, bool revertOnInitialize_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        revertOnInitialize = revertOnInitialize_;
    }

    function setRevertOnInitialize(bool value) external {
        revertOnInitialize = value;
    }

    function initialize(uint160 sqrtPriceX96_) external {
        if (revertOnInitialize) revert MockRevert("initialize");
        sqrtPriceX96 = sqrtPriceX96_;
        initialized = true;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96_,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (sqrtPriceX96, 0, 0, 1, 1, 0, initialized);
    }
}

/// @notice Stands in for the NonfungiblePositionManager: it IS the ERC721
///         holding the LP-NFT (real contract behavior) and implements
///         `mint`/`collect`. `mint` actually pulls `amount0Desired`/
///         `amount1Desired` from the caller (requires prior approve, like
///         the real contract) so atomicity tests can assert on real token
///         balances; `collect` pays out fixed, test-configured amounts
///         (pre-funded into this contract), mirroring the pattern already
///         used by Locker.t.sol's mock.
contract MockPositionManager is ERC721, INonfungiblePositionManager {
    using SafeERC20 for IERC20;

    uint256 public nextTokenId = 1;
    uint256 public fixedLiquidity = 1_000_000;
    uint256 public fixedCollectAmount0;
    uint256 public fixedCollectAmount1;
    bool public revertOnMint;
    bool public revertOnCollect;

    mapping(uint256 => address) public positionToken0;
    mapping(uint256 => address) public positionToken1;

    constructor() ERC721("MockPosition", "MPOS") {}

    function setRevertOnMint(bool value) external {
        revertOnMint = value;
    }

    function setRevertOnCollect(bool value) external {
        revertOnCollect = value;
    }

    function setFixedLiquidity(uint256 liquidity) external {
        fixedLiquidity = liquidity;
    }

    function setCollectAmounts(uint256 amount0, uint256 amount1) external {
        fixedCollectAmount0 = amount0;
        fixedCollectAmount1 = amount1;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (revertOnMint) revert MockRevert("mint");

        if (params.amount0Desired > 0) {
            IERC20(params.token0).safeTransferFrom(msg.sender, address(this), params.amount0Desired);
        }
        if (params.amount1Desired > 0) {
            IERC20(params.token1).safeTransferFrom(msg.sender, address(this), params.amount1Desired);
        }

        tokenId = nextTokenId++;
        positionToken0[tokenId] = params.token0;
        positionToken1[tokenId] = params.token1;
        _mint(params.recipient, tokenId);

        liquidity = uint128(fixedLiquidity);
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        if (revertOnCollect) revert MockRevert("collect");

        amount0 = fixedCollectAmount0;
        amount1 = fixedCollectAmount1;

        address t0 = positionToken0[params.tokenId];
        address t1 = positionToken1[params.tokenId];
        if (amount0 > 0 && t0 != address(0)) IERC20(t0).safeTransfer(params.recipient, amount0);
        if (amount1 > 0 && t1 != address(0)) IERC20(t1).safeTransfer(params.recipient, amount1);
    }

    /// @dev The real Uniswap V3 `positions()` 12-tuple (Task 8 coordinator
    ///      fix: `Locker.lockPosition` now decodes token0/token1 from here,
    ///      matching the real position manager's actual ABI instead of an
    ///      invented `positionTokens` selector). Every field besides
    ///      token0/token1 is a zero-valued placeholder — this mock only
    ///      tracks what `mint` stored per position.
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        nonce = 0;
        operator = address(0);
        token0 = positionToken0[tokenId];
        token1 = positionToken1[tokenId];
        fee = 0;
        tickLower = 0;
        tickUpper = 0;
        liquidity = 0;
        feeGrowthInside0LastX128 = 0;
        feeGrowthInside1LastX128 = 0;
        tokensOwed0 = 0;
        tokensOwed1 = 0;
    }
}

/// @notice Stands in for SwapRouter02, implementing both `exactInputSingle`
///         overloads pinned in `IUniswapV3.sol` (with-deadline and
///         no-deadline). Pulls `amountIn` of `tokenIn` from the caller
///         (requires prior approve) and pays out a fixed, test-configured
///         `amountOut` of `tokenOut` (pre-funded into this contract) to
///         `recipient` — both overloads share the same configured amount
///         and revert switch.
contract MockRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    uint256 public fixedAmountOut;
    bool public revertOnSwap;

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
        if (amountOut > 0) IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }
}

/// @notice Minimal WETH9 stand-in: deposit() mints wrapped ETH 1:1,
///         withdraw() burns and returns ETH. No revert switch — WETH isn't
///         one of the launch-flow steps Task 8 needs to fail.
contract MockWETH is ERC20, IWETH {
    constructor() ERC20("Mock Wrapped Ether", "mWETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "MockWETH: ETH transfer failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}
