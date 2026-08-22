export interface TokenLaunchedArgs {
  token: `0x${string}`;
  deployer: `0x${string}`;
  pool: `0x${string}`;
  launchConfigId: bigint;
  dexId: bigint;
  supply: bigint;
  initialBuyAmount: bigint;
}

export interface LaunchedTokenRecord {
  pairedToken: `0x${string}`;
  isToken0: boolean;
  poolFee: number;
  restrictionsEndBlock: bigint;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logo: string;
  description: string;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
}

export interface LaunchBlockInfo {
  blockNumber: bigint;
  blockTimestamp: bigint;
  txHash: `0x${string}`;
}

/** Pure mapping from an already-fetched TokenLaunched event + getLaunchedToken
 * record + token metadata into the `tokens` insert row. Kept separate from the
 * `ponder.on` handler so the mapping is fixture-testable without a live chain
 * or database. `poolBalance` seeds `holderCount` from a direct `balanceOf`
 * read rather than depending on catching the constructor's own same-tx
 * Transfer log (see spec "Known limitation, accepted"). */
export function buildTokenRow(
  args: TokenLaunchedArgs,
  launchedToken: LaunchedTokenRecord,
  metadata: TokenMetadata,
  graduationThreshold: bigint,
  poolBalance: bigint,
  block: LaunchBlockInfo,
) {
  return {
    address: args.token,
    deployer: args.deployer,
    name: metadata.name,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
    logo: metadata.logo,
    description: metadata.description,
    socials: metadata.socials,
    poolAddress: args.pool,
    pairedToken: launchedToken.pairedToken,
    isToken0: launchedToken.isToken0,
    poolFee: launchedToken.poolFee,
    launchConfigId: args.launchConfigId,
    dexId: args.dexId,
    supply: args.supply,
    initialBuyAmount: args.initialBuyAmount,
    restrictionsEndBlock: launchedToken.restrictionsEndBlock,
    graduationThreshold,
    launchBlock: block.blockNumber,
    launchTimestamp: block.blockTimestamp,
    launchTxHash: block.txHash,
    lastPrice18: null,
    lastTradeAt: null,
    holderCount: poolBalance > 0n ? 1 : 0,
  };
}
