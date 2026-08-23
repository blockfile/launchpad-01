# web

The launchpad frontend: Explore (`/`), Launch (`/create`), Trade (`/token/:address`), and Portfolio (`/portfolio`), wired in `src/App.tsx` under `WagmiProvider` → `QueryClientProvider` → `RainbowKitProvider`, targeting chain 4663 (Robinhood Chain) / 46630 (testnet).

There are two dev modes. Pick the one that matches what you're working on.

## Why is my ETH / Launch not showing?

Short answer: **plain `npm run dev` is browse-only.** It serves Explore and Trade's
read views from fixtures with no chain behind them, so:

- The Launch page shows a calm **"not available on this network"** notice instead of a
  form — there is no deployed `LaunchFactory` for chain 4663 in the committed config
  (`factory` is `null` in `packages/shared/addresses/4663.json` until a real deploy), and
  no `VITE_FACTORY_ADDRESS` override is set. This is expected, not a bug. (It used to
  crash to a blank screen; it no longer does.)
- Trade's buy/sell panel shows the same notice for the same reason.
- Your wallet **"has no ETH"** because it is either on the wrong network, or reading the
  public Robinhood RPC where that account genuinely holds 0. If your wallet is connected
  to a chain the app isn't wired for (anything other than 4663 / 46630), Launch and Trade
  show a **"Wrong network — switch to Robinhood Chain"** banner with a one-click switch.

To actually **Launch / Trade and see a balance**, you need a chain where (a) a factory is
deployed and (b) your wallet holds ETH. The fastest path is a local Anvil fork — spelled
out exactly below.

### Local-dev Launch/Trade in four commands

```bash
# 1. Fork mainnet locally (Foundry is at ~/.foundry/bin, not on PATH here):
export PATH="$PATH:/c/Users/Ivan/.foundry/bin"
anvil --fork-url https://rpc.mainnet.chain.robinhood.com &

# 2. Deploy the contracts to the fork; NOTE the printed LaunchFactory + Locker addresses:
cd contracts
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 3. Run the dev server pointed at the fork, with the printed addresses:
VITE_LOCAL_RPC_URL=http://127.0.0.1:8545 \
VITE_FACTORY_ADDRESS=<printed LaunchFactory address> \
VITE_LOCKER_ADDRESS=<printed Locker address> \
npm run dev -w web
```

**4. In MetaMask:** add a network with **Chain ID `4663`** and **RPC URL
`http://127.0.0.1:8545`**, then import an Anvil default account (e.g. private key
`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`, which holds 10000
ETH on the fork). Connect it via the header's Connect button. Launch and Trade now show
real forms wired to your fork, and your balance shows the fork's ETH.

The full mechanics of each step (why the addresses flow via env vars, how to read them
back, the automated test harness) are in **Local-Anvil write-flow mode** below.

## Install

Install once from the repo root (npm workspaces — this installs every package):

```bash
npm install
```

## Mocked-B mode (default)

From the repo root, or scoped to the `web` workspace:

```bash
npm run dev          # root convenience script
npm run dev -w web   # or target the web workspace directly
```

The same pattern applies to the other scripts: `npm run build` / `npm run build -w web`, and `npm test` / `npm run test -w web`.

Every list/chart/trade/holder view runs against the MSW fixtures under `src/lib/indexer/fixtures/` (the same fixtures the test suite uses). No chain and no wallet connection are required to browse Explore or Trade's read-only surfaces — B (the indexer) is entirely faked. This is the default because it's what almost every UI change should be checked against first: it's instant, has no external dependencies, and is the mode `npm test` runs in.

This mode is **browse-only**: Explore/Trade read views work against fixtures, but there is
no chain behind them, so Launch and Trade's write surfaces render a "not available on this
network" notice (no factory is configured for chain 4663 here — see [Why is my ETH / Launch
not showing?](#why-is-my-eth--launch-not-showing) above), and wallet balances are whatever
the public RPC reports. Actually **writing** — launching a token, or swapping — and seeing a
funded balance both need the second mode below.

## Local-Anvil write-flow mode

This is how to click through the real write paths (Launch → deploy, Trade → buy/sell) against a local fork, with a real wallet.

**1. Stand up the fork and deploy the contracts** (Foundry lives at `~/.foundry/bin`, not on `PATH`, on this machine — adjust if yours differs):

```bash
export PATH="$PATH:$HOME/.foundry/bin"
anvil --fork-url https://rpc.mainnet.chain.robinhood.com &
cd contracts
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Copy the printed `LaunchFactory` and `Locker` addresses from forge's `== Return ==` output (or read them back out of `contracts/broadcast/Deploy.s.sol/4663/run-latest.json`).

This local deploy's addresses are **not** written back into `packages/shared/addresses/4663.json` — that file stays the record of the *real* deploy. The local addresses flow in only via env vars (`FACTORY_ADDRESS`/`VITE_FACTORY_ADDRESS`, resolved by `src/lib/contracts.ts`'s `resolveAddress`), so nothing here risks clobbering the committed address file.

**2. Run the automated write-flow suite against it** (Tasks 9 + 12: launch → predicted address → decoded `TokenLaunched` → `slot0` quote → real buy → real sell), from `web/`:

```bash
FACTORY_ADDRESS=<printed LaunchFactory address> ANVIL_RPC_URL=http://127.0.0.1:8545 npm run test:anvil -w web
```

(Left unset, `test:anvil` spins up and tears down its own throwaway fork + deploy automatically via `src/test/anvil/globalSetup.ts` — the `FACTORY_ADDRESS`/`ANVIL_RPC_URL` pair above is only for pointing it at a fork you're already running yourself, e.g. so you can inspect it afterward.)

**3. Point the dev server itself — not just the tests — at the same fork**, so you can click through the app in a real browser:

```bash
VITE_LOCAL_RPC_URL=http://127.0.0.1:8545 \
VITE_FACTORY_ADDRESS=<printed LaunchFactory address> \
VITE_LOCKER_ADDRESS=<printed Locker address> \
npm run dev -w web
```

`VITE_LOCAL_RPC_URL` overrides chain 4663's transport (`src/lib/wagmi.ts`) so wagmi talks to your local fork instead of the real RPC; `VITE_FACTORY_ADDRESS`/`VITE_LOCKER_ADDRESS` override the committed addresses the same way the test suite's `FACTORY_ADDRESS` env var does.

**4. Connect a wallet.** Import Anvil's default account #0 private key (`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`) into MetaMask (or any wallet RainbowKit supports), add a custom network pointed at `http://127.0.0.1:8545` with chain ID `4663`, and connect it via the header's Connect button. From there, Launch/Trade's write flows (launch a token, buy, sell) execute for real against your fork.
