// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INonfungiblePositionManagerMinimal} from "./interfaces/INonfungiblePositionManagerMinimal.sol";

/// @title Locker
/// @notice Permanent custody for a launched token's Uniswap V3 LP-NFT, plus
///         fee collection/splitting. Locking is **permanent by construction**:
///         this contract deliberately exposes no withdraw, no rescue, and no
///         arbitrary-call function, so there is no selector — under any
///         owner, deployer, or fee-collector permission — that can move a
///         locked position out. The only thing ever extractable is swap fees
///         via `collectFees`, split between the token's creator and the
///         protocol.
///
///         `positionManager` plays both roles the real Uniswap V3
///         NonfungiblePositionManager plays: it is the ERC721 the LP-NFT
///         lives on (custody is proven by `ownerOf(positionId) ==
///         address(this)`, and inbound transfers are accepted via
///         `ERC721Holder`'s `onERC721Received`), and it is the periphery
///         contract `collectFees` calls to pull accrued fees. The real
///         interface is defined in a later task; here it is the minimal
///         `INonfungiblePositionManagerMinimal` slice.
contract Locker is Ownable2Step, ERC721Holder {
    using SafeERC20 for IERC20;

    /// @notice Hard ceiling on the protocol's share of collected fees, out of
    ///         100. `creatorShare = 100 - protocolFeeShare`, so the creator
    ///         is guaranteed at least half.
    uint256 public constant MAX_PROTOCOL_FEE_SHARE = 50;

    /// @notice The only address permitted to call `lockPosition`. Set once,
    ///         immutably, at construction — matches the plan's "Locker wired
    ///         to the factory as an immutable constructor arg" decision so a
    ///         deployment can never be repointed at a different factory.
    address public immutable factory;

    /// @notice The Uniswap V3 NonfungiblePositionManager (both the LP-NFT's
    ///         ERC721 contract and the `collect()` periphery contract).
    address public immutable positionManager;

    /// @notice Owner-controlled destination for the protocol's share of
    ///         collected fees. Defaults to the initial owner.
    address public protocolWallet;

    struct TokenLock {
        bool locked;
        /// @dev The wallet recorded at lock time as the token's deployer;
        ///      see `lockPosition` for how it's derived. Only this address
        ///      may call `setFeeRedirect` for the token.
        address deployer;
        /// @dev Where the creator's share of collected fees is paid;
        ///      set at lock time by the factory, redirectable thereafter
        ///      only by `deployer` via `setFeeRedirect`.
        address creatorWallet;
        /// @dev Snapshotted from `protocolFeeShare` at lock time.
        uint256 protocolFeeShare;
        uint256 positionId;
        address token0;
        address token1;
    }

    /// @notice Per-token lock record, keyed by the launched token's address.
    mapping(address => TokenLock) public tokenLocks;

    /// @notice Owner-managed allow-list of addresses permitted to trigger
    ///         `collectFees`. Being an allow-listed collector does not grant
    ///         any custody or redirect power — it only triggers the fixed
    ///         70/30-style split to the already-recorded wallets.
    mapping(address => bool) public feeCollectors;

    error NotFactory();
    error AlreadyLocked();
    error NotLocked();
    error NotDeployer();
    error NotFeeCollector();
    error FeeShareTooHigh();
    error ZeroAddress();

    event PositionLocked(
        address indexed token, uint256 indexed positionId, address indexed deployer, uint256 protocolFeeShare
    );
    event FeesCollected(
        address indexed token, uint256 amount0, uint256 amount1, address creatorWallet, address protocolWallet
    );
    event FeeRedirectSet(address indexed token, address indexed wallet);
    event FeeCollectorSet(address indexed collector, bool allowed);
    event ProtocolWalletSet(address wallet);

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(address factory_, address positionManager_, address owner_) Ownable(owner_) {
        if (factory_ == address(0) || positionManager_ == address(0)) revert ZeroAddress();
        factory = factory_;
        positionManager = positionManager_;
        protocolWallet = owner_;
    }

    /// @notice Records the fee-split policy for `token` and marks its
    ///         position (`positionId`) as locked. Callable only by `factory`.
    ///
    ///         `deployer`, `creatorWallet`, and `protocolFeeShare` are all
    ///         supplied explicitly by the caller (the factory), not inferred.
    ///         An earlier version of this function derived `deployer` from
    ///         `tx.origin` (reasoning: `onlyFactory` means the only call
    ///         chain reaching here is `EOA -> factory -> Locker`, so
    ///         `tx.origin` is "safe" here). That reasoning breaks the moment
    ///         the launch is submitted on the user's behalf rather than
    ///         directly by their EOA — a Safe/multisig, an ERC-4337 account,
    ///         or any gasless/relayed flow — because `tx.origin` is always
    ///         the top-level transaction signer (a relayer/bundler/paymaster),
    ///         never the smart-contract wallet that actually asked to launch.
    ///         That would silently record the wrong `deployer` and, since
    ///         locking is permanent with no rescue path, permanently lock the
    ///         real creator out of `setFeeRedirect` with no way to fix it.
    ///         Requiring the factory to pass `deployer`/`creatorWallet`
    ///         explicitly removes that failure mode entirely: the factory is
    ///         the one place that already knows who actually requested the
    ///         launch, regardless of transaction plumbing.
    ///
    ///         Similarly, `protocolFeeShare` is now the value snapshotted
    ///         directly from this call's argument (bounds-checked against
    ///         `MAX_PROTOCOL_FEE_SHARE`), not a mutable global default — the
    ///         factory decides the policy per launch.
    ///
    ///         Custody of the LP-NFT itself is taken separately: `factory`
    ///         calls `positionManager.safeTransferFrom(factory, address(this),
    ///         positionId)` itself (this contract just needs to accept it via
    ///         `ERC721Holder`); `lockPosition` only does the bookkeeping.
    function lockPosition(
        address token,
        uint256 positionId,
        address deployer,
        address creatorWallet,
        uint256 protocolFeeShare
    ) external onlyFactory {
        if (tokenLocks[token].locked) revert AlreadyLocked();
        if (deployer == address(0) || creatorWallet == address(0)) revert ZeroAddress();
        if (protocolFeeShare > MAX_PROTOCOL_FEE_SHARE) revert FeeShareTooHigh();

        // The real Uniswap V3 `positions()` 12-tuple; token0/token1 live at
        // indices 2/3 (fixed, per the coordinator's Task 8 review — an
        // earlier version called a non-standard `positionTokens` selector
        // that the real position manager doesn't implement, which would
        // have reverted every real launch).
        (,, address token0, address token1,,,,,,,,) =
            INonfungiblePositionManagerMinimal(positionManager).positions(positionId);

        tokenLocks[token] = TokenLock({
            locked: true,
            deployer: deployer,
            creatorWallet: creatorWallet,
            protocolFeeShare: protocolFeeShare,
            positionId: positionId,
            token0: token0,
            token1: token1
        });

        emit PositionLocked(token, positionId, deployer, protocolFeeShare);
    }

    /// @notice Pulls accrued fees for `token`'s locked position to this
    ///         contract, then pushes the 70/30-style split (per the
    ///         snapshotted `protocolFeeShare`) out to `creatorWallet` and
    ///         `protocolWallet`. Gated by the `feeCollectors` allow-list —
    ///         this only ever moves *fees*, never the locked position itself.
    function collectFees(address token) external returns (uint256 amount0, uint256 amount1) {
        if (!feeCollectors[msg.sender]) revert NotFeeCollector();

        TokenLock storage rec = tokenLocks[token];
        if (!rec.locked) revert NotLocked();

        (amount0, amount1) = INonfungiblePositionManagerMinimal(positionManager).collect(
            INonfungiblePositionManagerMinimal.CollectParams({
                tokenId: rec.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        uint256 creatorSharePct = 100 - rec.protocolFeeShare;
        address creatorWallet = rec.creatorWallet;
        _distribute(rec.token0, amount0, creatorSharePct, creatorWallet);
        _distribute(rec.token1, amount1, creatorSharePct, creatorWallet);

        emit FeesCollected(token, amount0, amount1, creatorWallet, protocolWallet);
    }

    function _distribute(address token, uint256 amount, uint256 creatorSharePct, address creatorWallet) private {
        if (amount == 0) return;
        uint256 creatorAmount = (amount * creatorSharePct) / 100;
        uint256 protocolAmount = amount - creatorAmount;
        if (creatorAmount > 0) IERC20(token).safeTransfer(creatorWallet, creatorAmount);
        if (protocolAmount > 0) IERC20(token).safeTransfer(protocolWallet, protocolAmount);
    }

    /// @notice Redirects where `token`'s creator fee share is paid.
    ///         Callable only by the wallet recorded as `token`'s deployer at
    ///         lock time.
    function setFeeRedirect(address token, address wallet) external {
        TokenLock storage rec = tokenLocks[token];
        if (!rec.locked) revert NotLocked();
        if (msg.sender != rec.deployer) revert NotDeployer();
        if (wallet == address(0)) revert ZeroAddress();

        rec.creatorWallet = wallet;
        emit FeeRedirectSet(token, wallet);
    }

    /// @notice Owner-managed allow-list controlling who may call `collectFees`.
    function setFeeCollector(address collector, bool allowed) external onlyOwner {
        feeCollectors[collector] = allowed;
        emit FeeCollectorSet(collector, allowed);
    }

    /// @notice Sets the destination wallet for the protocol's share of
    ///         collected fees.
    function setProtocolWallet(address wallet) external onlyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        protocolWallet = wallet;
        emit ProtocolWalletSet(wallet);
    }
}
