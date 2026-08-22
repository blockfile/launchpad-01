// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title INonfungiblePositionManagerMinimal
/// @notice Minimal slice of Uniswap V3's NonfungiblePositionManager that the
///         Locker needs. Both `collect` and `positions` are the REAL,
///         ABI-accurate Uniswap V3 shapes (selectors `0xfc6f7865` and
///         `0x99fbab88` respectively — both confirmed present, byte-for-byte,
///         in the live NonfungiblePositionManager's bytecode; see
///         task-6-report.md's `cast selectors` transcript). This file is a
///         genuine drop-in *subset* of the real contract, never a stand-in
///         with an invented selector.
///
///         Fix note (Task 8 coordinator review, critical): an earlier
///         version of this file declared a non-standard
///         `positionTokens(uint256) returns (address, address)` instead of
///         the real `positions(uint256)`. The real NonfungiblePositionManager
///         has no such selector — every real `Locker.lockPosition` call
///         (which runs inside every `LaunchFactory.launchToken`) would have
///         reverted with no matching function, bricking every real launch.
///         Replaced with the real `positions()` 12-tuple; `Locker` now
///         decodes `token0`/`token1` from indices 2/3 of that tuple.
interface INonfungiblePositionManagerMinimal {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// @notice Collects up to `amount0Max`/`amount1Max` of accrued fees for
    ///         `tokenId`, paid out directly (by the position manager) to
    ///         `recipient`.
    function collect(CollectParams calldata params) external returns (uint256 amount0, uint256 amount1);

    /// @notice The real Uniswap V3 `positions()` shape — the full 12-value
    ///         tuple, since Solidity return-tuple decoding is positional and
    ///         a truncated declaration would misdecode every field after the
    ///         cut. `Locker` only reads `token0`/`token1` (indices 2/3) out
    ///         of this; every other field must still be declared correctly
    ///         to decode safely, even though `Locker` never reads them.
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
        );
}
