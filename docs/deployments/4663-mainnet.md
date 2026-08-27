# Robinhood Chain mainnet (4663) — deployment record

Deployed **2026-08-27** with `contracts/script/Deploy.s.sol` (unmodified), `forge script … --account deployer --broadcast`.
Foundry keystore `deployer`; password held only by the deployer. Tx→call mapping below is from the on-chain receipts (forge's console labels were shuffled). Total cost 0.000214592678064 ETH (6,102,584 gas @ ~0.035 gwei).

> The Foundry broadcast log (`contracts/broadcast/`, gitignored) is NOT the durable record — this file is.
> `packages/shared/addresses/4663.json` carries the same factory/locker and is what the indexer/web consume.

## Contracts

| Contract | Address | Tx | Block |
|---|---|---|---|
| **Locker** | `0xD00F3223dfCF1063CEa9EbCF911870fdd0AA940D` | `0xe13a28a51aa9862db16e79ab7fbf6fe0c85692eb4a3c818e507d71b085e61efb` | 47146567 |
| **LaunchFactory** | `0x12967ddc45fee0450d5F119E3Af2ca297a1AdBe1` | `0x47b0d4db4c9abfe15f8838f3726f76b6fa1ef6db61f936155aa73db75a664133` | 47146568 |

Indexer: `PONDER_START_BLOCK=47146567`.

## Keys / wallets

| Role | Address | Notes |
|---|---|---|
| Deployer + **owner** of both contracts (`Ownable2Step`) | `0xe9Dfd527Af70434Fcd9507945929593A1E4B7a89` | hot admin key. Ownership handoff to a timelock/multisig is still TODO (`transferOwnership` → `acceptOwnership`). |
| **`PROTOCOL_WALLET`** — treasury | `0x12D9863367397Ab32668A8DFcC3DC87AdeF9A3DC` | receive-only EOA. **Immutable** on `LaunchFactory` (launch fees). Also `Locker.protocolWallet` (30 % swap-fee share, owner-changeable) and the sole `feeCollectors` entry. |

## Wiring transactions (all block 47146568)

| Call | Tx |
|---|---|
| `Locker.setProtocolWallet(0x12D9…A3DC)` | `0x4ee6e4453b62a7928ab3a268314dbf450a628c56fb716ed839041a1a9dd2af36` |
| `Locker.setFeeCollector(0x12D9…A3DC, true)` | `0xc13587f94e341d7ba9118d0bd5782c6663fda09202224139ff81fab9fa6bc7c3` |
| `LaunchFactory.setDexConfig(0, …)` | `0x0febb176166fd4bb34015d0617b464e98ec70c57b3eadedaeeff52e6a5e755a0` |
| `LaunchFactory.setLaunchConfig(0, …)` | `0x4b7e873c69b16fa1a19df929dd6b19656ea40a19eb29d048c5cd803de88a1a00` |

## Live configuration (verified on-chain post-deploy)

- `launchFee` = 0.0005 ETH · `PROTOCOL_FEE_SHARE` = 30 · `launchEnabled` = true · `publicLaunchOpen` = true
- `LaunchConfig(0)`: pairToken WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, graduationThreshold 4.2 ETH (inert), initialTick −204200, supply 1 000 000 000e18, maxWallet 500 bps, maxTx 550 bps, restrictionBlocks 2, routerRequiresDeadline false
- `DexConfig(0)` "robinhood-live-v3": factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, positionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`, swapRouter `0xCaf681a66D020601342297493863E78C959E5cb2`, poolFee 10000, tickSpacing 200

## Status caveats

- Deployed with `docs/security/checklist.md` item 10 (independent audit / bug bounty / staged rollout / multisig keys) **open**, by explicit decision of the owner.
- Source verification on Blockscout (`https://robinhoodchain.blockscout.com`): see the "Verification" section below once done.

## Verification

**Sourcify — verified (exact match, creation + runtime) on 2026-08-27:**
- Locker `0xD00F…940D` — https://sourcify.dev/server/v2/contract/4663/0xD00F3223dfCF1063CEa9EbCF911870fdd0AA940D (matchId 46835668)
- LaunchFactory `0x1296…dBe1` — https://sourcify.dev/server/v2/contract/4663/0x12967ddc45fee0450d5F119E3Af2ca297a1AdBe1 (matchId 46835669)
- Submitted with `forge verify-contract --verifier sourcify --chain-id 4663 <addr> <path:Name> --constructor-args <abi-encoded>`.
- Sourcify forwards to Blockscout automatically; that forward failed with Blockscout's 503 (see below).

**rh-scan.com — shows "unverified" as of 2026-08-27 12:35.** It is a custom Next.js explorer with no submission
route of its own (`/contract-verification` → 404); its front end reads `/api/address/{addr}/contract-verification`
(`{status, sources, matchType: "partial"|…}`) from its own backend, whose upstream (Sourcify and/or Blockscout) and
cache TTL are not visible. Nothing to submit there — re-check after Sourcify/Blockscout propagate.

**Blockscout — LaunchFactory ✅ fully verified (2026-08-27 04:41 UTC, via the REST v2 standard-input route);
Locker ⏳ pending** — Blockscout still had not detected the Locker as a contract (`/api/v2/smart-contracts/… → 404`)
at 13:00 local; resubmit the v2 command below once it appears. Background: both addresses have code on-chain (`cast code` → 4488 / 21028 bytes), but Blockscout
(`/api/v2/addresses/{addr}`) still reported `is_contract: false` and `/api/v2/smart-contracts/{addr}` → 404 well after
the block was indexed — its contract detector lags the block indexer — so every verification route failed
("Address is not a smart-contract", then "Too many requests" from the Etherscan-compatible `/api` shim). Retry once
the address page shows a **Contract** tab. Either route works; compiler `v0.8.24+commit.e11b9ed9`, optimizer on / 200
runs, EVM `paris`, MIT:

```
# Etherscan-compatible shim (forge):
forge verify-contract --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663 \
  0xD00F3223dfCF1063CEa9EbCF911870fdd0AA940D src/Locker.sol:Locker \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" 0x12967ddc45fee0450d5F119E3Af2ca297a1AdBe1 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3 0xe9Dfd527Af70434Fcd9507945929593A1E4B7a89)
forge verify-contract --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api --chain-id 4663 \
  0x12967ddc45fee0450d5F119E3Af2ca297a1AdBe1 src/LaunchFactory.sol:LaunchFactory \
  --constructor-args $(cast abi-encode "constructor(address,address,uint256,address)" 0xe9Dfd527Af70434Fcd9507945929593A1E4B7a89 0xD00F3223dfCF1063CEa9EbCF911870fdd0AA940D 500000000000000 0x12D9863367397Ab32668A8DFcC3DC87AdeF9A3DC)
```

```
# Blockscout REST v2 (standard-JSON; bypasses the shim's rate limit):
forge verify-contract --show-standard-json-input 0xD00F3223dfCF1063CEa9EbCF911870fdd0AA940D src/Locker.sol:Locker > Locker.json
curl -X POST https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0xD00F3223dfCF1063CEa9EbCF911870fdd0AA940D/verification/via/standard-input \
  -F compiler_version=v0.8.24+commit.e11b9ed9 -F license_type=mit -F contract_name=src/Locker.sol:Locker \
  -F autodetect_constructor_args=true -F "files[0]=@Locker.json;type=application/json"
# same for LaunchFactory with src/LaunchFactory.sol:LaunchFactory
```
