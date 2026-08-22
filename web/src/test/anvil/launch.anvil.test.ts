import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { launchFactoryAbi } from "@launchpad/shared";

const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const FACTORY = process.env.FACTORY_ADDRESS as `0x${string}`;
const ANVIL_DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe.skipIf(!FACTORY)("launchToken against a local Anvil fork", () => {
  it("launches a token and the decoded event's token matches predictTokenAddress", async () => {
    const account = privateKeyToAccount(ANVIL_DEFAULT_KEY);
    const publicClient = createPublicClient({ transport: http(RPC) });
    const walletClient = createWalletClient({ account, transport: http(RPC) });

    const params = {
      name: "Test Token",
      symbol: "TEST",
      logo: "ipfs://test",
      description: "d",
      socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
      feeWallet: account.address,
    };
    const salt = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
    const predicted = await publicClient.readContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: "predictTokenAddress",
      args: [params, 0n, 0n, salt, account.address],
    });
    const launchFee = await publicClient.readContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: "launchFee",
    });

    const hash = await walletClient.writeContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: "launchToken",
      args: [params, 0n, 0n, salt],
      value: launchFee,
      chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [event] = parseEventLogs({ abi: launchFactoryAbi, eventName: "TokenLaunched", logs: receipt.logs });
    expect(event.args.token).toBe(predicted);
  });
});
