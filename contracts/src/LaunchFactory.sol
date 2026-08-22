// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Token} from "./Token.sol";

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
contract LaunchFactory is Ownable2Step {
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

    error ZeroAddress();
    error Create2Failed();

    constructor(address owner_, address locker_, uint256 launchFee_) Ownable(owner_) {
        if (locker_ == address(0)) revert ZeroAddress();
        locker = locker_;
        launchFee = launchFee_;
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
}
