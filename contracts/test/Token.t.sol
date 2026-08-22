// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";
contract TokenMetaTest is Test {
    Token tok;
    function setUp() public {
        Token.Socials memory s = Token.Socials("t","tg","d","w","f");
        Token.TokenMeta memory m = Token.TokenMeta("Name","SYM","ipfs://logo","desc", s);
        tok = new Token(m, 1_000_000_000e18, address(0xBEEF));
    }
    function test_fixed_supply_minted_to_target() public view {
        assertEq(tok.totalSupply(), 1_000_000_000e18);
        assertEq(tok.balanceOf(address(0xBEEF)), 1_000_000_000e18);
        assertEq(tok.decimals(), 18);
    }
    function test_metadata_stored() public view {
        assertEq(tok.name(), "Name");
        assertEq(tok.symbol(), "SYM");
        assertEq(tok.logo(), "ipfs://logo");
        assertEq(tok.description(), "desc");
    }
}
