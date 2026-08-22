import { http, type Transport } from "viem";

const TRANSIENT_CODES = new Set([-32601, -32603, -32005, -32000]);
const TRANSIENT_TEXT = /rate limit|timeout|busy/i;

/** Classifies an RPC error as transient per the digest's pons-launcher findings
 * (§2/§3): spurious method-not-found/internal/rate-limit-shaped errors on an
 * otherwise-valid call, observed against this chain's public RPC in production. */
export function isTransientRpcError(err: unknown): boolean {
  const code =
    (err as { code?: number }).code ?? (err as { cause?: { code?: number } }).cause?.code;
  if (code !== undefined && TRANSIENT_CODES.has(code)) return true;
  const message = String(
    (err as { shortMessage?: string; message?: string }).shortMessage ??
      (err as Error).message ??
      "",
  );
  return TRANSIENT_TEXT.test(message);
}

/** Wraps any viem Transport with classified-retry + exponential backoff. Kept
 * generic (not hardcoded to `http`) so it is unit-testable against a fake
 * transport with no network involved. */
export function withTransientRetry(
  transport: Transport,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Transport {
  const retries = opts.retries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  return (transportConfig) => {
    const inner = transport(transportConfig);
    return {
      ...inner,
      async request(args) {
        let lastErr: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            return await inner.request(args);
          } catch (err) {
            lastErr = err;
            if (!isTransientRpcError(err) || attempt === retries) throw err;
            await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
          }
        }
        throw lastErr;
      },
    };
  };
}

/** The production transport: viem's `http`, batching disabled (digest §3:
 * "do not assume batched JSON-RPC works" against this chain), wrapped with
 * classified retry. */
export function hardenedHttp(url: string, opts?: { retries?: number; baseDelayMs?: number }): Transport {
  return withTransientRetry(http(url, { batch: false }), opts);
}
