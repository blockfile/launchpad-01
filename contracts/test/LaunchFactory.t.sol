// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {Token} from "../src/Token.sol";

/// @notice Test-only harness exposing LaunchFactory's internal CREATE2
///         helpers so the test suite can independently verify
///         `predictTokenAddress` against a *real* CREATE2 deploy executed
///         from the exact same contract address (CREATE2 addresses depend
///         on the deploying contract's own address, so the deploy must
///         happen on a LaunchFactory instance, not the test contract).
///         `deployWithInitcode` is deliberately business-logic-free (just
///         `_deploy`, the raw create2 opcode wrapper) — the test builds the
///         initcode bytes itself, independently of
///         `LaunchFactory._buildTokenInitcode`, so this cross-check does not
///         just call the same mapping code twice.
contract LaunchFactoryHarness is LaunchFactory {
    constructor(address owner_, address locker_, uint256 launchFee_) LaunchFactory(owner_, locker_, launchFee_) {}

    function deployWithInitcode(bytes32 salt, bytes memory initcode) external returns (address) {
        return _deploy(salt, initcode);
    }
}

contract LaunchFactoryTest is Test {
    LaunchFactoryHarness factory;

    address owner = address(0x0121EA);
    address locker = address(0x10C4E5);
    uint256 constant LAUNCH_FEE = 0.0005 ether;

    function setUp() public {
        factory = new LaunchFactoryHarness(owner, locker, LAUNCH_FEE);
    }

    function _ponsLaunchConfig() internal pure returns (LaunchFactory.LaunchConfig memory) {
        return LaunchFactory.LaunchConfig({
            pairToken: address(0xBEEF), // stand-in WETH
            graduationThreshold: 4.2 ether,
            initialTick: -204200,
            supply: 1_000_000_000e18,
            maxWalletBps: 500,
            maxTxBps: 550,
            restrictionBlocks: 2,
            reservedFee: 0,
            enabled: true,
            routerRequiresDeadline: false
        });
    }

    function _ponsDexConfig() internal pure returns (LaunchFactory.DexConfig memory) {
        return LaunchFactory.DexConfig({
            name: "robinhood-v3",
            factory: address(0xFAC7024),
            positionManager: address(0x9091),
            swapRouter: address(0x50171E12),
            poolFee: 10000,
            tickSpacing: 200,
            enabled: true
        });
    }

    // -------------------------------------------------------------------
    // Config round-trips
    // -------------------------------------------------------------------

    function test_setLaunchConfig_and_getLaunchConfig_roundtrip() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();

        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.LaunchConfig memory got = factory.getLaunchConfig(0);
        assertEq(got.pairToken, cfg.pairToken);
        assertEq(got.graduationThreshold, cfg.graduationThreshold);
        assertEq(got.initialTick, cfg.initialTick);
        assertEq(got.supply, cfg.supply);
        assertEq(got.maxWalletBps, cfg.maxWalletBps);
        assertEq(got.maxTxBps, cfg.maxTxBps);
        assertEq(got.restrictionBlocks, cfg.restrictionBlocks);
        assertEq(got.reservedFee, cfg.reservedFee);
        assertEq(got.enabled, cfg.enabled);
        assertEq(got.routerRequiresDeadline, cfg.routerRequiresDeadline);
    }

    function test_setLaunchConfig_reverts_if_not_owner() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.setLaunchConfig(0, cfg);
    }

    function test_setDexConfig_and_getDexConfig_roundtrip() public {
        LaunchFactory.DexConfig memory cfg = _ponsDexConfig();

        vm.prank(owner);
        factory.setDexConfig(0, cfg);

        LaunchFactory.DexConfig memory got = factory.getDexConfig(0);
        assertEq(got.name, cfg.name);
        assertEq(got.factory, cfg.factory);
        assertEq(got.positionManager, cfg.positionManager);
        assertEq(got.swapRouter, cfg.swapRouter);
        assertEq(got.poolFee, cfg.poolFee);
        assertEq(got.tickSpacing, cfg.tickSpacing);
        assertEq(got.enabled, cfg.enabled);
    }

    function test_setDexConfig_reverts_if_not_owner() public {
        LaunchFactory.DexConfig memory cfg = _ponsDexConfig();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        factory.setDexConfig(0, cfg);
    }

    // -------------------------------------------------------------------
    // launchFee()
    // -------------------------------------------------------------------

    function test_launchFee_returns_constructor_value() public view {
        assertEq(factory.launchFee(), LAUNCH_FEE);
    }

    function test_launchFee_is_whatever_the_constructor_was_given() public {
        LaunchFactoryHarness f2 = new LaunchFactoryHarness(owner, locker, 123456789);
        assertEq(f2.launchFee(), 123456789);
    }

    // -------------------------------------------------------------------
    // getLaunchedToken() — no launch path yet, must read as empty
    // -------------------------------------------------------------------

    function test_getLaunchedToken_empty_for_unknown_token() public view {
        LaunchFactory.LaunchedToken memory rec = factory.getLaunchedToken(address(0xABCD));
        assertFalse(rec.exists);
        assertEq(rec.token, address(0));
        assertEq(rec.supply, 0);
    }

    // -------------------------------------------------------------------
    // canLaunch
    // -------------------------------------------------------------------

    function test_canLaunch_true_by_default_public_open() public view {
        assertTrue(factory.canLaunch(address(0x1234)));
    }

    function test_canLaunch_false_when_launch_disabled() public {
        vm.prank(owner);
        factory.setLaunchEnabled(false);
        assertFalse(factory.canLaunch(address(0x1234)));
    }

    function test_canLaunch_whitelist_gating_when_public_closed() public {
        address allowed = address(0xA11CE);
        address notAllowed = address(0xB0B);

        vm.startPrank(owner);
        factory.setPublicLaunchOpen(false);
        factory.setWhitelistedLauncher(allowed, true);
        vm.stopPrank();

        assertTrue(factory.canLaunch(allowed));
        assertFalse(factory.canLaunch(notAllowed));
    }

    function test_canLaunch_whitelisted_still_false_if_globally_disabled() public {
        address allowed = address(0xA11CE);

        vm.startPrank(owner);
        factory.setPublicLaunchOpen(false);
        factory.setWhitelistedLauncher(allowed, true);
        factory.setLaunchEnabled(false);
        vm.stopPrank();

        assertFalse(factory.canLaunch(allowed));
    }

    // -------------------------------------------------------------------
    // predictTokenAddress + the CREATE2 cross-check
    // -------------------------------------------------------------------

    /// @dev Independently mirrors `LaunchFactory._buildTokenInitcode` —
    ///      deliberately re-derived here (not calling the factory's
    ///      internal function) so this test exercises the *actual* mapping
    ///      rules, not just "the same function called twice."
    function _expectedInitcode(
        LaunchFactory.TokenParams memory params,
        LaunchFactory.LaunchConfig memory cfg,
        address factoryAddr,
        address deployer
    ) internal pure returns (bytes memory) {
        Token.Socials memory tokenSocials = Token.Socials({
            twitter: params.socials.twitter,
            telegram: params.socials.telegram,
            discord: params.socials.discord,
            website: params.socials.website,
            farcaster: params.socials.farcaster
        });
        Token.TokenMeta memory meta = Token.TokenMeta({
            name: params.name,
            symbol: params.symbol,
            logo: params.logo,
            description: params.description,
            socials: tokenSocials
        });
        address launchBuyer = params.feeWallet != address(0) ? params.feeWallet : deployer;

        return abi.encodePacked(
            type(Token).creationCode,
            abi.encode(
                meta, cfg.supply, factoryAddr, address(0), cfg.restrictionBlocks, cfg.maxWalletBps, cfg.maxTxBps, launchBuyer
            )
        );
    }

    function _defaultParams(address feeWallet) internal pure returns (LaunchFactory.TokenParams memory) {
        LaunchFactory.Socials memory socials =
            LaunchFactory.Socials({twitter: "t", telegram: "tg", discord: "d", website: "w", farcaster: "f"});
        return LaunchFactory.TokenParams({
            name: "Test Token",
            symbol: "TST",
            logo: "ipfs://logo",
            description: "a test token",
            socials: socials,
            feeWallet: feeWallet
        });
    }

    function test_predictTokenAddress_matches_actual_create2_deploy_zero_feeWallet() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        address deployer = address(0xD00D);
        bytes32 salt = keccak256("salt-1");

        address predicted = factory.predictTokenAddress(params, 0, 0, salt, deployer);

        bytes memory expectedInitcode = _expectedInitcode(params, cfg, address(factory), deployer);
        address deployed = factory.deployWithInitcode(salt, expectedInitcode);

        assertEq(deployed, predicted, "predicted address must match the real CREATE2 deploy");
        assertTrue(deployed.code.length > 0, "deployed address must actually have code");

        // Sanity: the deployed Token really did receive the mapped args.
        Token deployedToken = Token(deployed);
        assertEq(deployedToken.balanceOf(address(factory)), cfg.supply);
        assertEq(deployedToken.launchBuyer(), deployer); // feeWallet was zero
        assertEq(deployedToken.pairPool(), address(0));
        assertEq(deployedToken.restrictionBlocks(), cfg.restrictionBlocks);
        assertEq(deployedToken.maxWalletBps(), cfg.maxWalletBps);
        assertEq(deployedToken.maxTxBps(), cfg.maxTxBps);
    }

    function test_predictTokenAddress_matches_actual_create2_deploy_nonzero_feeWallet() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(1, cfg);

        address feeWallet = address(0xFEE1);
        LaunchFactory.TokenParams memory params = _defaultParams(feeWallet);
        address deployer = address(0xD00D2);
        bytes32 salt = keccak256("salt-2");

        address predicted = factory.predictTokenAddress(params, 1, 0, salt, deployer);

        bytes memory expectedInitcode = _expectedInitcode(params, cfg, address(factory), deployer);
        address deployed = factory.deployWithInitcode(salt, expectedInitcode);

        assertEq(deployed, predicted);
        assertEq(Token(deployed).launchBuyer(), feeWallet); // feeWallet wins over deployer
    }

    function test_predictTokenAddress_is_deterministic() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        address deployer = address(0xD00D);
        bytes32 salt = keccak256("salt-3");

        address a = factory.predictTokenAddress(params, 0, 0, salt, deployer);
        address b = factory.predictTokenAddress(params, 0, 0, salt, deployer);
        assertEq(a, b);
    }

    function test_predictTokenAddress_changes_with_salt() public {
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        address deployer = address(0xD00D);

        address a = factory.predictTokenAddress(params, 0, 0, keccak256("salt-A"), deployer);
        address b = factory.predictTokenAddress(params, 0, 0, keccak256("salt-B"), deployer);
        assertTrue(a != b);
    }

    function test_predictTokenAddress_changes_with_dexId_unused_but_deployer_changes_it() public {
        // dexId does not affect the address (Token's constructor args never
        // depend on it) but the deployer/launchBuyer selection does.
        LaunchFactory.LaunchConfig memory cfg = _ponsLaunchConfig();
        vm.prank(owner);
        factory.setLaunchConfig(0, cfg);

        LaunchFactory.TokenParams memory params = _defaultParams(address(0));
        bytes32 salt = keccak256("salt-same");

        address predictedDex0 = factory.predictTokenAddress(params, 0, 0, salt, address(0xAAA1));
        address predictedDex7 = factory.predictTokenAddress(params, 0, 7, salt, address(0xAAA1));
        assertEq(predictedDex0, predictedDex7, "dexId must not affect the predicted Token address");

        address predictedOtherDeployer = factory.predictTokenAddress(params, 0, 0, salt, address(0xAAA2));
        assertTrue(predictedDex0 != predictedOtherDeployer, "a different deployer must change the address");
    }
}
