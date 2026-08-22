# web

The launchpad frontend: Explore (`/`), Launch (`/create`), Trade (`/token/:address`), and Portfolio (`/portfolio`), wired in `src/App.tsx` under `WagmiProvider` → `QueryClientProvider` → `RainbowKitProvider`, targeting chain 4663 (Robinhood Chain) / 46630 (testnet).

There are two dev modes. Pick the one that matches what you're working on.

## Mocked-B mode (default)

```bash
pnpm --filter web dev
```

Every list/chart/trade/holder view runs against the MSW fixtures under `src/lib/indexer/fixtures/` (the same fixtures the test suite uses). No chain and no wallet connection are required to browse Explore or Trade's read-only surfaces — B (the indexer) is entirely faked. This is the default because it's what almost every UI change should be checked against first: it's instant, has no external dependencies, and is the mode `pnpm --filter web test` runs in.

Wallet-gated actions (Launch's submit button, Trade's buy/sell panel, Portfolio when disconnected) will still show correctly-disabled states, but actually **writing** — launching a token, or swapping — needs the second mode below, since there's no real chain behind the mocked reads.

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
FACTORY_ADDRESS=<printed LaunchFactory address> ANVIL_RPC_URL=http://127.0.0.1:8545 pnpm --filter web run test:anvil
```

(Left unset, `test:anvil` spins up and tears down its own throwaway fork + deploy automatically via `src/test/anvil/globalSetup.ts` — the `FACTORY_ADDRESS`/`ANVIL_RPC_URL` pair above is only for pointing it at a fork you're already running yourself, e.g. so you can inspect it afterward.)

**3. Point the dev server itself — not just the tests — at the same fork**, so you can click through the app in a real browser:

```bash
VITE_LOCAL_RPC_URL=http://127.0.0.1:8545 \
VITE_FACTORY_ADDRESS=<printed LaunchFactory address> \
VITE_LOCKER_ADDRESS=<printed Locker address> \
pnpm --filter web dev
```

`VITE_LOCAL_RPC_URL` overrides chain 4663's transport (`src/lib/wagmi.ts`) so wagmi talks to your local fork instead of the real RPC; `VITE_FACTORY_ADDRESS`/`VITE_LOCKER_ADDRESS` override the committed addresses the same way the test suite's `FACTORY_ADDRESS` env var does.

**4. Connect a wallet.** Import Anvil's default account #0 private key (`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`) into MetaMask (or any wallet RainbowKit supports), add a custom network pointed at `http://127.0.0.1:8545` with chain ID `4663`, and connect it via the header's Connect button. From there, Launch/Trade's write flows (launch a token, buy, sell) execute for real against your fork.
