import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../ponder.schema";

describe("ponder.schema", () => {
  it("defines all seven tables", () => {
    for (const name of ["tokens", "pools", "trades", "candles", "holders", "launchConfigs", "dexConfigs"]) {
      expect(schema).toHaveProperty(name);
    }
  });

  it("tokens has every column the TokenLaunched handler writes", () => {
    const columns = Object.keys(getTableColumns(schema.tokens));
    expect(columns).toEqual(
      expect.arrayContaining([
        "address", "deployer", "name", "symbol", "decimals", "logo", "description",
        "socials", "poolAddress", "pairedToken", "isToken0", "poolFee",
        "launchConfigId", "dexId", "supply", "initialBuyAmount",
        "restrictionsEndBlock", "graduationThreshold", "launchBlock",
        "launchTimestamp", "launchTxHash", "lastPrice18", "lastTradeAt", "holderCount",
      ]),
    );
  });

  it("tokens.address is the primary key", () => {
    expect(getTableColumns(schema.tokens).address.primary).toBe(true);
  });

  it("trades.id (tx hash + log index) is the primary key", () => {
    expect(getTableColumns(schema.trades).id.primary).toBe(true);
  });

  it("candles has OHLCV + bucket columns", () => {
    const columns = Object.keys(getTableColumns(schema.candles));
    expect(columns).toEqual(
      expect.arrayContaining([
        "id", "tokenAddress", "interval", "bucketStart",
        "open", "high", "low", "close", "volumeToken", "volumeQuote", "tradeCount",
      ]),
    );
  });

  it("holders.balance exists and is required", () => {
    const balance = getTableColumns(schema.holders).balance;
    expect(balance).toBeDefined();
    expect(balance.notNull).toBe(true);
  });
});
