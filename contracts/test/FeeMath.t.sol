// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {FeeMath} from "../src/lib/FeeMath.sol";
contract FeeMathHarness {
    function split(uint256 v, uint256 f) external pure returns (uint256, uint256) {
        return FeeMath.splitValue(v, f);
    }
}
contract FeeMathTest is Test {
    function test_exact_fee_gives_zero_buy() public pure {
        (uint256 f, uint256 b) = FeeMath.splitValue(1 ether, 1 ether);
        assertEq(f, 1 ether); assertEq(b, 0);
    }
    function test_splits_remainder_to_buy() public pure {
        (uint256 f, uint256 b) = FeeMath.splitValue(3 ether, 1 ether);
        assertEq(f, 1 ether); assertEq(b, 2 ether);
    }
    function test_reverts_below_fee() public {
        FeeMathHarness h = new FeeMathHarness();
        vm.expectRevert(FeeMath.InsufficientValue.selector);
        h.split(1 ether - 1, 1 ether);
    }
    function testFuzz_conserves_value(uint256 value, uint256 fee) public pure {
        vm.assume(value >= fee);
        (uint256 f, uint256 b) = FeeMath.splitValue(value, fee);
        assertEq(f, fee); assertEq(f + b, value);
    }
}
