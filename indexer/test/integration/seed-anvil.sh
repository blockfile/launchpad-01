#!/usr/bin/env bash
# Deploys sub-project A to a local (forked) Anvil already running on $RPC_URL,
# via A's own unmodified contracts/script/Deploy.s.sol, then drives one
# launch + one buy (post-restriction-window) + one wallet transfer so the
# indexer has real, known history to sync against. Prints a single JSON line:
# {"factory":"0x..","token":"0x..","pool":"0x.."}
set -euo pipefail
# Foundry (anvil/forge/cast) is NOT on PATH on this machine — see task-10-brief
# REQUIRED CORRECTION 2. Prepend its real location so forge/cast resolve when
# this script is spawned from the Windows vitest process.
export PATH="/c/Users/Ivan/.foundry/bin:${FOUNDRY_BIN:-}:$PATH"

RPC_URL="${RPC_URL:-http://127.0.0.1:8560}"
PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}" # Anvil's well-known default account #0 — local/disposable chain only
SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"        # the address that key controls (Anvil default #0)
RECIPIENT="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"     # Anvil default account #1
WETH="0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
SWAP_ROUTER="0xCaf681a66D020601342297493863E78C959E5cb2"
UNISWAP_V3_FACTORY="0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"
CONTRACTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../contracts" && pwd)"

# The public fork RPC is documented flaky (spurious -32601 / rate limits); Anvil
# lazily fetches live DEX state from it while executing these calls, so a call
# can transiently fail even though it targets the LOCAL node. Retry the
# read-only calls and the (fresh-redeploy-idempotent) deploy script. The three
# state-mutating sends below are intentionally single-shot: a blind resend of an
# already-included launch/swap/transfer would either double-execute or revert on
# the duplicate, so those fail loudly instead — the test's own Anvil bring-up
# retry is the recovery path for a genuinely unreachable RPC.
retry() {
  local n=0 max="${RETRY_MAX:-5}" delay="${RETRY_DELAY:-3}"
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge "$max" ]; then
      echo "seed-anvil: command failed after ${max} attempts: $*" >&2
      return 1
    fi
    echo "seed-anvil: attempt ${n} failed, retrying in ${delay}s: $*" >&2
    sleep "$delay"
  done
}

# --- Reset the dev accounts we use to plain, well-funded EOAs. -------------
# The public Robinhood fork's state has Anvil's well-known dev accounts (#0 =
# $SENDER, #1 = $RECIPIENT) EIP-7702-delegated to a sweeper contract (their
# forked code is the `0xef0100…` delegation indicator). Because $SENDER is the
# deployer — and therefore Deploy.s.sol's `protocolWallet` — the launch's
# `protocolWallet.call{value: launchFee}` would execute that delegate on
# receipt and instantly sweep $SENDER's entire (Anvil-funded) balance away,
# leaving nothing for the subsequent WETH deposit / swap. That is a fork
# artifact (our test addresses collide with real, delegated on-chain accounts),
# NOT a contract defect — a real deploy's protocolWallet is a normal wallet.
# Clearing the delegation code makes them behave as the plain, 10000-ETH dev
# EOAs this seed assumes.
BAL=$(cast to-hex 10000000000000000000000) # 10000 ETH
for A in "$SENDER" "$RECIPIENT"; do
  retry cast rpc anvil_setCode "$A" 0x --rpc-url "$RPC_URL" 1>&2
  retry cast rpc anvil_setBalance "$A" "$BAL" --rpc-url "$RPC_URL" 1>&2
done

cd "$CONTRACTS_DIR"
retry forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --private-key "$PRIVATE_KEY" 1>&2

FACTORY=$(node -e "
  const run = JSON.parse(require('fs').readFileSync('broadcast/Deploy.s.sol/4663/run-latest.json', 'utf8'));
  const tx = run.transactions.find((t) => t.transactionType === 'CREATE' && t.contractName === 'LaunchFactory');
  process.stdout.write(tx.contractAddress);
")

SALT=0x0000000000000000000000000000000000000000000000000000000000000001
NO_FEE_WALLET=0x0000000000000000000000000000000000000000
PARAMS="(\"Test Token\",\"TEST\",\"ipfs://logo\",\"a test token\",(\"\",\"\",\"\",\"\",\"\"),$NO_FEE_WALLET)"

TOKEN=$(retry cast call "$FACTORY" \
  "predictTokenAddress((string,string,string,string,(string,string,string,string,string),address),uint256,uint256,bytes32,address)(address)" \
  "$PARAMS" 0 0 "$SALT" "$SENDER" --rpc-url "$RPC_URL")

# msg.value == launchFee (0.0005 ether) exactly => initialBuyAmount == 0: a
# deterministic launch with no atomic dev buy (keeps the capstone's holder/trade
# history exactly: pool seed + one explicit buy + one transfer).
cast send "$FACTORY" \
  "launchToken((string,string,string,string,(string,string,string,string,string),address),uint256,uint256,bytes32)" \
  "$PARAMS" 0 0 "$SALT" \
  --value 500000000000000 --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2

POOL=$(retry cast call "$UNISWAP_V3_FACTORY" "getPool(address,address,uint24)(address)" "$TOKEN" "$WETH" 10000 --rpc-url "$RPC_URL")

# Clear the 2-block anti-snipe restriction window — see Step 2's header note.
retry cast rpc anvil_mine 0x3 --rpc-url "$RPC_URL" 1>&2

# Wrap 1 ETH, approve the router, buy some of the token (now unrestricted).
cast send "$WETH" "deposit()" --value 1000000000000000000 --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2
cast send "$WETH" "approve(address,uint256)" "$SWAP_ROUTER" 1000000000000000000 --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2
cast send "$SWAP_ROUTER" \
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" \
  "($WETH,$TOKEN,10000,$SENDER,1000000000000000000,0,0)" \
  --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2

# A plain wallet-to-wallet transfer, to exercise holders beyond launch/swap.
cast send "$TOKEN" "transfer(address,uint256)" "$RECIPIENT" 1000000000000000000 --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2

printf '{"factory":"%s","token":"%s","pool":"%s"}\n' "$FACTORY" "$TOKEN" "$POOL"
