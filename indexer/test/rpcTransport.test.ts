import { describe, expect, it, vi } from "vitest";
import type { Transport } from "viem";
import { isTransientRpcError, withTransientRetry } from "../src/lib/rpcTransport";

function fakeTransport(behavior: Array<() => unknown>) {
  let call = 0;
  const request = vi.fn(async () => {
    const step = behavior[call++];
    if (!step) throw new Error("fakeTransport: no more scripted behavior");
    return step();
  });
  const transport = (() => ({ config: { type: "fake" }, request })) as unknown as Transport;
  return { transport, request };
}

describe("isTransientRpcError", () => {
  it("matches classified JSON-RPC error codes, including a nested cause", () => {
    expect(isTransientRpcError({ code: -32601 })).toBe(true);
    expect(isTransientRpcError({ cause: { code: -32603 } })).toBe(true);
    expect(isTransientRpcError({ code: -32000 })).toBe(true);
  });
  it("matches transient text regardless of code", () => {
    expect(isTransientRpcError(new Error("upstream rate limit exceeded"))).toBe(true);
    expect(isTransientRpcError(new Error("gateway timeout"))).toBe(true);
  });
  it("does not match an unrelated contract-revert error", () => {
    expect(isTransientRpcError({ code: 3, message: "execution reverted: CapExceeded" })).toBe(false);
  });
});

describe("withTransientRetry", () => {
  it("retries a transient error and succeeds", async () => {
    const { transport, request } = fakeTransport([
      () => { throw { code: -32601, message: "Method not found" }; },
      () => { throw { code: -32601, message: "Method not found" }; },
      () => ({ ok: true }),
    ]);
    const wrapped = withTransientRetry(transport, { retries: 4, baseDelayMs: 1 });
    const result = await wrapped({} as never).request({ method: "eth_getLogs" } as never);
    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-transient error", async () => {
    const { transport, request } = fakeTransport([
      () => { throw { code: 3, message: "execution reverted" }; },
      () => ({ ok: true }),
    ]);
    const wrapped = withTransientRetry(transport, { retries: 4, baseDelayMs: 1 });
    await expect(wrapped({} as never).request({ method: "eth_call" } as never)).rejects.toMatchObject({ code: 3 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error after exhausting retries", async () => {
    const { transport } = fakeTransport([
      () => { throw { code: -32603, message: "Internal error" }; },
      () => { throw { code: -32603, message: "Internal error" }; },
    ]);
    const wrapped = withTransientRetry(transport, { retries: 1, baseDelayMs: 1 });
    await expect(wrapped({} as never).request({ method: "eth_getLogs" } as never)).rejects.toMatchObject({ code: -32603 });
  });
});
