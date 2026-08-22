import { createConfig, factory } from "ponder";
import { parseAbiItem } from "viem";
import { addresses, launchFactoryAbi, tokenAbi, uniswapV3PoolAbi } from "@launchpad/shared";
import { hardenedHttp } from "./src/lib/rpcTransport";

const chainId = Number(process.env.PONDER_CHAIN_ID ?? 4663);
const chainAddresses = addresses[chainId];
if (!chainAddresses) {
  throw new Error(`ponder.config: no packages/shared addresses entry for chain ${chainId}`);
}

const factoryAddress = (process.env.PONDER_FACTORY_ADDRESS ?? chainAddresses.factory) as
  | `0x${string}`
  | undefined;
if (!factoryAddress) {
  throw new Error(
    `ponder.config: LaunchFactory has no address for chain ${chainId}. Deploy ` +
      "contracts/script/Deploy.s.sol and re-run packages/shared/scripts/gen-abis.mjs, " +
      "or set PONDER_FACTORY_ADDRESS for a local Anvil run.",
  );
}

// Our own frozen signature (packages/shared/abis/LaunchFactory.ts) — used here
// only to key the factory-pattern dynamic registrations below.
const TOKEN_LAUNCHED_EVENT = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed deployer, address pool, uint256 launchConfigId, uint256 dexId, uint256 supply, uint256 initialBuyAmount)",
);

const startBlock = Number(process.env.PONDER_START_BLOCK ?? 0);

export default createConfig({
  chains: {
    robinhood: {
      id: chainId,
      rpc: hardenedHttp(process.env.PONDER_RPC_URL ?? "http://127.0.0.1:8545"),
      disableCache: process.env.PONDER_LOCAL_DEV === "1", // local Anvil chains reset — never trust the RPC cache
      pollingInterval: 1_000,
      ethGetLogsBlockRange: 10_000, // digest §2/§3: ~10k blocks is the safe ceiling on this chain's public RPC
    },
  },
  database: process.env.DATABASE_URL
    ? { kind: "postgres", connectionString: process.env.DATABASE_URL }
    : { kind: "pglite", directory: process.env.PONDER_PGLITE_DIR ?? "memory://" },
  contracts: {
    LaunchFactory: {
      abi: launchFactoryAbi,
      chain: "robinhood",
      address: factoryAddress,
      startBlock,
    },
    Pool: {
      abi: uniswapV3PoolAbi,
      chain: "robinhood",
      address: factory({ address: factoryAddress, event: TOKEN_LAUNCHED_EVENT, parameter: "pool" }),
      startBlock,
    },
    Token: {
      abi: tokenAbi,
      chain: "robinhood",
      address: factory({ address: factoryAddress, event: TOKEN_LAUNCHED_EVENT, parameter: "token" }),
      startBlock,
    },
  },
});
