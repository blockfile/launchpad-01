// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Token} from "./Token.sol";
import {Locker} from "./Locker.sol";
import {FeeMath} from "./lib/FeeMath.sol";
import {TickMath} from "./lib/TickMath.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    INonfungiblePositionManager,
    ISwapRouter,
    IV3SwapRouter,
    ISwapRouter02,
    IWETH
} from "./interfaces/IUniswapV3.sol";

/// @title LaunchFactory
/// @notice Config storage, provenance record, and CREATE2 address prediction
///         for our launchpad. This task (Task 7) deliberately stops short of
///         the atomic `launchToken` entrypoint (Task 8) — everything here is
///         the surface `launchToken` will be built on: the structs, the
///         owner-managed `LaunchConfig`/`DexConfig` tables, the authoritative
///         `LaunchedToken` provenance getter (empty/`exists == false` until
///         Task 8 starts writing it), the `canLaunch` gate, and — the
///         security-critical piece — a `predictTokenAddress` that computes
///         the CREATE2 address using the **exact** initcode Task 8's deploy
///         must use, so a launch always lands where it was predicted.
///
///         Admin surface (`setLaunchConfig`/`setDexConfig`) is `Ownable2Step`.
///         Per the spec, these are money/DEX-rewiring-adjacent controls and
///         belong behind a timelock + multisig in production — that is a
///         **deployment-time** decision (Task 10's `Deploy.s.sol` should set
///         `owner_` to a `TimelockController`, not an EOA), not something
///         this contract enforces itself.
contract LaunchFactory is Ownable2Step, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Structs
    // ---------------------------------------------------------------------

    /// @notice Same 5-field social-links shape as `Token.Socials`. Kept as a
    ///         distinct type (not a re-use of `Token.Socials`) because
    ///         `TokenParams` is *our* external ABI surface — callers building
    ///         a launch transaction shouldn't need to import `Token.sol` at
    ///         all. `predictTokenAddress`/the launch path convert into
    ///         `Token.Socials` internally (see `_buildTokenInitcode`).
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    /// @notice Caller-supplied, per-launch token metadata + the dev-buy
    ///         recipient override. Mirrors pons v1's `TokenParams` shape
    ///         exactly (positional-tuple ABI, so field order matters):
    ///         `feeWallet == address(0)` means "the launching wallet
    ///         (`deployer`) becomes the dev-buy recipient" — see
    ///         `_buildTokenInitcode`'s `launchBuyer` selection.
    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address feeWallet;
    }

    /// @notice Per-`launchConfigId` economics, snapshotted into a token's
    ///         `LaunchedToken` record at launch time (Task 8) so a later
    ///         admin edit here can never retroactively change a live token's
    ///         rules. Field list matches pons v1's `LaunchConfig` exactly
    ///         (`docs/research/10-factory.md` §1.5, itself read from the
    ///         verified live factory's ABI).
    struct LaunchConfig {
        address pairToken; // quote asset the pool is created against (WETH)
        uint256 graduationThreshold; // carried for parity; inert in v1 (spec)
        int24 initialTick; // opening price, Uniswap-tick-encoded
        uint256 supply; // total token supply minted (whole supply, 18dp)
        uint16 maxWalletBps; // anti-snipe: max bps of supply one address may hold
        uint16 maxTxBps; // anti-snipe: max bps of supply per single buy
        uint32 restrictionBlocks; // length of the anti-snipe window, in blocks
        uint24 reservedFee; // carried for parity with pons v1; unused here
        bool enabled;
        bool routerRequiresDeadline; // selects which SwapRouter ABI shape (Task 8)
    }

    /// @notice Per-`dexId` venue wiring — the live Uniswap-V3-shaped
    ///         addresses and pool parameters. DEX addresses are read from
    ///         config, never hardcoded in `Token`. Field list matches pons
    ///         v1's `DexConfig` exactly (`docs/research/10-factory.md` §1.6).
    struct DexConfig {
        string name;
        address factory; // Uniswap-v3-shaped pool factory
        address positionManager; // NFT position manager (the LP-lock target)
        address swapRouter; // SwapRouter or SwapRouter02
        uint24 poolFee; // e.g. 10000 = 1%
        int24 tickSpacing;
        bool enabled;
    }

    /// @notice The factory's own authoritative provenance record for a
    ///         launched token — never trust a token's self-reported getters
    ///         (a dusted/hostile ERC-20 can claim whatever it likes about
    ///         itself). `exists == false` means this factory never launched
    ///         `token`. Written by Task 8's `launchToken`; this task only
    ///         adds the storage + `getLaunchedToken` getter (always returns
    ///         the zero-valued struct, `exists == false`, until then). Field
    ///         list matches pons v1's `LaunchedToken` exactly
    ///         (`docs/research/10-factory.md` §1.8).
    struct LaunchedToken {
        address token;
        address deployer;
        address pairedToken;
        address positionManager;
        uint256 positionId;
        uint256 dexId;
        uint256 launchConfigId;
        uint256 restrictionsEndBlock;
        uint256 supply;
        bool isToken0;
        uint24 poolFee;
        bool exists;
        uint256 initialBuyAmount;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The permanent LP locker. Immutable — a deployed factory can
    ///         never be repointed at a different locker (spec §LaunchFactory
    ///         Admin).
    address public immutable locker;

    /// @notice The protocol launch fee, in wei, collected on every launch
    ///         (Task 8). Pons v1 live value is `0.0005 ether`; kept as a
    ///         constructor arg (not hardcoded) so tests/deploy scripts can
    ///         set it explicitly and it's never silently out of sync with
    ///         the live-verified figure.
    uint256 public immutable launchFee;

    /// @notice Destination for the collected `launchFee` on every launch.
    ///         Immutable (Task 8 decision — mirrors `locker`/`launchFee`):
    ///         picked over an owner-mutable setter so the protocol fee
    ///         destination can never be silently redirected post-deploy by a
    ///         compromised/careless owner key; a deployment that genuinely
    ///         needs to change it redeploys the factory, same as `locker`.
    address public immutable protocolWallet;

    /// @notice The protocol's fixed share of the swap-fee split passed to
    ///         `Locker.lockPosition` on every launch (creator keeps the
    ///         other 70%). Matches the settled 70/30 parameter; fixed, not
    ///         owner-adjustable, and comfortably under Locker's own
    ///         `MAX_PROTOCOL_FEE_SHARE == 50` ceiling (checked there too).
    uint256 public constant PROTOCOL_FEE_SHARE = 30;

    mapping(uint256 => LaunchConfig) private _launchConfigs;
    mapping(uint256 => DexConfig) private _dexConfigs;
    mapping(address => LaunchedToken) private _launchedTokens;

    /// @notice Global kill switch for `canLaunch`. Defaults to `true`.
    bool public launchEnabled = true;

    /// @notice When `true` (default), any address passes `canLaunch`'s
    ///         allow-list check. When `false`, only addresses in
    ///         `whitelistedLaunchers` pass. Mirrors pons v2's
    ///         `launchEnabled`/`whitelistedLaunchers` split (see
    ///         `docs/research/10-factory.md` §2.9) — `whitelistedLaunchers`
    ///         alone is never the whole answer, `canLaunch` is.
    bool public publicLaunchOpen = true;

    /// @notice One input to `canLaunch` (only consulted when
    ///         `publicLaunchOpen == false`) — see `canLaunch`.
    mapping(address => bool) public whitelistedLaunchers;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event LaunchConfigSet(uint256 indexed id);
    event DexConfigSet(uint256 indexed id);
    event LaunchEnabledSet(bool enabled);
    event PublicLaunchOpenSet(bool open);
    event WhitelistedLauncherSet(address indexed launcher, bool allowed);

    /// @notice Our own launch-provenance event — the A -> B/C contract (see
    ///         the design spec). Emitted once, at the very end of a
    ///         successful `launchToken`, after every other effect has
    ///         already landed.
    event TokenLaunched(
        address indexed token,
        address indexed deployer,
        address pool,
        uint256 launchConfigId,
        uint256 dexId,
        uint256 supply,
        uint256 initialBuyAmount
    );

    error ZeroAddress();
    error Create2Failed();
    /// @dev `canLaunch(msg.sender)` was false at the top of `launchToken`.
    error LaunchNotAllowed();
    /// @dev `launchConfigId` resolved to a config with `enabled == false`
    ///      (including an unset id, which reads as the zero-valued struct).
    error LaunchConfigDisabled();
    /// @dev `dexId` resolved to a DEX config with `enabled == false`
    ///      (including an unset id).
    error DexConfigDisabled();
    /// @dev The low-level ETH transfer of the launch fee to `protocolWallet`
    ///      failed (e.g. `protocolWallet` is a contract with no
    ///      payable/receive fallback). All-or-nothing: this reverts the
    ///      entire launch rather than stranding the fee.
    error FeeTransferFailed();

    constructor(address owner_, address locker_, uint256 launchFee_, address protocolWallet_) Ownable(owner_) {
        if (locker_ == address(0) || protocolWallet_ == address(0)) revert ZeroAddress();
        locker = locker_;
        launchFee = launchFee_;
        protocolWallet = protocolWallet_;
    }

    // ---------------------------------------------------------------------
    // Owner-only config admin
    // ---------------------------------------------------------------------

    /// @notice Sets (or replaces) the `LaunchConfig` at `id`. Money/DEX-
    ///         adjacent: production deployments should route this through a
    ///         timelock + multisig owner (see contract-level NatSpec).
    ///         Existing `LaunchedToken` records are immutable snapshots
    ///         (Task 8) and are never affected by a later edit here.
    function setLaunchConfig(uint256 id, LaunchConfig calldata config) external onlyOwner {
        _launchConfigs[id] = config;
        emit LaunchConfigSet(id);
    }

    /// @notice Sets (or replaces) the `DexConfig` at `id`. Same timelock
    ///         caveat as `setLaunchConfig`.
    function setDexConfig(uint256 id, DexConfig calldata config) external onlyOwner {
        _dexConfigs[id] = config;
        emit DexConfigSet(id);
    }

    /// @notice Global kill switch consulted by `canLaunch`.
    function setLaunchEnabled(bool enabled_) external onlyOwner {
        launchEnabled = enabled_;
        emit LaunchEnabledSet(enabled_);
    }

    /// @notice Toggles whether `canLaunch` accepts any address (`true`) or
    ///         only `whitelistedLaunchers` (`false`).
    function setPublicLaunchOpen(bool open_) external onlyOwner {
        publicLaunchOpen = open_;
        emit PublicLaunchOpenSet(open_);
    }

    /// @notice Adds/removes `launcher` from the allow-list `canLaunch`
    ///         consults when `publicLaunchOpen == false`.
    function setWhitelistedLauncher(address launcher, bool allowed) external onlyOwner {
        whitelistedLaunchers[launcher] = allowed;
        emit WhitelistedLauncherSet(launcher, allowed);
    }

    // ---------------------------------------------------------------------
    // Getters
    // ---------------------------------------------------------------------

    function getLaunchConfig(uint256 id) external view returns (LaunchConfig memory) {
        return _launchConfigs[id];
    }

    function getDexConfig(uint256 id) external view returns (DexConfig memory) {
        return _dexConfigs[id];
    }

    /// @notice The authoritative provenance source — see the struct's
    ///         NatSpec. Returns the zero-valued struct (`exists == false`)
    ///         for any address this factory has never launched.
    function getLaunchedToken(address token) external view returns (LaunchedToken memory) {
        return _launchedTokens[token];
    }

    /// @notice The single composed launch gate. `launcher` may launch iff
    ///         the global switch is on AND (public launching is open OR
    ///         `launcher` is individually whitelisted). Reading
    ///         `whitelistedLaunchers` alone is never the right check —
    ///         mirrors pons v2's documented footgun (a wallet can pass
    ///         `canLaunch` via `publicLaunchOpen` without ever being
    ///         whitelisted individually); always call `canLaunch`, never
    ///         `whitelistedLaunchers` directly, to gate an actual launch.
    function canLaunch(address launcher) public view returns (bool) {
        return launchEnabled && (publicLaunchOpen || whitelistedLaunchers[launcher]);
    }

    // ---------------------------------------------------------------------
    // CREATE2 address prediction
    // ---------------------------------------------------------------------

    /// @notice Computes the CREATE2 address a launch with these exact
    ///         inputs would deploy `Token` to. **Must** use the exact
    ///         initcode Task 8's `launchToken` uses (see `_buildTokenInitcode`
    ///         below for the full arg-mapping and why) — a mismatch strands
    ///         any pre-sent value at a not-yet-deployed address. `dexId` is
    ///         part of this signature for parity with the launch call (a DEX
    ///         choice never changes the Token's own constructor args, so it
    ///         does not affect the address) and is intentionally unused here.
    function predictTokenAddress(
        TokenParams calldata params,
        uint256 launchConfigId,
        uint256 dexId,
        bytes32 salt,
        address deployer
    ) external view returns (address) {
        dexId; // unused: the DEX choice never changes Token's constructor args
        LaunchConfig memory config = _launchConfigs[launchConfigId];
        bytes memory initcode = _buildTokenInitcode(params, config, deployer);
        return _computeCreate2Address(salt, keccak256(initcode));
    }

    /// @dev Builds the exact `Token` constructor calldata a launch deploys
    ///      with, per the task-7 brief's arg mapping (load-bearing — Task 8
    ///      MUST reuse this exact function, not re-derive it):
    ///        - `meta`        = `Token.TokenMeta` built from `params`.
    ///        - `supply`      = `config.supply`.
    ///        - `mintTo`      = `address(this)` — the factory holds the
    ///                          whole supply until it seeds the pool
    ///                          (Task 8).
    ///        - `pairPool_`   = `address(0)` — the pool doesn't exist yet at
    ///                          deploy time; wired later via `initPool`.
    ///        - `restrictionBlocks_`/`maxWalletBps_`/`maxTxBps_`
    ///                        = from `config`.
    ///        - `launchBuyer_` = `params.feeWallet` if non-zero, else
    ///                           `deployer` (the dev-buy recipient).
    ///      Initcode = `type(Token).creationCode ++ abi.encode(...)` those
    ///      args, in that order — this is what both `predictTokenAddress`
    ///      and Task 8's actual `new Token{salt: salt}(...)` (or equivalent
    ///      `_deploy` call) must hash/execute identically.
    function _buildTokenInitcode(TokenParams calldata params, LaunchConfig memory config, address deployer)
        internal
        view
        returns (bytes memory)
    {
        Token.TokenMeta memory meta = Token.TokenMeta({
            name: params.name,
            symbol: params.symbol,
            logo: params.logo,
            description: params.description,
            socials: Token.Socials({
                twitter: params.socials.twitter,
                telegram: params.socials.telegram,
                discord: params.socials.discord,
                website: params.socials.website,
                farcaster: params.socials.farcaster
            })
        });
        address launchBuyer = params.feeWallet != address(0) ? params.feeWallet : deployer;

        return abi.encodePacked(
            type(Token).creationCode,
            abi.encode(
                meta,
                config.supply,
                address(this),
                address(0),
                config.restrictionBlocks,
                config.maxWalletBps,
                config.maxTxBps,
                launchBuyer
            )
        );
    }

    /// @dev The standard CREATE2 address formula:
    ///      `keccak256(0xff ++ address(this) ++ salt ++ keccak256(initcode))[12:]`.
    ///      `address(this)` here is deliberate: CREATE2 addresses depend on
    ///      the *deploying* contract's own address, which is this factory in
    ///      both the predict path (here) and the real deploy path (Task 8's
    ///      `launchToken`, called on this same factory instance).
    function _computeCreate2Address(bytes32 salt, bytes32 initcodeHash) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initcodeHash)))));
    }

    /// @dev Raw CREATE2 deploy of `initcode` with `salt`, executed as
    ///      `address(this)` (this factory) — the counterpart Task 8's
    ///      `launchToken` must call (with `_buildTokenInitcode`'s output) so
    ///      a live deploy always lands where `predictTokenAddress` said it
    ///      would. No business logic lives here on purpose: keeping the
    ///      opcode wrapper generic (vs. re-deriving the CREATE2 hash by hand
    ///      here too) means this function and `_computeCreate2Address` are
    ///      independent implementations of the same EVM semantics, which is
    ///      exactly what the test suite's CREATE2 cross-check exercises.
    function _deploy(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        assembly {
            deployed := create2(0, add(initcode, 0x20), mload(initcode), salt)
        }
        if (deployed == address(0)) revert Create2Failed();
    }

    // ---------------------------------------------------------------------
    // The atomic launch (Task 8)
    // ---------------------------------------------------------------------

    /// @dev Pure bookkeeping struct threading the per-launch working state
    ///      (`config`/`dex` snapshots, the resolved `deployer`/`launchBuyer`,
    ///      the fee/buy split, and the two id's) between `launchToken` and
    ///      its internal helpers below. Exists purely so those helpers take
    ///      one memory-struct argument instead of 7-8 scalars each: with
    ///      everything passed as separate locals, `launchToken`'s own scope
    ///      held enough simultaneously-live stack slots (function params +
    ///      every intermediate value) to trip solc's legacy codegen with
    ///      `Stack too deep` at more than one call site — bundling collapses
    ///      that to one memory pointer per group. Never part of any
    ///      external/public function signature, so it never appears in this
    ///      contract's ABI.
    struct LaunchContext {
        LaunchConfig config;
        DexConfig dex;
        address deployer;
        address launchBuyer;
        uint256 launchConfigId;
        uint256 dexId;
        uint256 fee;
        uint256 buyAmount;
    }

    /// @notice Deploys a fixed-supply `Token`, creates and one-sided-seeds
    ///         its Uniswap V3 pool with the entire supply, permanently locks
    ///         the LP position in `locker`, records authoritative
    ///         provenance, collects the protocol launch fee, and (if the
    ///         caller sent more than `launchFee`) executes the creator's
    ///         atomic dev buy — all in one all-or-nothing transaction.
    ///
    ///         `nonReentrant` guards the whole call; every side effect below
    ///         is ordered checks-effects-interactions (config/gate checks ->
    ///         CREATE2 deploy -> pool creation/seed/lock -> the
    ///         `LaunchedToken` record write -> the two remaining external
    ///         value transfers) so that a revert at *any* step — whether
    ///         from this contract's own checks or from an externally
    ///         supplied DEX address behaving unexpectedly — unwinds
    ///         everything: no deployed Token, no created pool, no minted
    ///         position, no written record, no moved value. See
    ///         `test/LaunchFactory.t.sol`'s per-step revert matrix.
    /// @param params Caller-supplied token metadata + dev-buy recipient
    ///        override (see `TokenParams`).
    /// @param launchConfigId Selects the snapshotted `LaunchConfig` (supply,
    ///        anti-snipe caps, initial tick, ...).
    /// @param dexId Selects the snapshotted `DexConfig` (which Uniswap-V3-
    ///        shaped venue to launch on).
    /// @param salt The CREATE2 salt; the deployed Token's address is
    ///        whatever `predictTokenAddress(params, launchConfigId, dexId,
    ///        salt, msg.sender)` returns.
    /// @return token The address of the newly deployed Token.
    function launchToken(TokenParams calldata params, uint256 launchConfigId, uint256 dexId, bytes32 salt)
        external
        payable
        nonReentrant
        returns (address token)
    {
        if (!canLaunch(msg.sender)) revert LaunchNotAllowed();

        LaunchContext memory ctx = _buildLaunchContext(params, launchConfigId, dexId);

        // --- CREATE2-deploy the Token at the predicted address ---
        bytes memory initcode = _buildTokenInitcode(params, ctx.config, ctx.deployer);
        address predicted = _computeCreate2Address(salt, keccak256(initcode));
        token = _deploy(salt, initcode);
        // Sanity per the brief: `_deploy` (raw create2 opcode) and
        // `_computeCreate2Address` (manual keccak256 formula) are
        // independent implementations of the same CREATE2 semantics
        // (Task 7's cross-check tests already prove they agree) — this can
        // never actually diverge, so `assert` (not a user-facing revert) is
        // the right tool: it flags an invariant break, not an expected
        // failure mode.
        assert(token == predicted);

        // --- Create + initialize the pool, seed it one-sided, lock the LP-NFT ---
        (address pool, uint256 positionId, bool isToken0) = _createPoolAndSeed(token, ctx);

        // --- Write the authoritative provenance record ---
        _recordLaunch(token, positionId, isToken0, ctx);

        // --- Collect the protocol launch fee ---
        (bool sent,) = protocolWallet.call{value: ctx.fee}("");
        if (!sent) revert FeeTransferFailed();

        // --- Optional atomic dev buy ---
        // `amountOutMinimum = 0` is a reviewed decision, not an oversight:
        // there is no external price reference for a token at the moment of
        // its own birth, so a slippage bound here would be theater.
        if (ctx.buyAmount > 0) {
            _executeDevBuy(token, ctx);
        }

        emit TokenLaunched(token, ctx.deployer, pool, launchConfigId, dexId, ctx.config.supply, ctx.buyAmount);
    }

    /// @dev Loads + validates the `LaunchConfig`/`DexConfig` snapshots,
    ///      splits `msg.value`, and resolves `deployer`/`launchBuyer` into a
    ///      single `LaunchContext`. Split out of `launchToken` purely for
    ///      stack depth (see `LaunchContext`'s doc-comment).
    function _buildLaunchContext(TokenParams calldata params, uint256 launchConfigId, uint256 dexId)
        internal
        view
        returns (LaunchContext memory ctx)
    {
        ctx.config = _launchConfigs[launchConfigId];
        ctx.dex = _dexConfigs[dexId];
        if (!ctx.config.enabled) revert LaunchConfigDisabled();
        if (!ctx.dex.enabled) revert DexConfigDisabled();

        // `buyAmount` IS `msg.value - launchFee` by construction — there is
        // no separate caller-declared "initialBuyAmount" to cross-check
        // against; a caller who wants no dev buy simply sends exactly
        // `launchFee`. `splitValue` reverts `InsufficientValue` for
        // `msg.value < launchFee`.
        (ctx.fee, ctx.buyAmount) = FeeMath.splitValue(msg.value, launchFee);

        ctx.deployer = msg.sender;
        ctx.launchBuyer = params.feeWallet != address(0) ? params.feeWallet : ctx.deployer;
        ctx.launchConfigId = launchConfigId;
        ctx.dexId = dexId;
    }

    /// @dev Creates + initializes the Uniswap V3 pool at
    ///      `ctx.config.initialTick`, wires it into the just-deployed
    ///      `token` via `initPool`, seeds it one-sided with the entire
    ///      supply (approve + mint, LP-NFT minted straight to the Locker),
    ///      and locks the position. Split out of `launchToken` purely for
    ///      stack depth (see `LaunchContext`'s doc-comment); carries no
    ///      independent meaning outside that single call site.
    function _createPoolAndSeed(address token, LaunchContext memory ctx)
        internal
        returns (address pool, uint256 positionId, bool isToken0)
    {
        isToken0 = token < ctx.config.pairToken;
        (address token0, address token1) = isToken0 ? (token, ctx.config.pairToken) : (ctx.config.pairToken, token);
        pool = IUniswapV3Factory(ctx.dex.factory).createPool(token0, token1, ctx.dex.poolFee);
        IUniswapV3Pool(pool).initialize(TickMath.getSqrtRatioAtTick(ctx.config.initialTick));
        Token(token).initPool(pool);

        (int24 tickLower, int24 tickUpper) = _oneSidedTickRange(ctx.config.initialTick, ctx.dex.tickSpacing, isToken0);
        uint256 amount0Desired = isToken0 ? ctx.config.supply : 0;
        uint256 amount1Desired = isToken0 ? 0 : ctx.config.supply;

        IERC20(token).approve(ctx.dex.positionManager, ctx.config.supply);
        (positionId,,,) = INonfungiblePositionManager(ctx.dex.positionManager).mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: ctx.dex.poolFee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: locker,
                deadline: block.timestamp
            })
        );

        // creatorWallet mirrors launchBuyer's derivation exactly (same
        // params.feeWallet-or-deployer rule) — see the brief.
        Locker(locker).lockPosition(token, positionId, ctx.deployer, ctx.launchBuyer, PROTOCOL_FEE_SHARE);
    }

    /// @dev Writes the authoritative `LaunchedToken` provenance record. Split
    ///      out of `launchToken` purely for stack depth (see
    ///      `LaunchContext`'s doc-comment).
    function _recordLaunch(address token, uint256 positionId, bool isToken0, LaunchContext memory ctx) internal {
        _launchedTokens[token] = LaunchedToken({
            token: token,
            deployer: ctx.deployer,
            pairedToken: ctx.config.pairToken,
            positionManager: ctx.dex.positionManager,
            positionId: positionId,
            dexId: ctx.dexId,
            launchConfigId: ctx.launchConfigId,
            restrictionsEndBlock: Token(token).restrictionsEndBlock(),
            supply: ctx.config.supply,
            isToken0: isToken0,
            poolFee: ctx.dex.poolFee,
            exists: true,
            initialBuyAmount: ctx.buyAmount
        });
    }

    /// @dev Executes the atomic dev buy: wraps `ctx.buyAmount` ETH to the
    ///      config's paired asset (WETH) and swaps it for `token` via
    ///      `ctx.dex.swapRouter`, delivering the output to
    ///      `ctx.launchBuyer`. `amountOutMinimum = 0` throughout (see
    ///      `launchToken`'s doc-comment on why). Router ABI shape
    ///      (with/without a `deadline` field) is selected per
    ///      `ctx.config.routerRequiresDeadline`, matching `LaunchConfig`'s
    ///      documented purpose for that field. Split out of `launchToken`
    ///      purely for stack depth (see `LaunchContext`'s doc-comment).
    function _executeDevBuy(address token, LaunchContext memory ctx) internal {
        IWETH(ctx.config.pairToken).deposit{value: ctx.buyAmount}();
        IERC20(ctx.config.pairToken).approve(ctx.dex.swapRouter, ctx.buyAmount);

        if (ctx.config.routerRequiresDeadline) {
            ISwapRouter02(ctx.dex.swapRouter).exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: ctx.config.pairToken,
                    tokenOut: token,
                    fee: ctx.dex.poolFee,
                    recipient: ctx.launchBuyer,
                    deadline: block.timestamp,
                    amountIn: ctx.buyAmount,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            ISwapRouter02(ctx.dex.swapRouter).exactInputSingle(
                IV3SwapRouter.ExactInputSingleParams({
                    tokenIn: ctx.config.pairToken,
                    tokenOut: token,
                    fee: ctx.dex.poolFee,
                    recipient: ctx.launchBuyer,
                    amountIn: ctx.buyAmount,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }
    }

    /// @dev Computes the `[tickLower, tickUpper]` range for a one-sided
    ///      position holding the ENTIRE new-token supply and zero of the
    ///      paired asset, opened at `initialTick`. In Uniswap V3 a position
    ///      is 100% token0 while the pool's current tick <= tickLower (price
    ///      hasn't reached the lower bound yet) and 100% token1 while
    ///      current tick >= tickUpper. So:
    ///        - new token is token0: pin `tickLower` to the (ceiling-
    ///          aligned) `initialTick` and open `tickUpper` all the way to
    ///          the max usable tick — buys push price up through the whole
    ///          range, draining token0 (the new token) for token1 (the
    ///          paired asset).
    ///        - new token is token1: the mirror image — `tickUpper` pinned
    ///          to the floor-aligned `initialTick`, `tickLower` at the min
    ///          usable tick.
    ///      Ticks are aligned to `tickSpacing` (ceiling for the token0 case,
    ///      floor for the token1 case) so the range stays valid even if an
    ///      admin-set `initialTick` isn't already a multiple of
    ///      `tickSpacing` — defensive: a misaligned literal would otherwise
    ///      revert the whole launch inside the position manager's `mint`.
    function _oneSidedTickRange(int24 initialTick, int24 tickSpacing, bool tokenIsToken0)
        internal
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        int24 minUsable = (TickMath.MIN_TICK / tickSpacing) * tickSpacing;
        int24 maxUsable = (TickMath.MAX_TICK / tickSpacing) * tickSpacing;
        if (tokenIsToken0) {
            tickLower = _ceilToSpacing(initialTick, tickSpacing);
            tickUpper = maxUsable;
        } else {
            tickLower = minUsable;
            tickUpper = _floorToSpacing(initialTick, tickSpacing);
        }
    }

    /// @dev Rounds `tick` down to the nearest multiple of `tickSpacing`
    ///      (toward -infinity). Solidity's `/` truncates toward zero, which
    ///      already equals `floor()` for `tick >= 0`; the `tick < 0` branch
    ///      corrects the one case where truncation-toward-zero rounds the
    ///      wrong way.
    function _floorToSpacing(int24 tick, int24 tickSpacing) internal pure returns (int24) {
        int24 quotient = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) quotient -= 1;
        return quotient * tickSpacing;
    }

    /// @dev Rounds `tick` up to the nearest multiple of `tickSpacing`
    ///      (toward +infinity) — the mirror-image correction of
    ///      `_floorToSpacing`.
    function _ceilToSpacing(int24 tick, int24 tickSpacing) internal pure returns (int24) {
        int24 quotient = tick / tickSpacing;
        if (tick > 0 && tick % tickSpacing != 0) quotient += 1;
        return quotient * tickSpacing;
    }
}
