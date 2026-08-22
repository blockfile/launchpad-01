// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
library FeeMath {
    error InsufficientValue();
    /// @return feeOut the protocol launch fee, buyOut the remainder available for the atomic dev buy.
    function splitValue(uint256 value, uint256 fee) internal pure returns (uint256 feeOut, uint256 buyOut) {
        if (value < fee) revert InsufficientValue();
        feeOut = fee;
        buyOut = value - fee; // safe: value >= fee checked above; no unchecked{}
    }
}
