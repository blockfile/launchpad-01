# Sub-project A — Contracts (pons v1 launchpad clone)

**Status:** approved design, 2026-08-22
**Repo:** launchpad-01 (fresh) · **Chain:** Robinhood Chain (id 4663; testnet 46630)
**Depends on research:** [docs/research/00-digest.md](../../research/00-digest.md) §1–2, §5

## Goal

Our own on-chain launchpad contracts that reproduce **pons v1** exactly: one atomic
transaction deploys a fixed-supply ERC-20, creates and seeds its Uniswap V3 pool,
**permanently** locks the LP position, records authoritative provenance, and
optionally executes the creator's atomic dev buy — with an un-bypassable short
anti-snipe window. Built as *our own* contracts (not pons's), so we control fees,
branding, and the event/ABI surface the rest of the project is typed against.

## Scope & non-goals

- **In:** `Token.sol`, `LaunchFactory.sol`, `Locker.sol`, the interfaces to the live
  Robinhood-Chain Uniswap V3 deployment, Foundry tests + deploy scripts, and the
  ABI/address artifacts published to `packages/shared`.
- **Out (separate sub-projects):** the indexer (B) and frontend (C). This spec only
  defines what they'll be typed against, not their internals.
- **Out (later track):** the v2 bonding-curve model. WETH-only pair (no multi-quote).
  No graduation state transition (v1's `graduationThreshold` is cosmetic — carried in
  the record for parity, inert).

## Settled parameters (match pons v1 exactly)

| Parameter | Value |
|---|---|
| Supply | 1,000,000,000 (1e9), 18 decimals, minted once at construction, **no mint()** |
| Launch fee | 0.0005 ETH (`500000000000000` wei) |
| Pool | Uniswap V3, WETH-quoted, **1% fee tier** (`poolFee = 10000`), `tickSpacing = 200` |
| Initial tick | config-set (pons live `-204200`); one-sided seed of full supply |
| Max wallet / max tx | 5% / 5.5% of supply (`maxWalletBps = 500` / `maxTxBps = 550`) |
| Restriction window | 2 contract-visible blocks (≈32s on this chain — see block-time note) |
| Swap-fee split | 70% creator / 30% protocol (`protocolFeeShare` snapshotted per token, ≤ 50) |
| `graduationThreshold` | 4.2 ETH, carried for parity, **inert** in v1 |
| Ongoing token tax | none — only the 1% Uniswap swap fee |

Numbers live in `LaunchConfig`/`DexConfig` structs and are **snapshotted into each
token's immutable `LaunchedToken` record at launch**, so an admin config edit can
never retroactively change a live token's rules.

## Contracts

### `Token.sol`
- Fixed-supply ERC-20 (OpenZeppelin base). Whole supply minted to the factory in the
  constructor; **no `mint`, no owner-mint, no upgradeability**.
- On-chain self-describing metadata: `name`, `symbol`, `decimals=18`, `logo` (non-empty,
  baked into the CREATE2 preimage), `description`, `Socials{twitter,telegram,discord,website,farcaster}`.
- **Transfer hook (the anti-snipe cap)**, enforced in `_update`/`_beforeTokenTransfer`,
  keyed on `_isPairPool(from)` — **only pool→user buys are gated; sells and
  wallet↔wallet transfers are never restricted**:
  - **Launch block** (`block.number == launchBlock`): every pool→user buy reverts
    except the factory's atomic initial buy (the only exempt recipient, launch block only).
  - **Blocks 1–2** (`< restrictionsEndBlock`): non-exempt buyer capped at 5% held
    (`maxWalletBps`) and 5.5% per tx (`maxTxBps`). Over-cap **reverts** (does not clamp).
  - **Block 3+**: all limits lift; plain ERC-20.
  - Reverts surface as the pool's opaque `"TF"` (via `TransferHelper`) — expected, documented.
- **Deliberate property (accepted, documented):** because the cap gates on `from == pool`,
  a buy landing on an intermediate (non-pool) contract that then fans out bypasses the
  per-wallet cap. This is pons's behavior and how legit bundling works — we keep it and
  document it as a known property, not a bug.
- `block.number` here is **contract-visible** (ticks ≈ every 16s on this Arbitrum-Orbit
  chain), so "2 blocks" ≈ 32s. All window math uses contract `block.number`, never RPC height.

### `LaunchFactory.sol`
- `launchToken(TokenParams params, uint256 launchConfigId, uint256 dexId, bytes32 salt) payable returns (address token)`
  — atomic, all-or-nothing:
  1. `require(msg.value == launchFee + initialBuyAmount)` exactly.
  2. CREATE2-deploy `Token` at the address `predictTokenAddress` returns.
  3. Create the Uniswap V3 pool `token/WETH` at `poolFee`, initialize to `initialTick`.
  4. Mint/seed the full supply as a **one-sided** position via the NonfungiblePositionManager.
  5. Transfer the LP-NFT to `Locker.lockPosition(token)`.
  6. Write the immutable `LaunchedToken` provenance record (`exists = true`).
  7. If `initialBuyAmount > 0`: atomic dev buy via the router (recipient = `feeWallet`, or
     launcher if zero; `amountOutMinimum = 0` — a **reviewed** decision: there is no external
     price reference at birth, documented, not slippage protection).
  8. Emit **our own** `TokenLaunched(address indexed token, address indexed deployer, address pool, uint256 launchConfigId, uint256 dexId, uint256 supply, uint256 initialBuyAmount)` (final indexed-ness fixed in implementation; we own this signature).
- Reads/authority: `getLaunchedToken(addr)` is the **authoritative** provenance source
  (never trust a token's self-reported getters); `getLaunchConfig(id)`, `getDexConfig(id)`
  (holds the live V3 factory / position manager / router addresses — DEX addresses are
  **read from config, never hardcoded in Token**), `launchFee()`, `predictTokenAddress(...)`,
  and a single composed `canLaunch(address)` view as the launch gate.
- Fee handling: the `launchFee` is collected to the protocol fee wallet; **pull-payment**
  pattern for any third-party recipient (no push loops).
- Admin: `Ownable2Step`; every privileged function enumerated; money-redirecting or
  DEX-rewiring functions behind a **timelock + multisig**. The locker address is an
  **immutable constructor arg** — a deployed factory can't be repointed at a different locker.

### `Locker.sol`
- `lockPosition(address token) onlyFactory` — receives the LP-NFT in the launch tx.
- **Permanent by construction:** exposes **no withdraw and no arbitrary-call** function.
  Liquidity can never be moved by anyone (no admin rescue hatch — matching pons; maximally
  trustless, and the accepted cost is that a permanent-failure edge case has no recovery).
- The only extractable value is **swap fees**: `collectFees(address token)` (gated by an
  owner-managed `feeCollectors` allow-list) splits collected fees 70/30. Creator share
  redirectable by the deployer via `setFeeRedirect(token, newWallet)`; `protocolFeeShare`
  (≤ `MAX_PROTOCOL_FEE_SHARE = 50`) snapshotted per token at launch. `Ownable2Step`.

### `interfaces/`
Minimal interfaces to the **live** Robinhood-Chain Uniswap V3 deployment (there is one; we
reuse it, we don't redeploy Uniswap):

| Contract | Address (chain 4663, from research §2 — re-verify at build) |
|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| UniswapV3Factory | `0x1F7D7550b1b028f7571E69A784071F0205FD2eFA` |
| NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

No on-chain Quoter exists here — pricing (for the frontend later) reads pool `slot0()`
directly; the contracts themselves need no quoter. The router has two `exactInputSingle`
shapes (with/without `deadline`), selected by `DexConfig.routerRequiresDeadline` (live = false).

## Published interface (into `packages/shared`)

Generated from `contracts/out/*.json` + `broadcast/.../run-latest.json`:
- `packages/shared/abis/*.ts` (`as const`): `LaunchFactory`, `Token`, `Locker`, plus the
  Uniswap V3 `Pool` (`Swap`) and ERC-20 (`Transfer`) fragments B/C index.
- `packages/shared/addresses/{4663,46630}.json`: our deployed factory/locker + the DEX addresses.
- The `TokenLaunched` event signature and the factory read-function ABIs are the A→B and A→C
  contract. B indexes exactly `TokenLaunched` + each emitted pool's `Swap` + `Transfer`; C reads
  live state and signs `launchToken` / router `exactInputSingle` against these ABIs.

## Definition of done (security regimen — this IS the acceptance criteria)

Nothing reaches mainnet until all of this passes and is signed off. Contracts are an
irreversible, unpausable fund custodian.

1. **Fee/value math** as one pure, fuzz-tested `splitValue(msg.value, fee) → (fee, buy)`
   over the full `uint256` range; `msg.value == fee` must not revert, `< fee` must revert;
   audit every `unchecked{}`.
2. **Atomicity** — deploy→pool→seed→lock→(buy) all-or-nothing; tested with a mock DEX that
   reverts at each step. **CREATE2 prediction cross-checked against a static call of the real
   deploy path** in an automated test (a mismatch strands value at a not-yet-deployed address).
3. **Reentrancy guards** on every state-mutating entry point + checks-effects-interactions;
   every externally-supplied address treated as attacker-controlled.
4. **Foundry `invariant_`/fuzz** for the load-bearing properties: supply conservation; the
   cap holding across **every** delivery path (direct pool, router, helper, same-block repeat);
   exemption limited to the launch-block atomic buyer; the lock unmovable by any caller/path.
5. **Access control** — every privileged function enumerated; config snapshotted immutably
   per token; `canLaunch()` the single composed authority.
6. **DoS** — every caller-supplied array bounded before any external call; pull-payments.
7. **Static analysis** — Slither + Mythril to zero unexplained findings.
8. **Mainnet-fork tests** against the real DEX/router/WETH at the live addresses.
9. **A dry-run/simulate suite**, then **testnet (46630)** deployment + rehearsal.
10. **Gate to mainnet:** independent adversarial review → **professional third-party audit**
    → bug bounty → staged, capped rollout with alerting and a rehearsed incident-response plan.
    Hardware-backed, multisig keys from the first mainnet tx.

## To re-verify live at build time (do not trust docs)

- The live Uniswap V3 addresses above (read from chain before embedding in `DexConfig`).
- The chain's EVM version / opcode support (Arbitrum Orbit — confirm the Solidity `evm_version`
  target, e.g. paris vs shanghai, before relying on PUSH0 etc.).
- Contract-visible `block.number` cadence (≈16s) — asserted in a fork test so window math is right.

## Tech

Foundry (Solidity ≥0.8.24, OpenZeppelin), outside the JS workspace graph. Deploy scripts +
`broadcast` artifacts feed the `packages/shared` address/ABI generation. `contracts/` lives in
the launchpad-01 monorepo alongside (later) `indexer/`, `web/`, `packages/shared/`.
