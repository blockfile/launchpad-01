// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Locker} from "../src/Locker.sol";
import {INonfungiblePositionManagerMinimal} from "../src/interfaces/INonfungiblePositionManagerMinimal.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Minimal mint-on-demand ERC20 standing in for the pool's token0/token1 legs.
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Stands in for Uniswap V3's NonfungiblePositionManager: it IS the ERC721
/// holding the LP-NFT (mirroring the real contract, which is both the NFT
/// and the periphery position manager at one address) and implements the
/// minimal `collect`/`positions` slice the Locker consumes. `collect`
/// pays out fixed, test-configured amounts (pre-funded into this contract)
/// so the split can be asserted deterministically.
contract MockPositionManager is ERC721, INonfungiblePositionManagerMinimal {
    address public immutable token0;
    address public immutable token1;
    uint256 public fixedAmount0;
    uint256 public fixedAmount1;

    constructor(address token0_, address token1_) ERC721("MockPosition", "MPOS") {
        token0 = token0_;
        token1 = token1_;
    }

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function setCollectAmounts(uint256 amount0, uint256 amount1) external {
        fixedAmount0 = amount0;
        fixedAmount1 = amount1;
    }

    /// @dev The real Uniswap V3 `positions()` 12-tuple (Task 8 coordinator
    ///      fix). Return values are left unnamed to avoid shadowing this
    ///      contract's own `token0`/`token1` immutables, which are returned
    ///      directly at indices 2/3; every other field is a zero placeholder.
    function positions(uint256)
        external
        view
        returns (
            uint96,
            address,
            address,
            address,
            uint24,
            int24,
            int24,
            uint128,
            uint256,
            uint256,
            uint128,
            uint128
        )
    {
        return (0, address(0), token0, token1, 0, 0, 0, 0, 0, 0, 0, 0);
    }

    function collect(CollectParams calldata params) external returns (uint256 amount0, uint256 amount1) {
        amount0 = fixedAmount0;
        amount1 = fixedAmount1;
        if (amount0 > 0) IERC20(token0).transfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(token1).transfer(params.recipient, amount1);
    }
}

contract LockerTest is Test {
    Locker locker;
    MockPositionManager pm;
    MockERC20 token0;
    MockERC20 token1;

    address factory = address(0xFACC0FFEE);
    address owner = address(0x0121EA);
    address deployer = address(0xDEC10CED);
    address collector = address(0xC011EC70A);

    // Arbitrary stand-in for the launched meme-coin address (the map key);
    // Task 5 does not require it to be a real Token.sol instance.
    address launchedToken = address(0x70CE1000001);
    uint256 constant POSITION_ID = 1;
    uint256 constant PROTOCOL_FEE_SHARE = 30; // creatorShare = 70

    function setUp() public {
        token0 = new MockERC20("Token0", "TK0");
        token1 = new MockERC20("Token1", "TK1");
        pm = new MockPositionManager(address(token0), address(token1));
        locker = new Locker(factory, address(pm), owner);

        // Simulate the position manager having minted the LP-NFT to the
        // factory (the real launch flow's mint step, out of scope here).
        pm.mint(factory, POSITION_ID);

        // Fund the position manager so `collect()` has real balances to pay
        // out, mirroring the real contract pushing accrued fees to `recipient`.
        token0.mint(address(pm), 1_000e18);
        token1.mint(address(pm), 1_000e18);
    }

    /// Simulates the real launch flow: the factory (the only onlyFactory
    /// caller) transfers the LP-NFT to the Locker, then calls `lockPosition`
    /// passing the deployer/creatorWallet/protocolFeeShare it already knows
    /// explicitly (no tx.origin inference — see the doc-comment on
    /// `Locker.lockPosition` for why that was replaced).
    function _transferNftAndLock() internal {
        vm.prank(factory);
        pm.safeTransferFrom(factory, address(locker), POSITION_ID);

        vm.prank(factory);
        locker.lockPosition(launchedToken, POSITION_ID, deployer, deployer, PROTOCOL_FEE_SHARE);
    }

    // --- 1. onlyFactory ---------------------------------------------------

    function test_lockPosition_reverts_if_not_factory() public {
        vm.expectRevert(Locker.NotFactory.selector);
        locker.lockPosition(launchedToken, POSITION_ID, deployer, deployer, PROTOCOL_FEE_SHARE);
    }

    function test_lockPosition_reverts_on_double_lock() public {
        _transferNftAndLock();

        vm.prank(factory);
        vm.expectRevert(Locker.AlreadyLocked.selector);
        locker.lockPosition(launchedToken, POSITION_ID, deployer, deployer, PROTOCOL_FEE_SHARE);
    }

    function test_lockPosition_reverts_if_protocolFeeShare_exceeds_max() public {
        uint256 tooHigh = locker.MAX_PROTOCOL_FEE_SHARE() + 1; // 51
        vm.prank(factory);
        vm.expectRevert(Locker.FeeShareTooHigh.selector);
        locker.lockPosition(launchedToken, POSITION_ID, deployer, deployer, tooHigh);
    }

    // --- 2. custody + no exit path -----------------------------------------

    function test_lockPosition_takes_custody_and_records_snapshot() public {
        _transferNftAndLock();

        assertEq(pm.ownerOf(POSITION_ID), address(locker));

        (bool locked, address rec_deployer, address creatorWallet, uint256 protocolFeeShare,,,) =
            locker.tokenLocks(launchedToken);
        assertTrue(locked);
        assertEq(rec_deployer, deployer);
        assertEq(creatorWallet, deployer); // set to the deployer by this test's helper, until redirected
        assertEq(protocolFeeShare, PROTOCOL_FEE_SHARE);
    }

    function test_no_selector_moves_the_position_out() public {
        _transferNftAndLock();

        // There is no withdraw/rescue/arbitrary-call function on the Locker
        // that can move the NFT out. Prove it at runtime too: every plausible
        // "get my NFT out" selector, called on the Locker itself, must fail
        // because no such function exists (no fallback either, so an
        // unmatched selector always reverts).
        (bool ok1,) = address(locker).call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(locker), collector, POSITION_ID)
        );
        assertFalse(ok1);

        (bool ok2,) = address(locker).call(
            abi.encodeWithSignature(
                "safeTransferFrom(address,address,uint256)", address(locker), collector, POSITION_ID
            )
        );
        assertFalse(ok2);

        (bool ok3,) = address(locker).call(abi.encodeWithSignature("withdraw(address)", launchedToken));
        assertFalse(ok3);

        (bool ok4,) = address(locker).call(abi.encodeWithSignature("rescue(address,address,uint256)", address(pm), collector, POSITION_ID));
        assertFalse(ok4);

        (bool ok5,) = address(locker).call(abi.encodeWithSignature("execute(address,bytes)", address(pm), ""));
        assertFalse(ok5);

        (bool ok6,) = address(locker).call(abi.encodeWithSignature("emergencyWithdraw(uint256)", POSITION_ID));
        assertFalse(ok6);

        assertEq(pm.ownerOf(POSITION_ID), address(locker)); // still stuck, untouched
    }

    // --- 3. collectFees: 70/30 split, feeCollector-gated -------------------

    function test_collectFees_reverts_if_not_feeCollector() public {
        _transferNftAndLock();
        pm.setCollectAmounts(100e18, 200e18);

        vm.expectRevert(Locker.NotFeeCollector.selector);
        locker.collectFees(launchedToken);
    }

    function test_collectFees_splits_70_30_to_creator_and_protocol() public {
        _transferNftAndLock();
        pm.setCollectAmounts(100e18, 200e18);

        vm.prank(owner);
        locker.setFeeCollector(collector, true);

        address protocolWallet = locker.protocolWallet();

        vm.prank(collector);
        (uint256 a0, uint256 a1) = locker.collectFees(launchedToken);

        assertEq(a0, 100e18);
        assertEq(a1, 200e18);

        // creatorShare = 100 - protocolFeeShare(30) = 70
        assertEq(token0.balanceOf(deployer), 70e18);
        assertEq(token0.balanceOf(protocolWallet), 30e18);
        assertEq(token1.balanceOf(deployer), 140e18);
        assertEq(token1.balanceOf(protocolWallet), 60e18);
    }

    // --- 4. setFeeRedirect: deployer-only, redirects the creator share ----

    function test_setFeeRedirect_reverts_if_not_deployer() public {
        _transferNftAndLock();

        vm.expectRevert(Locker.NotDeployer.selector);
        locker.setFeeRedirect(launchedToken, address(0xBEEF));
    }

    function test_setFeeRedirect_changes_where_creator_share_lands() public {
        _transferNftAndLock();
        address newWallet = address(0xBEEF);

        vm.prank(deployer);
        locker.setFeeRedirect(launchedToken, newWallet);

        (,, address creatorWallet,,,,) = locker.tokenLocks(launchedToken);
        assertEq(creatorWallet, newWallet);

        // Prove it's not just bookkeeping: collectFees actually pays the
        // redirected wallet, not the original deployer.
        pm.setCollectAmounts(10e18, 10e18);
        vm.prank(owner);
        locker.setFeeCollector(collector, true);

        vm.prank(collector);
        locker.collectFees(launchedToken);

        assertEq(token0.balanceOf(newWallet), 7e18);
        assertEq(token0.balanceOf(deployer), 0);
    }
}
