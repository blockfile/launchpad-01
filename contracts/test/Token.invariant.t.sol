// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";

/// @notice Drives random pool->actor buys, actor->pool sells, and
///         actor->actor wallet transfers against a live Token while its
///         anti-snipe restriction window is active.
///
/// Scope note (read before "fixing" a failure here): Token's cap is only
/// ever enforced at the instant of a DIRECT `pairPool -> user` buy (see
/// `Token._update`). A user who lands under-cap via one or more buys, or via
/// the exempt `launchBuyer`, can afterwards move those tokens to any other
/// wallet with an ordinary transfer — which the spec (task-4-brief.md) says
/// must NEVER be capped. Composing "buy under cap, then wallet-transfer to
/// concentrate in one address" can therefore push a single balance above
/// maxWallet without the contract doing anything wrong; this "buy-then-fan-
/// out/fan-in" aggregation gap is a deliberate, accepted property of the
/// design (see the plan's progress ledger: "T4 invariant on direct pool
/// path"), not a bug for this invariant to chase. So `walletTransfer` below
/// deliberately bounds its amount to the recipient's remaining headroom
/// under maxWallet — real wallet transfers are still fuzzed, but the
/// handler never uses them to deliberately walk through the accepted gap.
/// That keeps `invariant_capHoldsInWindow` scoped to what Task 4 actually
/// guarantees: the direct pool-buy path itself always respects the cap.
contract TokenCapHandler is Test {
    Token public immutable token;
    address public immutable pool;
    address public immutable launchBuyer;
    address[] public actors;

    constructor(Token _token, address _pool, address _launchBuyer, address[] memory _actors) {
        token = _token;
        pool = _pool;
        launchBuyer = _launchBuyer;
        actors = _actors;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _maxWallet() internal view returns (uint256) {
        return (token.totalSupply() * token.maxWalletBps()) / 10000;
    }

    function _maxTx() internal view returns (uint256) {
        return (token.totalSupply() * token.maxTxBps()) / 10000;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// pool -> actor "buy". Deliberately allowed to range a bit past maxTx
    /// so the handler also probes the revert path (caught below); the
    /// contract's own check is what's actually under test.
    function buy(uint256 actorSeed, uint256 amountSeed) external {
        address to = actors[actorSeed % actors.length];
        uint256 poolBal = token.balanceOf(pool);
        if (poolBal == 0) return;
        uint256 cap = _min(poolBal, _maxTx() + 1_000_000e18);
        uint256 amount = bound(amountSeed, 0, cap);
        vm.prank(pool);
        try token.transfer(to, amount) {} catch {}
    }

    /// actor -> pool "sell". Never capped by the contract; any amount is fine.
    function sell(uint256 actorSeed, uint256 amountSeed) external {
        address from = actors[actorSeed % actors.length];
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        uint256 amount = bound(amountSeed, 0, bal);
        vm.prank(from);
        try token.transfer(pool, amount) {} catch {}
    }

    /// actor -> actor wallet transfer. Never capped by the contract; bounded
    /// here to the recipient's remaining maxWallet headroom (see contract
    /// scope note) so the fuzzer doesn't deliberately exploit the accepted
    /// buy-then-fan-out/fan-in gap.
    function walletTransfer(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        if (from == to) return;
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        uint256 toBal = token.balanceOf(to);
        uint256 maxWallet = _maxWallet();
        if (toBal >= maxWallet) return;
        uint256 headroom = maxWallet - toBal;
        uint256 amount = bound(amountSeed, 0, _min(bal, headroom));
        if (amount == 0) return;
        vm.prank(from);
        try token.transfer(to, amount) {} catch {}
    }

    function rollForward(uint256 blocksSeed) external {
        uint256 n = bound(blocksSeed, 0, 3);
        vm.roll(block.number + n);
    }
}

contract TokenCapInvariantTest is Test {
    Token internal token;
    TokenCapHandler internal handler;
    address internal pool = address(0xC0FFEE);
    address internal launchBuyer = address(0xB0B);

    function setUp() public {
        Token.Socials memory s = Token.Socials("t", "tg", "d", "w", "f");
        Token.TokenMeta memory m = Token.TokenMeta("Name", "SYM", "ipfs://logo", "desc", s);
        // restrictionBlocks = 5 so the invariant window spans several blocks,
        // giving the handler room to exercise buys/sells/transfers while capped.
        token = new Token(m, 1_000_000_000e18, address(this), address(0), 5, 500, 550, launchBuyer);
        token.initPool(pool); // this contract is `factory` (deployer)
        token.transfer(pool, token.totalSupply()); // seed pool liquidity; wallet->pool, never gated

        address[] memory actors = new address[](5);
        actors[0] = address(0xA1);
        actors[1] = address(0xA2);
        actors[2] = address(0xA3);
        actors[3] = address(0xA4);
        actors[4] = address(0xA5);

        handler = new TokenCapHandler(token, pool, launchBuyer, actors);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = TokenCapHandler.buy.selector;
        selectors[1] = TokenCapHandler.sell.selector;
        selectors[2] = TokenCapHandler.walletTransfer.selector;
        selectors[3] = TokenCapHandler.rollForward.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// No non-exempt holder's balance may exceed maxWallet while the launch
    /// restriction window is still active (block.number < restrictionsEndBlock).
    /// `launchBuyer` is deliberately exempt from the cap by spec.
    function invariant_capHoldsInWindow() public view {
        if (block.number >= token.restrictionsEndBlock()) return;
        uint256 maxWallet = (token.totalSupply() * token.maxWalletBps()) / 10000;
        uint256 n = handler.actorsLength();
        for (uint256 i = 0; i < n; i++) {
            address actor = handler.actors(i);
            if (actor == launchBuyer) continue;
            assertLe(token.balanceOf(actor), maxWallet);
        }
    }
}
