// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Uniswap V3 interfaces
/// @notice Minimal, ABI-accurate slices of the Uniswap V3 core + periphery
///         contracts the factory needs, plus canonical WETH9. Task 6.
///
///         Live-shape confirmation (see task-6-report.md for the full
///         `cast` transcript): the deployed NonfungiblePositionManager
///         (0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3) and SwapRouter02
///         (0xCaf681a66D020601342297493863E78C959E5cb2) on the custom
///         "robinhood" chain were introspected via their runtime bytecode
///         (`cast code --rpc-url` + `cast selectors --resolve`, since this
///         `cast` build's `interface` subcommand has no `--rpc-url` option).
///         Every selector this file defines for those two contracts was
///         found, byte-for-byte, in the live bytecode:
///           - `mint(...)` resolved to exactly the canonical MintParams
///             11-tuple (selector 0x88316456).
///           - `collect(...)` selector 0xfc6f7865 is present in the
///             bytecode and matches `cast sig
///             "collect((uint256,address,uint128,uint128))"` exactly
///             (the canonical CollectParams 4-tuple).
///           - `exactInputSingle` is present ONLY as the no-deadline
///             (IV3SwapRouter) 7-tuple shape, selector 0x04e45aaf. The
///             classic deadline-bearing ISwapRouter shape (selector
///             0x414bf389) is confirmed ABSENT from this router's
///             bytecode. Both shapes are still defined below per the
///             task spec (a factory built against this file can target
///             either a SwapRouter02-style or a classic ISwapRouter-style
///             deployment), but only the no-deadline one is live-verified
///             against this specific deployment.
///         `IUniswapV3Factory`/`IUniswapV3Pool` were not given a live
///         address in the task brief, so they use the documented
///         canonical Uniswap V3 core shapes (unverified against a live
///         deployment here — Task 9's fork test should confirm those).
interface IUniswapV3Factory {
    /// @notice Creates a pool for the given two tokens and fee. token
    ///         order does not matter; the factory sorts internally.
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);

    /// @notice Returns the pool address for the given pair and fee, or
    ///         address(0) if it does not exist. Order-independent.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);

    /// @notice The canonical tick spacing this factory enforces for pools of
    ///         the given fee tier (0 for a fee tier the factory does not
    ///         recognize). A standard Uniswap V3 factory function — the pool
    ///         `mint` only accepts ticks aligned to this spacing, so
    ///         `setDexConfig` validates a `DexConfig.tickSpacing` against it
    ///         (see `LaunchFactory.setDexConfig` / `TickSpacingMismatch`).
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IUniswapV3Pool {
    /// @notice Sets the initial price for the pool (only callable once,
    ///         before any liquidity has been added).
    function initialize(uint160 sqrtPriceX96) external;

    /// @notice The pool's current price/tick/observation state.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice The NonfungiblePositionManager IS the ERC721 the LP-NFT lives on
///         (custody + transfers go through the standard ERC721 surface)
///         *and* the periphery contract that mints/collects positions.
///         Live-verified against the deployed contract — see the
///         file-level note above.
interface INonfungiblePositionManager is IERC721 {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// @notice Creates a new position wrapped in an LP-NFT, minted to
    ///         `params.recipient`. Live selector 0x88316456.
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    /// @notice Collects up to `amount0Max`/`amount1Max` of accrued fees
    ///         for `params.tokenId`, paid to `params.recipient`. Live
    ///         selector 0xfc6f7865.
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

/// @notice The classic (V1) SwapRouter shape: `exactInputSingle` takes an
///         explicit per-call `deadline` field. Not found on the live
///         SwapRouter02 deployment checked for this task (see file-level
///         note) — included so this file supports a factory that targets
///         a router deployed with this shape.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice The SwapRouter02 shape: `exactInputSingle` has no `deadline`
///         field (SwapRouter02 enforces deadlines via its
///         `multicall(uint256 deadline, bytes[] data)` entrypoint
///         instead). Live-verified: selector 0x04e45aaf, present in the
///         deployed SwapRouter02's bytecode with exactly this 7-field
///         tuple.
interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice SwapRouter02 exposing both `exactInputSingle` shapes per the
///         task spec, referencing each parent's struct by qualified name
///         rather than inheriting both interfaces directly — `ISwapRouter`
///         and `IV3SwapRouter` each declare their own `ExactInputSingleParams`
///         struct, and combining both via `is ISwapRouter, IV3SwapRouter`
///         triggers solc's "Identifier already declared" error since the
///         two same-named structs collide in the merged namespace. Declaring
///         the two overloads directly (each taking its parent's
///         `ExactInputSingleParams` by qualified reference) sidesteps that
///         while keeping both call shapes on one interface. Only the
///         no-deadline (`IV3SwapRouter`) shape was found on the live
///         deployment checked for this task.
interface ISwapRouter02 {
    function exactInputSingle(IV3SwapRouter.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @notice Canonical WETH9: deposit/withdraw plus the standard ERC20
///         surface.
interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
