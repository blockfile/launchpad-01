// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

/// @title TickMath
/// @notice `getSqrtRatioAtTick` vendored from Uniswap V3's `v3-core`
///         `contracts/libraries/TickMath.sol` (GPL-2.0-or-later), fetched
///         verbatim from
///         https://raw.githubusercontent.com/Uniswap/v3-core/main/contracts/libraries/TickMath.sol
///         and diffed byte-for-byte against that source before porting —
///         see task-8-report.md for the transcript. Only `getSqrtRatioAtTick`
///         is ported; `getTickAtSqrtRatio` (the inverse, needed only for
///         reading a pool's current tick back out of a price) is unused by
///         `LaunchFactory` and deliberately omitted to keep the vendored
///         surface, and the risk of a transcription error in unused code, as
///         small as possible.
///
///         Porting notes (0.7.6 -> 0.8.24): the original has no `unchecked{}`
///         blocks because Solidity <0.8.0 never reverts on overflow. Under
///         0.8.x this still compiles and behaves identically **without**
///         `unchecked` because no step actually overflows uint256: `ratio`
///         never exceeds 2**128, every multiplier constant is < 2**128, so
///         every `ratio * constant` product is < 2**256 and fits. Kept as
///         ordinary checked arithmetic (not `unchecked`) specifically so a
///         future change that broke that invariant would revert loudly
///         instead of silently wrapping. The only semantic change from the
///         original is swapping its `require(cond, 'T')` string-revert for a
///         custom error (`TickOutOfRange`), matching this repo's convention
///         (see `FeeMath.InsufficientValue`) — the math itself is untouched.
library TickMath {
    error TickOutOfRange();

    /// @dev The minimum tick that may be passed to `getSqrtRatioAtTick`,
    ///      computed from log base 1.0001 of 2**-128.
    int24 internal constant MIN_TICK = -887272;
    /// @dev The maximum tick that may be passed to `getSqrtRatioAtTick`,
    ///      computed from log base 1.0001 of 2**128.
    int24 internal constant MAX_TICK = -MIN_TICK;

    /// @notice Calculates sqrt(1.0001^tick) * 2^96.
    /// @dev Reverts if |tick| > MAX_TICK.
    /// @param tick The input tick for the above formula.
    /// @return sqrtPriceX96 A Q64.96 fixed-point number representing the
    ///         sqrt of the ratio of the two assets (token1/token0) at the
    ///         given tick.
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        if (absTick > uint256(int256(MAX_TICK))) revert TickOutOfRange();

        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) ratio = type(uint256).max / ratio;

        // Divides by 1<<32 rounding up to go from a Q128.128 to a Q128.96.
        // Downcast is safe: the result always fits within 160 bits given the
        // tick input constraint enforced above.
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}
