import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addresses,
  erc20Abi,
  launchFactoryAbi,
  lockerAbi,
  tokenAbi,
  uniswapV3PoolAbi,
} from "../src/index.ts";

test("launchFactoryAbi contains the TokenLaunched event", () => {
  const event = launchFactoryAbi.find((entry) => entry.type === "event" && entry.name === "TokenLaunched");
  assert.ok(event, "expected launchFactoryAbi to contain a TokenLaunched event");
});

test("launchFactoryAbi contains the launchToken function", () => {
  const fn = launchFactoryAbi.find((entry) => entry.type === "function" && entry.name === "launchToken");
  assert.ok(fn, "expected launchFactoryAbi to contain a launchToken function");
});

test("tokenAbi exists and is non-empty", () => {
  assert.ok(Array.isArray(tokenAbi));
  assert.ok(tokenAbi.length > 0, "expected tokenAbi to have at least one entry");
});

test("lockerAbi exists and is non-empty", () => {
  assert.ok(Array.isArray(lockerAbi));
  assert.ok(lockerAbi.length > 0, "expected lockerAbi to have at least one entry");
});

test("uniswapV3PoolAbi contains the Swap event", () => {
  const event = uniswapV3PoolAbi.find((entry) => entry.type === "event" && entry.name === "Swap");
  assert.ok(event, "expected uniswapV3PoolAbi to contain a Swap event");
});

test("erc20Abi contains the Transfer event", () => {
  const event = erc20Abi.find((entry) => entry.type === "event" && entry.name === "Transfer");
  assert.ok(event, "expected erc20Abi to contain a Transfer event");
});

test("addresses map has chain 4663 with the DEX addresses filled", () => {
  const chain = addresses[4663];
  assert.ok(chain, "expected addresses[4663] to exist");
  assert.equal(chain.weth, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
  assert.equal(chain.uniswapV3Factory, "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA");
  assert.equal(chain.positionManager, "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3");
  assert.equal(chain.swapRouter, "0xCaf681a66D020601342297493863E78C959E5cb2");
  // Not deployed yet — no broadcast log exists.
  assert.equal(chain.factory, null);
  assert.equal(chain.locker, null);
});

test("addresses map has chain 46630 (testnet)", () => {
  const chain = addresses[46630];
  assert.ok(chain, "expected addresses[46630] to exist");
  assert.equal(chain.weth, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
});
