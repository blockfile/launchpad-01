import { http } from "wagmi";
import { defineChain } from "viem";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  testnet: true,
});

const localAnvilRpc = import.meta.env.VITE_LOCAL_RPC_URL as string | undefined;

// `getDefaultConfig` (RainbowKit) already builds and returns wagmi's
// `createConfig` result (connectors, chains, transports, client), so it's
// the only config constructor needed here — no separate `createConfig` call.
export const wagmiConfig = getDefaultConfig({
  appName: "Launchpad",
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "dev-placeholder",
  chains: [robinhoodChain, robinhoodTestnet],
  transports: {
    [robinhoodChain.id]: http(localAnvilRpc ?? robinhoodChain.rpcUrls.default.http[0]),
    [robinhoodTestnet.id]: http(robinhoodTestnet.rpcUrls.default.http[0]),
  },
});
