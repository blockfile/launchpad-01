import { index, onchainTable } from "ponder";

export const tokens = onchainTable(
  "tokens",
  (t) => ({
    address: t.hex().primaryKey(),
    deployer: t.hex().notNull(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    decimals: t.integer().notNull(),
    logo: t.text().notNull(),
    description: t.text().notNull(),
    socials: t
      .json()
      .$type<{ twitter: string; telegram: string; discord: string; website: string; farcaster: string }>()
      .notNull(),
    poolAddress: t.hex().notNull(),
    pairedToken: t.hex().notNull(),
    isToken0: t.boolean().notNull(),
    poolFee: t.integer().notNull(),
    launchConfigId: t.bigint().notNull(),
    dexId: t.bigint().notNull(),
    supply: t.bigint().notNull(),
    initialBuyAmount: t.bigint().notNull(),
    restrictionsEndBlock: t.bigint().notNull(),
    graduationThreshold: t.bigint().notNull(), // carried for parity with LaunchConfig — inert in v1
    launchBlock: t.bigint().notNull(),
    launchTimestamp: t.bigint().notNull(),
    launchTxHash: t.hex().notNull(),
    lastPrice18: t.bigint(),
    lastTradeAt: t.bigint(),
    holderCount: t.integer().notNull(),
  }),
  (table) => ({
    deployerIdx: index().on(table.deployer),
    symbolIdx: index().on(table.symbol),
    launchTimestampIdx: index().on(table.launchTimestamp),
  }),
);

export const pools = onchainTable(
  "pools",
  (t) => ({
    address: t.hex().primaryKey(),
    tokenAddress: t.hex().notNull(),
    pairedToken: t.hex().notNull(),
    poolFee: t.integer().notNull(),
    createdBlock: t.bigint().notNull(),
    createdTxHash: t.hex().notNull(),
  }),
  (table) => ({ tokenAddressIdx: index().on(table.tokenAddress) }),
);

export const trades = onchainTable(
  "trades",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    tokenAddress: t.hex().notNull(),
    poolAddress: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    side: t.text().$type<"buy" | "sell">().notNull(),
    traderAddress: t.hex().notNull(),
    tokenAmountRaw: t.bigint().notNull(),
    quoteAmountRaw: t.bigint().notNull(),
    price18: t.bigint().notNull(),
  }),
  (table) => ({
    tokenAddressIdx: index().on(table.tokenAddress),
    blockTimestampIdx: index().on(table.blockTimestamp),
  }),
);

export const candles = onchainTable(
  "candles",
  (t) => ({
    id: t.text().primaryKey(), // `${tokenAddress}-${interval}-${bucketStart}`
    tokenAddress: t.hex().notNull(),
    interval: t.text().$type<"1m" | "5m" | "1h" | "1d">().notNull(),
    bucketStart: t.bigint().notNull(),
    open: t.bigint().notNull(),
    high: t.bigint().notNull(),
    low: t.bigint().notNull(),
    close: t.bigint().notNull(),
    volumeToken: t.bigint().notNull(),
    volumeQuote: t.bigint().notNull(),
    tradeCount: t.integer().notNull(),
  }),
  (table) => ({
    tokenIntervalBucketIdx: index().on(table.tokenAddress, table.interval, table.bucketStart),
  }),
);

export const holders = onchainTable(
  "holders",
  (t) => ({
    id: t.text().primaryKey(), // `${tokenAddress}-${holderAddress}`
    tokenAddress: t.hex().notNull(),
    holderAddress: t.hex().notNull(),
    balance: t.bigint().notNull(),
  }),
  (table) => ({ tokenBalanceIdx: index().on(table.tokenAddress, table.balance) }),
);

export const launchConfigs = onchainTable("launch_configs", (t) => ({
  id: t.bigint().primaryKey(),
  pairToken: t.hex().notNull(),
  graduationThreshold: t.bigint().notNull(),
  initialTick: t.integer().notNull(),
  supply: t.bigint().notNull(),
  maxWalletBps: t.integer().notNull(),
  maxTxBps: t.integer().notNull(),
  // Solidity emits this as uint32; t.integer() is Postgres int4 (max ~2.1B), so
  // a restrictionBlocks value > 2^31-1 would overflow on insert. Practically
  // unreachable (a >2.1B-block anti-snipe window is millennia-scale), so no
  // schema change — noted only so a future widening of this field is on record.
  restrictionBlocks: t.integer().notNull(),
  reservedFee: t.integer().notNull(),
  enabled: t.boolean().notNull(),
  routerRequiresDeadline: t.boolean().notNull(),
}));

export const dexConfigs = onchainTable("dex_configs", (t) => ({
  id: t.bigint().primaryKey(),
  name: t.text().notNull(),
  factory: t.hex().notNull(),
  positionManager: t.hex().notNull(),
  swapRouter: t.hex().notNull(),
  poolFee: t.integer().notNull(),
  tickSpacing: t.integer().notNull(),
  enabled: t.boolean().notNull(),
}));
