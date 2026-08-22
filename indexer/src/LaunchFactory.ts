import { ponder } from "ponder:registry";
import { dexConfigs, holders, launchConfigs, pools, tokens } from "ponder:schema";
import { launchFactoryAbi, tokenAbi } from "@launchpad/shared";
import { buildTokenRow } from "./lib/launch";

ponder.on("LaunchFactory:TokenLaunched", async ({ event, context }) => {
  const { token, deployer, pool, launchConfigId, dexId, supply, initialBuyAmount } = event.args;
  const factoryAddress = context.contracts.LaunchFactory.address;

  // One batched Multicall3 read (digest §2/§3: sequential/Multicall3 over
  // concurrency) for: authoritative provenance (getLaunchedToken — never the
  // token's own self-report), cosmetic metadata (the token's own getters —
  // safe, it's the same contract we just watched being created), the
  // launch config (for the inert graduationThreshold), and a direct
  // balanceOf(pool) read that seeds holders without depending on catching
  // the constructor's own same-tx Transfer log.
  const [launchedToken, name, symbol, decimals, logo, description, socials, launchConfig, poolBalance] =
    await context.client.multicall({
      allowFailure: false,
      contracts: [
        { address: factoryAddress, abi: launchFactoryAbi, functionName: "getLaunchedToken", args: [token] },
        { address: token, abi: tokenAbi, functionName: "name" },
        { address: token, abi: tokenAbi, functionName: "symbol" },
        { address: token, abi: tokenAbi, functionName: "decimals" },
        { address: token, abi: tokenAbi, functionName: "logo" },
        { address: token, abi: tokenAbi, functionName: "description" },
        { address: token, abi: tokenAbi, functionName: "socials" },
        { address: factoryAddress, abi: launchFactoryAbi, functionName: "getLaunchConfig", args: [launchConfigId] },
        { address: token, abi: tokenAbi, functionName: "balanceOf", args: [pool] },
      ],
    });

  const row = buildTokenRow(
    { token, deployer, pool, launchConfigId, dexId, supply, initialBuyAmount },
    launchedToken,
    { name, symbol, decimals, logo, description, socials },
    launchConfig.graduationThreshold,
    poolBalance,
    { blockNumber: event.block.number, blockTimestamp: event.block.timestamp, txHash: event.transaction.hash },
  );

  await context.db.insert(tokens).values(row).onConflictDoNothing();

  await context.db
    .insert(pools)
    .values({
      address: pool,
      tokenAddress: token,
      pairedToken: launchedToken.pairedToken,
      poolFee: launchedToken.poolFee,
      createdBlock: event.block.number,
      createdTxHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  await context.db
    .insert(holders)
    .values({ id: `${token}-${pool}`, tokenAddress: token, holderAddress: pool, balance: poolBalance })
    .onConflictDoUpdate({ balance: poolBalance });
});

ponder.on("LaunchFactory:LaunchConfigSet", async ({ event, context }) => {
  const config = await context.client.readContract({
    abi: launchFactoryAbi,
    address: context.contracts.LaunchFactory.address,
    functionName: "getLaunchConfig",
    args: [event.args.id],
  });
  await context.db
    .insert(launchConfigs)
    .values({ id: event.args.id, ...config })
    .onConflictDoUpdate({ ...config });
});

ponder.on("LaunchFactory:DexConfigSet", async ({ event, context }) => {
  const config = await context.client.readContract({
    abi: launchFactoryAbi,
    address: context.contracts.LaunchFactory.address,
    functionName: "getDexConfig",
    args: [event.args.id],
  });
  await context.db
    .insert(dexConfigs)
    .values({ id: event.args.id, ...config })
    .onConflictDoUpdate({ ...config });
});
