#!/usr/bin/env bash
# Deploys sub-project A to a local (forked) Anvil already running on $RPC_URL,
# via A's own unmodified contracts/script/Deploy.s.sol, then drives:
#   - one zero-dev-buy launch (TOKEN) + one post-restriction-window buy + one
#     wallet transfer + one "drive a holder to zero balance" pair of transfers
#     (via $FOURTH), so the indexer has real, known history to sync against
#     and a genuine phantom zero-balance holders row to exclude.
#   - a second, nonzero-dev-buy launch (TOKEN2) immediately followed, in the
#     SAME block, by a sell against its own pool — exercising the atomic
#     dev-buy path and the same-block pool-balance race LaunchFactory.ts's
#     fix guards against.
# Prints a single JSON line:
# {"factory":"0x..","token":"0x..","pool":"0x..","token2":"0x..","pool2":"0x..","zeroedHolder":"0x.."}
set -euo pipefail
# Foundry (anvil/forge/cast) is NOT on PATH on this machine — see task-10-brief
# REQUIRED CORRECTION 2. Prepend its real location so forge/cast resolve when
# this script is spawned from the Windows vitest process.
export PATH="/c/Users/Ivan/.foundry/bin:${FOUNDRY_BIN:-}:$PATH"

RPC_URL="${RPC_URL:-http://127.0.0.1:8560}"
PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}" # Anvil's well-known default account #0 — local/disposable chain only
SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"        # the address that key controls (Anvil default #0)
RECIPIENT="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"     # Anvil default account #1
FOURTH="0x90F79bf6EB2c4f870365E785982E1f101E93b906"        # Anvil default account #3 — used only as the "drive to zero" holder below
FOURTH_KEY="0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
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
for A in "$SENDER" "$RECIPIENT" "$FOURTH"; do
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

# ---------------------------------------------------------------------------
# Blocker 2 regression fixture: a SECOND launch (TOKEN2) with a NONZERO
# initialBuyAmount — the atomic dev buy path is otherwise never exercised —
# immediately followed, in the SAME block, by a plain SELL of a sliver of
# that dev-buy balance back into TOKEN2's own pool. A sell (to == pairPool)
# is never gated by Token.sol's anti-snipe check (only from == pairPool,
# i.e. buys, are — see `_update`), so it lands cleanly even inside the
# launch block itself, unlike a second buyer trying to buy in that same
# block (which Token.sol's launch-block ban would revert).
#
# This reproduces exactly the shape LaunchFactory.ts's fix guards against:
# its balanceOf(pool2) read is pinned to this block number, so by the time
# it runs it already reflects BOTH the dev buy AND this same-block sell —
# state Token:Transfer hasn't "seen" yet in log order. The old
# onConflictDoUpdate(balance=poolBalance) would overwrite what
# Token:Transfer already built authoritatively from the real logs; when
# the sell's own Transfer(SENDER -> pool2) log is then (re-)applied on top
# of that overwritten value, the delta double-counts — see the code
# comment in LaunchFactory.ts for the full mechanism.
#
# All 3 sends below are from $SENDER at sequential nonces, so plain
# per-account nonce ordering — not gas price / mempool priority — is what
# guarantees the launch lands before the approve before the sell once
# mined together: nonce ordering is a protocol-level invariant every EVM
# client enforces, unlike cross-account mempool ordering.
SALT2=0x0000000000000000000000000000000000000000000000000000000000000002
PARAMS2="(\"Test Token 2\",\"TEST2\",\"ipfs://logo2\",\"a second test token\",(\"\",\"\",\"\",\"\",\"\"),$NO_FEE_WALLET)"
MAX_UINT256=115792089237316195423570985008687907853269984665640564039457584007913129639935

TOKEN2=$(retry cast call "$FACTORY" \
  "predictTokenAddress((string,string,string,string,(string,string,string,string,string),address),uint256,uint256,bytes32,address)(address)" \
  "$PARAMS2" 0 0 "$SALT2" "$SENDER" --rpc-url "$RPC_URL")

# Pin explicit, sequential nonces for the 3-tx batch below rather than
# relying on cast's automatic "pending nonce" lookup per send: with
# automine off, back-to-back sends from the same signer can race that
# lookup (observed in practice as a spurious "replacement transaction
# underpriced", the 2nd/3rd send landing on the SAME nonce as the 1st).
BASE_NONCE=$(retry cast nonce "$SENDER" --rpc-url "$RPC_URL")

retry cast rpc anvil_setAutomine false --rpc-url "$RPC_URL" 1>&2

# nonce BASE_NONCE: launch TOKEN2 with msg.value beyond launchFee => nonzero
# initialBuyAmount => the atomic dev buy fires, to launchBuyer = $SENDER
# (feeWallet is NO_FEE_WALLET in $PARAMS2, same as $PARAMS above).
cast send "$FACTORY" \
  "launchToken((string,string,string,string,(string,string,string,string,string),address),uint256,uint256,bytes32)" \
  "$PARAMS2" 0 0 "$SALT2" \
  --value 550000000000000 --nonce "$BASE_NONCE" --async --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2

# nonce BASE_NONCE+1: approve the router for TOKEN2 — needs an explicit
# --gas-limit because TOKEN2 has no code yet at submission time (the launch
# above is still only pending), so cast's default eth_estimateGas would fail.
cast send "$TOKEN2" "approve(address,uint256)" "$SWAP_ROUTER" "$MAX_UINT256" \
  --gas-limit 100000 --nonce "$((BASE_NONCE + 1))" --async --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2

# nonce BASE_NONCE+2: sell a sliver of the just-bought TOKEN2 back into the
# pool, in the SAME block as the launch — the "later same-block tx that
# touches the pool" the fix is about. amountOutMinimum=0 for the same
# no-external-price-reference reason the contract's own dev buy uses it.
cast send "$SWAP_ROUTER" \
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))" \
  "($TOKEN2,$WETH,10000,$SENDER,1000,0,0)" \
  --gas-limit 500000 --nonce "$((BASE_NONCE + 2))" --async --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2

retry cast rpc anvil_mine 0x1 --rpc-url "$RPC_URL" 1>&2
retry cast rpc anvil_setAutomine true --rpc-url "$RPC_URL" 1>&2

POOL2=$(retry cast call "$UNISWAP_V3_FACTORY" "getPool(address,address,uint24)(address)" "$TOKEN2" "$WETH" 10000 --rpc-url "$RPC_URL")

# ---------------------------------------------------------------------------
# Blocker 1 regression fixture: drive a holder to an EXACT zero balance by
# having it forward its entire balance onward. Token.ts only ever upserts
# `holders` rows (never deletes), so this leaves a real, persisted
# balance=0 row for $FOURTH — exactly the phantom row "/holders" must now
# exclude. Uses a separate wallet ($FOURTH) rather than $RECIPIENT so the
# existing /wallets/:address/holdings assertion for $RECIPIENT's (nonzero)
# TOKEN balance stays untouched.
cast send "$TOKEN" "transfer(address,uint256)" "$FOURTH" 500000000000000000 --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" 1>&2
cast send "$TOKEN" "transfer(address,uint256)" "$SENDER" 500000000000000000 --rpc-url "$RPC_URL" --private-key "$FOURTH_KEY" 1>&2

printf '{"factory":"%s","token":"%s","pool":"%s","token2":"%s","pool2":"%s","zeroedHolder":"%s"}\n' \
  "$FACTORY" "$TOKEN" "$POOL" "$TOKEN2" "$POOL2" "$FOURTH"
