// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title INonfungiblePositionManagerMinimal
/// @notice Minimal slice of Uniswap V3's NonfungiblePositionManager that the
///         Locker needs for Task 5. The full, ABI-accurate interface (mint,
///         decreaseLiquidity, the real `positions()` 12-value tuple, etc.) is
///         defined in a later task and will replace this file; the NFT side
///         of the position manager is consumed separately via OZ's `IERC721`.
///
///         `collect`'s name/shape is the real Uniswap V3 one (kept identical
///         on purpose so a later swap-in is a drop-in). `positionTokens` is
///         deliberately NOT named `positions` so it can never collide with
///         the real contract's `positions(uint256)` selector (which returns
///         a different, much larger tuple) — if this minimal interface were
///         ever mistakenly pointed at a live position manager, the call must
///         revert (no matching selector), never silently misdecode someone
///         else's tuple as `(token0, token1)`.
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

    /// @dev Task-5-only helper so the Locker can learn a position's pair
    ///      addresses without the real, much larger `positions()` tuple.
    ///      Not part of the real Uniswap ABI — see the contract-level note.
    function positionTokens(uint256 tokenId) external view returns (address token0, address token1);
}
