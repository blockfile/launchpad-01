// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";
contract TokenMetaTest is Test {
    Token tok;
    function setUp() public {
        Token.Socials memory s = Token.Socials("t","tg","d","w","f");
        Token.TokenMeta memory m = Token.TokenMeta("Name","SYM","ipfs://logo","desc", s);
        tok = new Token(m, 1_000_000_000e18, address(0xBEEF), address(0), 2, 500, 550, address(0));
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

/// Anti-snipe transfer-cap hook rules, exercised through the real external
/// `transfer()` entrypoint (pranked as the relevant `from`), per
/// task-4-brief.md. `pairPool` is wired up via `initPool` in setUp — this
/// test contract is the deployer (`msg.sender` in the constructor), so it is
/// the `factory` and is the only address allowed to call `initPool`.
contract TokenCapTest is Test {
    Token tok;
    address pool = address(0xC0FFEE);
    address launchBuyer = address(0xB0B);
    address alice = address(0xA11CE);

    uint256 constant SUPPLY = 1_000_000_000e18;
    uint256 constant FIVE_PCT = 50_000_000e18; // 500 bps of SUPPLY (maxWallet)
    uint256 constant FIVE_FIVE_PCT = 55_000_000e18; // 550 bps of SUPPLY (maxTx)

    function setUp() public {
        Token.Socials memory s = Token.Socials("t", "tg", "d", "w", "f");
        Token.TokenMeta memory m = Token.TokenMeta("Name", "SYM", "ipfs://logo", "desc", s);
        // restrictionBlocks = 2: launchBlock is the full-ban block, launchBlock+1
        // is the single capped block, launchBlock+2 (== restrictionsEndBlock) is free.
        tok = new Token(m, SUPPLY, address(this), address(0), 2, 500, 550, launchBuyer);
        tok.initPool(pool); // this contract is `factory` (deployer)
        tok.transfer(pool, SUPPLY); // seed the pool with the full supply; wallet->pool is never gated
    }

    // --- Rule 1: launch-block ban -------------------------------------

    function test_launchBlock_buy_to_nonLaunchBuyer_reverts() public {
        vm.prank(pool);
        vm.expectRevert(Token.LaunchBlockBuyBlocked.selector);
        tok.transfer(alice, 1e18);
    }

    function test_launchBlock_buy_to_launchBuyer_passes() public {
        vm.prank(pool);
        tok.transfer(launchBuyer, 1e18);
        assertEq(tok.balanceOf(launchBuyer), 1e18);
    }

    // --- Rule 2: capped block (launchBlock+1) --------------------------

    function test_capBlock_tx_over_five_five_pct_reverts() public {
        vm.roll(block.number + 1); // launchBlock + 1
        vm.prank(pool);
        vm.expectRevert(Token.CapExceeded.selector);
        tok.transfer(alice, FIVE_FIVE_PCT + 1);
    }

    function test_capBlock_wallet_pushed_over_five_pct_reverts() public {
        vm.roll(block.number + 1);
        vm.prank(pool);
        tok.transfer(alice, FIVE_PCT); // exactly at maxWallet: allowed
        vm.prank(pool);
        vm.expectRevert(Token.CapExceeded.selector);
        tok.transfer(alice, 1); // any more pushes alice over maxWallet
    }

    function test_capBlock_within_both_limits_passes() public {
        vm.roll(block.number + 1);
        vm.prank(pool);
        tok.transfer(alice, FIVE_PCT); // == maxTx boundary is 5.5%, == maxWallet boundary is 5%
        assertEq(tok.balanceOf(alice), FIVE_PCT);
    }

    function test_capBlock_buy_to_launchBuyer_uncapped() public {
        vm.roll(block.number + 1);
        vm.prank(pool);
        tok.transfer(launchBuyer, SUPPLY); // exempt from both caps
        assertEq(tok.balanceOf(launchBuyer), SUPPLY);
    }

    // --- Rule 3: restrictions lifted at restrictionsEndBlock -----------

    function test_restrictionsEndBlock_lifts_caps() public {
        vm.roll(block.number + 2); // == restrictionsEndBlock
        vm.prank(pool);
        tok.transfer(alice, FIVE_FIVE_PCT + 1_000_000e18); // over both old caps; must pass now
        assertEq(tok.balanceOf(alice), FIVE_FIVE_PCT + 1_000_000e18);
    }

    // --- Rule 4: sells and wallet transfers are never capped -----------

    function test_sell_never_capped_even_in_window() public {
        // acquire a big balance via the launchBuyer exemption (still launchBlock)
        vm.prank(pool);
        tok.transfer(launchBuyer, SUPPLY);
        // sell the whole thing back to the pool, still in the launch block
        vm.prank(launchBuyer);
        tok.transfer(pool, SUPPLY);
        assertEq(tok.balanceOf(pool), SUPPLY);
        assertEq(tok.balanceOf(launchBuyer), 0);
    }

    function test_walletToWallet_never_capped_even_in_window() public {
        vm.prank(pool);
        tok.transfer(launchBuyer, SUPPLY); // still launchBlock, exempt recipient
        vm.prank(launchBuyer);
        tok.transfer(alice, SUPPLY); // wallet->wallet, far over both caps, must pass
        assertEq(tok.balanceOf(alice), SUPPLY);
    }

    // --- initPool access control ---------------------------------------

    function test_initPool_reverts_if_already_set() public {
        vm.expectRevert(Token.PoolAlreadySet.selector);
        tok.initPool(address(0xDEAD));
    }

    function test_initPool_reverts_if_not_factory() public {
        Token.Socials memory s = Token.Socials("t", "tg", "d", "w", "f");
        Token.TokenMeta memory m = Token.TokenMeta("Name", "SYM", "ipfs://logo", "desc", s);
        Token fresh = new Token(m, SUPPLY, address(this), address(0), 2, 500, 550, launchBuyer);
        vm.prank(alice);
        vm.expectRevert(Token.NotFactory.selector);
        fresh.initPool(pool);
    }

    // --- Fuzz: in-window pool->fresh-holder buy reverts iff over either cap

    function testFuzz_capBlock_reverts_iff_over_limits(uint256 amount) public {
        vm.roll(block.number + 1); // launchBlock + 1: capped window
        amount = bound(amount, 0, SUPPLY);
        bool overTx = amount > FIVE_FIVE_PCT;
        bool overWallet = amount > FIVE_PCT; // alice starts fresh: balanceOf(alice)+amount == amount
        vm.prank(pool);
        if (overTx || overWallet) {
            vm.expectRevert(Token.CapExceeded.selector);
            tok.transfer(alice, amount);
        } else {
            tok.transfer(alice, amount);
            assertEq(tok.balanceOf(alice), amount);
        }
    }
}
