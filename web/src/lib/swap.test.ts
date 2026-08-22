import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { swapRouter02Abi } from "@launchpad/shared";
import { buildBuyCall, buildSellCall } from "./swap";

const ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2" as const;
const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const USER = "0x2222222222222222222222222222222222222222" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

// The two exactInputSingle overloads carry distinct 4-byte selectors. The live
// router (Deploy.s.sol, routerRequiresDeadline=false) uses the NO-deadline one.
const NO_DEADLINE_SELECTOR = "0x04e45aaf";
const WITH_DEADLINE_SELECTOR = "0x414bf389";

// Decodes one multicall sub-call back into its exactInputSingle params, against
// the FULL router ABI (both overloads present). `decodeFunctionData` picks the
// overload by selector, so this simultaneously proves the recipient AND that
// the no-deadline shape was the one encoded.
function decodeExactInputSingle(data: `0x${string}`) {
  const decoded = decodeFunctionData({ abi: swapRouter02Abi, data });
  if (decoded.functionName !== "exactInputSingle") {
    throw new Error(`expected exactInputSingle, got ${decoded.functionName}`);
  }
  return decoded.args[0] as {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    fee: number;
    recipient: `0x${string}`;
    amountIn: bigint;
    amountOutMinimum: bigint;
    sqrtPriceLimitX96: bigint;
  };
}

function decodeUnwrapWETH9(data: `0x${string}`) {
  const decoded = decodeFunctionData({ abi: swapRouter02Abi, data });
  if (decoded.functionName !== "unwrapWETH9") {
    throw new Error(`expected unwrapWETH9, got ${decoded.functionName}`);
  }
  return { amountMinimum: decoded.args[0] as bigint, recipient: decoded.args[1] as `0x${string}` };
}

// Encodes the builder's own {abi, functionName, args} exactly as wagmi's
// writeContract will, to assert the overload resolves the way we pinned it.
function selectorOf(call: { abi: unknown; functionName: string; args: readonly unknown[] }): string {
  return encodeFunctionData({
    abi: call.abi as Parameters<typeof encodeFunctionData>[0]["abi"],
    functionName: call.functionName,
    args: call.args,
  }).slice(0, 10);
}

describe("buildBuyCall", () => {
  const call = buildBuyCall({
    router: ROUTER,
    weth: WETH,
    token: TOKEN,
    poolFee: 10_000,
    recipient: USER,
    amountIn: 1000n,
    minAmountOut: 900n,
  });

  it("sends native value and recipient = the connected wallet", () => {
    expect(call.address).toBe(ROUTER);
    expect(call.functionName).toBe("exactInputSingle");
    // Native msg.value carries the WETH input — the router wraps it; no
    // separate WETH deposit.
    expect(call.value).toBe(1000n);
    expect(call.args[0].recipient).toBe(USER);
    expect(call.args[0].tokenIn).toBe(WETH);
    expect(call.args[0].tokenOut).toBe(TOKEN);
    expect(call.args[0].amountIn).toBe(1000n);
    // Load-bearing: a REAL, non-zero minimum-out passes straight through.
    expect(call.args[0].amountOutMinimum).toBe(900n);
    expect(call.args[0].sqrtPriceLimitX96).toBe(0n);
  });

  it("pins the NO-deadline exactInputSingle overload (selector 0x04e45aaf)", () => {
    const selector = selectorOf(call);
    expect(selector).toBe(NO_DEADLINE_SELECTOR);
    expect(selector).not.toBe(WITH_DEADLINE_SELECTOR);
  });
});

describe("buildSellCall", () => {
  const call = buildSellCall({
    router: ROUTER,
    weth: WETH,
    token: TOKEN,
    poolFee: 10_000,
    seller: USER,
    amountIn: 500n,
    minAmountOut: 480n,
  });

  it("routes the swap's recipient to the router itself, then unwraps to the seller", () => {
    expect(call.address).toBe(ROUTER);
    expect(call.functionName).toBe("multicall");
    expect(call.value).toBe(0n);
    expect(call.args[0]).toHaveLength(2); // [exactInputSingle calldata, unwrapWETH9 calldata]
  });

  it("never passes address(0) as the swap recipient — it is the router literal", () => {
    const decoded = decodeExactInputSingle(call.args[0][0]);
    expect(decoded.recipient).not.toBe(ZERO);
    expect(decoded.recipient).toBe(ROUTER);
    // Selling: token in, WETH out; the swap's own min-out is the REAL floor.
    expect(decoded.tokenIn).toBe(TOKEN);
    expect(decoded.tokenOut).toBe(WETH);
    expect(decoded.amountIn).toBe(500n);
    expect(decoded.amountOutMinimum).toBe(480n);
    expect(decoded.sqrtPriceLimitX96).toBe(0n);
  });

  it("encodes the swap leg with the NO-deadline selector", () => {
    expect(call.args[0][0].slice(0, 10)).toBe(NO_DEADLINE_SELECTOR);
  });

  it("unwraps to the seller with a zero floor (safe: the swap min-out already bounds the WETH)", () => {
    const unwrap = decodeUnwrapWETH9(call.args[0][1]);
    expect(unwrap.amountMinimum).toBe(0n);
    expect(unwrap.recipient).toBe(USER);
  });
});

// --- With-deadline overload (routerRequiresDeadline === true) --------------
// A token whose router wants the 8-field legacy shape passes a `deadline`; the
// builders must then select the WITH-deadline overload (selector 0x414bf389),
// never the live no-deadline one — the wrong overload would shift `deadline`
// into `amountIn` on-chain and move funds against a garbage min-out.
describe("buildBuyCall / buildSellCall with a deadline", () => {
  const DEADLINE = 1_900_000_000n;

  it("BUY selects the 8-field with-deadline overload and carries the deadline through", () => {
    const call = buildBuyCall({
      router: ROUTER,
      weth: WETH,
      token: TOKEN,
      poolFee: 10_000,
      recipient: USER,
      amountIn: 1000n,
      minAmountOut: 900n,
      deadline: DEADLINE,
    });
    // The whole call encodes to the with-deadline selector.
    expect(selectorOf(call)).toBe(WITH_DEADLINE_SELECTOR);
    expect(selectorOf(call)).not.toBe(NO_DEADLINE_SELECTOR);
    // Decoding against the full ABI (selector-driven) confirms the deadline
    // landed in its own field and amountIn is still amountIn.
    const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: encodeFunctionData({ abi: call.abi, functionName: "exactInputSingle", args: call.args }) });
    const params = decoded.args[0] as { deadline: bigint; amountIn: bigint; amountOutMinimum: bigint };
    expect(params.deadline).toBe(DEADLINE);
    expect(params.amountIn).toBe(1000n);
    expect(params.amountOutMinimum).toBe(900n);
    // The native value is still exactly amountIn.
    expect(call.value).toBe(1000n);
  });

  it("SELL's swap leg selects the with-deadline overload while the unwrap leg is unchanged", () => {
    const call = buildSellCall({
      router: ROUTER,
      weth: WETH,
      token: TOKEN,
      poolFee: 10_000,
      seller: USER,
      amountIn: 500n,
      minAmountOut: 480n,
      deadline: DEADLINE,
    });
    expect(call.args[0][0].slice(0, 10)).toBe(WITH_DEADLINE_SELECTOR);
    const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: call.args[0][0] });
    const params = decoded.args[0] as { deadline: bigint; recipient: `0x${string}`; amountIn: bigint };
    expect(params.deadline).toBe(DEADLINE);
    expect(params.recipient).toBe(ROUTER); // still the router itself, never address(0)
    expect(params.amountIn).toBe(500n);
    // The unwrap leg is untouched by the deadline.
    const unwrap = decodeUnwrapWETH9(call.args[0][1]);
    expect(unwrap.recipient).toBe(USER);
  });

  it("omitting the deadline keeps the live no-deadline overload (regression guard)", () => {
    const buy = buildBuyCall({
      router: ROUTER,
      weth: WETH,
      token: TOKEN,
      poolFee: 10_000,
      recipient: USER,
      amountIn: 1000n,
      minAmountOut: 900n,
    });
    expect(selectorOf(buy)).toBe(NO_DEADLINE_SELECTOR);
  });
});
