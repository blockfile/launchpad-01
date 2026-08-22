import { beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  parseEventLogs,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { launchFactoryAbi, tokenAbi, uniswapV3PoolAbi } from "@launchpad/shared";
import { buildBuyCall, buildSellCall } from "../../lib/swap";
import { spotAmountOut, applySlippage } from "../../lib/quote";
import { resolveAddress } from "../../lib/contracts";

// The globalSetup fork deploys A's LaunchFactory and populates these; without
// them (no Foundry / SKIP_ANVIL / CI) the whole suite skips cleanly.
const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const FACTORY = process.env.FACTORY_ADDRESS as `0x${string}`;

// Anvil default account #0 — reset from its EIP-7702 sweeper delegation by the
// globalSetup; it is the deployer/launcher here.
const LAUNCHER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Anvil default account #1 — a *non*-launchBuyer trader. Still EIP-7702-
// delegated to the sweeper on this fork, so we reset it ourselves below
// (setCode 0x + setBalance) before sending it any native value; otherwise the
// `value` we send with the buy would be swept out mid-transaction.
const TRADER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// A CREATE2 salt distinct from launch.anvil.test.ts's (both files share the one
// fork the globalSetup spins up — a colliding salt+initcode would revert the
// second deploy).
const SALT = "0x00000000000000000000000000000000000000000000000000000000deadbeef" as `0x${string}`;

describe.skipIf(!FACTORY)("swap write flow against a local Anvil fork", () => {
  const launcher = privateKeyToAccount(LAUNCHER_KEY);
  const trader = privateKeyToAccount(TRADER_KEY);

  const publicClient = createPublicClient({ transport: http(RPC) });
  const testClient = createTestClient({ mode: "anvil", transport: http(RPC) });
  const launcherWallet = createWalletClient({ account: launcher, transport: http(RPC) });
  const traderWallet = createWalletClient({ account: trader, transport: http(RPC) });

  const router = resolveAddress(4663, "swapRouter");
  const weth = resolveAddress(4663, "weth");

  let token: `0x${string}`;
  let pool: `0x${string}`;
  let isToken0: boolean;
  let poolFee: number;

  const readTokenBalance = (owner: Address) =>
    publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [owner] });

  const readSqrtPrice = async (): Promise<bigint> => {
    const slot0 = (await publicClient.readContract({
      address: pool,
      abi: uniswapV3PoolAbi,
      functionName: "slot0",
    })) as readonly [bigint, ...unknown[]];
    return slot0[0];
  };

  beforeAll(async () => {
    // Reset the trader from its EIP-7702 sweeper delegation and fund it, so the
    // native value we send with the buy is NOT swept.
    await testClient.setCode({ address: trader.address, bytecode: "0x" });
    await testClient.setBalance({ address: trader.address, value: parseEther("100") });

    const params = {
      name: "Swap Token",
      symbol: "SWAP",
      logo: "ipfs://swap",
      description: "swap-flow fixture",
      socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
      // launchBuyer = the launcher (#0), NOT the trader — so the trader's buys
      // are a genuine third-party path, gated by the anti-snipe window (which
      // we mine past below), never the launchBuyer exemption.
      feeWallet: launcher.address,
    };

    const launchFee = (await publicClient.readContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: "launchFee",
    })) as bigint;

    const launchHash = await launcherWallet.writeContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: "launchToken",
      args: [params, 0n, 0n, SALT],
      value: launchFee, // exactly the fee ⇒ no dev buy; pool seeded one-sided
      chain: null,
    });
    const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchHash });
    const [launched] = parseEventLogs({
      abi: launchFactoryAbi,
      eventName: "TokenLaunched",
      logs: launchReceipt.logs,
    });
    token = launched.args.token as `0x${string}`;

    const record = (await publicClient.readContract({
      address: FACTORY,
      abi: launchFactoryAbi,
      functionName: "getLaunchedToken",
      args: [token],
    })) as { isToken0: boolean; poolFee: number; pairedToken: `0x${string}` };
    isToken0 = record.isToken0;
    poolFee = Number(record.poolFee);
    expect(record.pairedToken.toLowerCase()).toBe(weth.toLowerCase());

    pool = (await publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "pairPool",
    })) as `0x${string}`;

    // Clear the anti-snipe restriction window (RESTRICTION_BLOCKS = 2). A
    // handful of real mined blocks pushes block.number past restrictionsEndBlock.
    await testClient.mine({ blocks: 5 });
  }, 120_000);

  it("BUY: native-value exactInputSingle increases the buyer's token balance", async () => {
    const amountIn = parseEther("0.02");
    const estimate = spotAmountOut({
      sqrtPriceX96: await readSqrtPrice(),
      isToken0,
      tokenInIsPaired: true,
      amountIn,
      poolFeePpm: poolFee,
    });
    // A REAL, non-zero min-out. 50% tolerance keeps the test robust against the
    // one-sided pool's price impact + tick rounding while still proving the
    // floor is never zero.
    const minAmountOut = applySlippage(estimate, 5_000);
    expect(minAmountOut).toBeGreaterThan(0n);

    const before = await readTokenBalance(trader.address);
    const call = buildBuyCall({
      router,
      weth,
      token,
      poolFee,
      recipient: trader.address,
      amountIn,
      minAmountOut,
    });
    // Pre-flight the buy so a revert surfaces its actual reason (the raw
    // receipt only reports "reverted"). The real write + on-chain balance
    // assertion below is still the load-bearing proof.
    await publicClient.simulateContract({ ...call, account: trader } as never);
    const hash = await traderWallet.writeContract({ ...call, account: trader, chain: null });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    const after = await readTokenBalance(trader.address);
    expect(after).toBeGreaterThan(before);
  }, 120_000);

  it("SELL: approve-exact + multicall unwraps WETH, increasing the seller's native ETH net of gas", async () => {
    const amountIn = await readTokenBalance(trader.address); // sell everything just bought
    expect(amountIn).toBeGreaterThan(0n);

    // No standing allowance: approve the EXACT amountIn to the router.
    const approveHash = await traderWallet.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "approve",
      args: [router, amountIn],
      account: trader,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const estimate = spotAmountOut({
      sqrtPriceX96: await readSqrtPrice(),
      isToken0,
      tokenInIsPaired: false,
      amountIn,
      poolFeePpm: poolFee,
    });
    const minAmountOut = applySlippage(estimate, 5_000);
    expect(minAmountOut).toBeGreaterThan(0n);

    const call = buildSellCall({
      router,
      weth,
      token,
      poolFee,
      seller: trader.address,
      amountIn,
      minAmountOut,
    });

    // Snapshot native balance AFTER the approve (so its gas isn't attributed to
    // the sell), then measure the sell's own gas back out.
    const ethBefore = await publicClient.getBalance({ address: trader.address });
    const hash = await traderWallet.writeContract({ ...call, account: trader, chain: null });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    const sellGas = receipt.gasUsed * receipt.effectiveGasPrice;
    const ethAfter = await publicClient.getBalance({ address: trader.address });

    // Native ETH delivered by unwrapWETH9, net of the sell's gas.
    const proceedsNetOfGas = ethAfter - ethBefore + sellGas;
    expect(proceedsNetOfGas).toBeGreaterThan(0n);

    // The tokens were actually spent.
    expect(await readTokenBalance(trader.address)).toBeLessThan(amountIn);
  }, 120_000);
});
