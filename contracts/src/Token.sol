// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Token
/// @notice Fixed-supply ERC20 with on-chain metadata. Full supply is minted
///         once, in the constructor, to `mintTo`; there is no post-construction
///         mint path.
contract Token is ERC20 {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenMeta {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
    }

    string private _logo;
    string private _description;
    Socials private _socials;

    /// @dev Reverts when a pool->buyer transfer lands in the launch block and
    ///      the recipient isn't the whitelisted `launchBuyer`.
    error LaunchBlockBuyBlocked();
    /// @dev Reverts when a pool->buyer transfer, while restrictions are still
    ///      active, exceeds the per-tx or per-wallet cap.
    error CapExceeded();
    /// @dev Reverts on `initPool` if called by anyone but `factory`.
    error NotFactory();
    /// @dev Reverts on `initPool` if `pairPool` was already set (constructor
    ///      arg or a prior `initPool` call).
    error PoolAlreadySet();

    /// @notice The address that deployed this Token (`msg.sender` in the
    ///         constructor). In the real flow this is the launchpad factory;
    ///         only `factory` may call `initPool`.
    address public immutable factory;

    /// @notice The AMM pool address that gates the anti-snipe checks: only
    ///         transfers with `from == pairPool` (buys) are restricted.
    ///         Set either at construction (if the pool address is already
    ///         known, e.g. deployed via CREATE2 ahead of the token) or
    ///         later via `initPool` (if the factory deploys the token first
    ///         and only learns the pool address once it creates the pool in
    ///         a follow-up call). Whichever path is used, it is settable
    ///         exactly once: the constructor arg and `initPool` both reject
    ///         overwriting a non-zero `pairPool`.
    address public pairPool;

    /// @notice Number of blocks (starting at `launchBlock`) during which
    ///         buys from `pairPool` are subject to the per-tx/per-wallet caps.
    uint32 public immutable restrictionBlocks;

    /// @notice Max wallet balance as a fraction of total supply, in bps
    ///         (10000 = 100%), enforced on buys while restrictions are active.
    uint16 public immutable maxWalletBps;

    /// @notice Max single-transfer size as a fraction of total supply, in
    ///         bps (10000 = 100%), enforced on buys while restrictions are active.
    uint16 public immutable maxTxBps;

    /// @notice Address exempt from the launch-block ban and the per-tx/per-
    ///         wallet caps (e.g. a pre-approved market maker or the first
    ///         liquidity add). Buys landing anywhere else are gated.
    address public immutable launchBuyer;

    /// @notice The block number this Token was deployed in.
    uint256 public immutable launchBlock;

    /// @notice The first block at which anti-snipe restrictions no longer
    ///         apply: `launchBlock + restrictionBlocks`.
    uint256 public immutable restrictionsEndBlock;

    constructor(
        TokenMeta memory meta,
        uint256 supply,
        address mintTo,
        address pairPool_,
        uint32 restrictionBlocks_,
        uint16 maxWalletBps_,
        uint16 maxTxBps_,
        address launchBuyer_
    ) ERC20(meta.name, meta.symbol) {
        _logo = meta.logo;
        _description = meta.description;
        _socials = meta.socials;

        factory = msg.sender;
        pairPool = pairPool_;
        restrictionBlocks = restrictionBlocks_;
        maxWalletBps = maxWalletBps_;
        maxTxBps = maxTxBps_;
        launchBuyer = launchBuyer_;
        launchBlock = block.number;
        restrictionsEndBlock = block.number + restrictionBlocks_;

        _mint(mintTo, supply);
    }

    /// @notice Sets `pairPool` once, when the constructor was given
    ///         `address(0)` because the pool didn't exist yet at deploy time.
    ///         Callable only by `factory`; reverts if `pairPool` is already
    ///         non-zero (set via the constructor or an earlier call).
    function initPool(address pool) external {
        if (msg.sender != factory) revert NotFactory();
        if (pairPool != address(0)) revert PoolAlreadySet();
        pairPool = pool;
    }

    /// @dev Anti-snipe hook. Only gates buys (`from == pairPool`); sells
    ///      (`to == pairPool`) and ordinary wallet-to-wallet transfers are
    ///      never capped. The `pairPool != address(0)` guard is required so
    ///      the constructor's initial `_mint` (from == address(0)) is never
    ///      mistaken for a buy while `pairPool` is still unset (address(0));
    ///      without it, `from == pairPool` would match `0 == 0` and the
    ///      launch-block-ban branch would revert the constructor's mint.
    function _update(address from, address to, uint256 value) internal override {
        if (pairPool != address(0) && from == pairPool) {
            if (block.number == launchBlock) {
                if (to != launchBuyer) revert LaunchBlockBuyBlocked();
            } else if (block.number < restrictionsEndBlock) {
                if (to != launchBuyer) {
                    uint256 maxTx = (totalSupply() * maxTxBps) / 10000;
                    uint256 maxWallet = (totalSupply() * maxWalletBps) / 10000;
                    if (value > maxTx || balanceOf(to) + value > maxWallet) {
                        revert CapExceeded();
                    }
                }
            }
        }
        super._update(from, to, value);
    }

    function logo() public view returns (string memory) {
        return _logo;
    }

    function description() public view returns (string memory) {
        return _description;
    }

    function socials() public view returns (Socials memory) {
        return _socials;
    }
}
