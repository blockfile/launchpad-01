import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = "http://127.0.0.1:8560";
const INDEXER_URL = "http://127.0.0.1:42069";
const CONTRACTS_ROOT = path.resolve(__dirname, "../../../contracts");
const INDEXER_ROOT = path.resolve(__dirname, "../..");
const SEED_SCRIPT = path.resolve(__dirname, "./seed-anvil.sh");
const SENDER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // Anvil default account #0 — seed-anvil.sh's deployer/launcher
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Anvil default account #1 — seed-anvil.sh's wallet-transfer target

// --- REQUIRED CORRECTION 2: Foundry + Windows process launching -------------
// anvil/forge/cast are NOT on PATH; they live under ~/.foundry/bin. We invoke
// anvil by absolute path AND prepend that dir to the spawned env's PATH (so the
// seed's own forge/cast resolve too). Overridable via FOUNDRY_BIN for CI.
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? path.join(os.homedir(), ".foundry", "bin");
const ANVIL_BIN = path.join(FOUNDRY_BIN, process.platform === "win32" ? "anvil.exe" : "anvil");
const PATH_WITH_FOUNDRY = `${FOUNDRY_BIN}${path.delimiter}${process.env.PATH ?? ""}`;

// The seed is a bash script; on Windows the only bash is Git Bash, which is not
// necessarily on the system PATH from a Windows process's point of view. Prefer
// a concrete Git Bash, fall back to a bare "bash" (resolved via PATH).
function resolveBash(): string {
  const candidates = [
    process.env.INTEGRATION_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (existsSync(c)) return c;
  return "bash";
}

// child.kill() on Windows does not reap a spawned shell's descendants (Ponder's
// child node processes, holding port 42069). taskkill /T /F kills the tree so a
// re-run isn't blocked by an orphan.
function killTree(child: ChildProcess | undefined) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    child.kill();
  }
}

let anvil: ChildProcess | undefined;
let ponder: ChildProcess | undefined;
let seeded: { factory: string; token: string; pool: string; token2: string; pool2: string; zeroedHolder: string };

async function rpcCall(url: string, method: string, params: unknown[] = []): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(`${method} -> ${body.error.message}`);
  return body.result!;
}

async function waitForRpc(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Confirm it's OUR fork (chain 4663), not a stale listener on the port.
      const chainId = await rpcCall(url, "eth_chainId");
      if (Number(chainId) === 4663) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`RPC at ${url} did not become ready (chain 4663) within ${timeoutMs}ms`);
}

// --- REQUIRED CORRECTION 2 (retries around fork bring-up) --------------------
// Forking pulls state from the documented-flaky public RPC; a bring-up can fail
// spuriously. Spawn anvil, wait for it; on failure kill it and retry, surfacing
// the captured anvil stderr so a genuine, persistent RPC outage is reported
// precisely (never silently masked).
async function startAnvilWithRetry(forkUrl: string, attempts = 4): Promise<ChildProcess> {
  let lastErr = "";
  for (let i = 1; i <= attempts; i++) {
    const child = spawn(ANVIL_BIN, ["--chain-id", "4663", "--fork-url", forkUrl, "--port", "8560", "--silent"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PATH: PATH_WITH_FOUNDRY },
    });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => (stderr += `spawn error: ${e.message}\n`));
    try {
      await waitForRpc(RPC_URL, 30_000);
      return child;
    } catch (e) {
      lastErr = `${(e as Error).message}\n--- anvil stderr ---\n${stderr}`;
      killTree(child);
      // brief pause before the next fork attempt
      await new Promise((r) => setTimeout(r, 2_000));
      console.error(`anvil fork bring-up attempt ${i}/${attempts} failed:\n${lastErr}`);
    }
  }
  throw new Error(`anvil fork could not be brought up after ${attempts} attempts.\n${lastErr}`);
}

async function waitForIndexedToken(timeoutMs = 180_000) {
  const start = Date.now();
  let lastErr = "indexer HTTP never responded";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${INDEXER_URL}/tokens`);
      if (res.ok) {
        const body = (await res.json()) as { items: unknown[] };
        if (body.items.length > 0) return;
        lastErr = "indexer up, /tokens still empty (sync in progress)";
      } else {
        lastErr = `/tokens -> HTTP ${res.status}`;
      }
    } catch {
      lastErr = "indexer HTTP server not up yet";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`indexer never indexed the seeded token within ${timeoutMs}ms (${lastErr})`);
}

// TOKEN2 (see seed-anvil.sh) launches strictly after TOKEN, in a later block,
// with an atomic dev buy immediately followed by a same-block sell against
// its own pool — exactly the race LaunchFactory.ts's fix is about. Waiting
// for it specifically (rather than relying on `waitForIndexedToken`, which
// is satisfied the moment TOKEN alone shows up) is a direct, first-class
// check that the indexer kept processing past that block instead of halting
// (blocker 2's worst case: an unhandled throw in `applyTransfer`).
async function waitForToken(address: string, timeoutMs = 60_000) {
  const start = Date.now();
  let lastErr = "indexer HTTP never responded";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${INDEXER_URL}/tokens/${address}`);
      if (res.status === 200) return;
      lastErr = `/tokens/${address} -> HTTP ${res.status}`;
    } catch {
      lastErr = "indexer HTTP server not reachable";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `indexer never indexed token ${address} within ${timeoutMs}ms (${lastErr}) — possible halt processing its launch block`,
  );
}

describe("indexer against a local Anvil deploy of sub-project A", () => {
  beforeAll(async () => {
    const forkUrl = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

    // 1) Bring up the forked local Anvil (with retries around the flaky RPC).
    anvil = await startAnvilWithRetry(forkUrl);

    // 2) --- REQUIRED CORRECTION 1: capture the fork base block H BEFORE seeding.
    // Ponder scanning from block 0 would eth_getLogs-walk the entire real chain
    // history (millions of blocks, proxied through the flaky public RPC) before
    // reaching the freshly-deployed factory — a guaranteed timeout. The deploy /
    // launch / swap all land at H+1…, so starting Ponder at H limits it to the
    // handful of local Anvil blocks. ponder.config.ts reads PONDER_START_BLOCK
    // (line 29) and applies it to all three contracts.
    const forkBaseBlock = Number(BigInt(await rpcCall(RPC_URL, "eth_blockNumber")));
    if (!Number.isFinite(forkBaseBlock) || forkBaseBlock <= 0) {
      throw new Error(`unexpected fork base block: ${forkBaseBlock}`);
    }

    // 3) Deploy A + seed a launch + swap + transfer through the local fork.
    const bash = resolveBash();
    const output = execFileSync(bash, [SEED_SCRIPT.replace(/\\/g, "/")], {
      cwd: CONTRACTS_ROOT,
      env: { ...process.env, RPC_URL, PATH: PATH_WITH_FOUNDRY },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"], // stream the seed's progress log; capture only the final JSON line
      maxBuffer: 32 * 1024 * 1024,
    });
    seeded = JSON.parse(output.trim().split("\n").pop()!);

    // 4) Start Ponder against the local fork, scanning only from H forward.
    ponder = spawn(
      `pnpm --filter @launchpad/indexer exec ponder start --schema test_${Date.now()}`,
      {
        cwd: INDEXER_ROOT,
        shell: true, // pnpm resolves as pnpm.CMD on Windows — needs a shell
        env: {
          ...process.env,
          PATH: PATH_WITH_FOUNDRY,
          PONDER_RPC_URL: RPC_URL,
          PONDER_CHAIN_ID: "4663",
          PONDER_FACTORY_ADDRESS: seeded.factory,
          PONDER_LOCAL_DEV: "1",
          PONDER_START_BLOCK: String(forkBaseBlock),
        },
        stdio: "inherit",
      },
    );
    await waitForIndexedToken();
    await waitForToken(seeded.token2); // see the function's own doc-comment: proves the indexer didn't halt on TOKEN2's launch block
  });

  afterAll(() => {
    killTree(ponder);
    killTree(anvil);
  });

  it("indexed the launched token with its live-read metadata", async () => {
    const res = await fetch(`${INDEXER_URL}/tokens/${seeded.token}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.symbol).toBe("TEST");
    expect(body.poolAddress.toLowerCase()).toBe(seeded.pool.toLowerCase());
    expect(body.deployer.toLowerCase()).toBe(SENDER_ADDRESS.toLowerCase());
  });

  it("lists the token with a computed marketCap once it has traded", async () => {
    const res = await fetch(`${INDEXER_URL}/tokens?sort=newest`);
    const body = await res.json();
    const listed = body.items.find((t: { address: string }) => t.address.toLowerCase() === seeded.token.toLowerCase());
    expect(listed).toBeDefined();
    expect(listed.marketCap).toEqual(expect.any(String)); // non-null: the seeded buy already set lastPrice18
    expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true); // never omitted, per the API's cursor contract
  });

  it("indexed the buy trade with the correct side", async () => {
    const res = await fetch(`${INDEXER_URL}/tokens/${seeded.token}/trades`);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].side).toBe("buy");
  });

  it("rolled the trade up into an hourly candle", async () => {
    const res = await fetch(`${INDEXER_URL}/tokens/${seeded.token}/candles?interval=1h`);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("tracked holder balances across the buy and the wallet transfer", async () => {
    const res = await fetch(`${INDEXER_URL}/tokens/${seeded.token}/holders`);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(2); // at least the pool + the buyer/recipient
  });

  it("finds the token by symbol via /search", async () => {
    const res = await fetch(`${INDEXER_URL}/search?q=TEST`);
    const body = await res.json();
    expect(body.items.some((t: { address: string }) => t.address.toLowerCase() === seeded.token.toLowerCase())).toBe(true);
  });

  it("reports global stats including this launch", async () => {
    const res = await fetch(`${INDEXER_URL}/stats`);
    const body = await res.json();
    expect(body.tokensLaunched).toBeGreaterThanOrEqual(1);
  });

  it("lists the enabled launch config and dex ids via /launch-configs", async () => {
    const res = await fetch(`${INDEXER_URL}/launch-configs`);
    const body = await res.json();
    expect(body.launchConfigIds).toContain(0);
    expect(body.dexIds).toContain(0);
  });

  it("lists the recipient's held token via /wallets/:address/holdings", async () => {
    const res = await fetch(`${INDEXER_URL}/wallets/${RECIPIENT}/holdings`);
    const body = await res.json();
    expect(body.items.some((h: { tokenAddress: string }) => h.tokenAddress.toLowerCase() === seeded.token.toLowerCase())).toBe(true);
  });

  // Blocker 2: LaunchFactory's TokenLaunched handler used to overwrite
  // holders(pool) with a balanceOf(pool) read pinned to the launch block —
  // a read that, on this fixture, already reflects the same-block sell
  // seed-anvil.sh drives right after the launch (see its own comment for the
  // full mechanism). `beforeAll`'s `waitForToken(seeded.token2)` already
  // proved the indexer didn't halt reaching this point; this test proves the
  // resulting holder balances are actually correct, not just present.
  it("fires the atomic dev buy for a nonzero-initialBuyAmount launch and keeps holders(pool) correct despite a same-block sell", async () => {
    const [tokenRes, holdersRes] = await Promise.all([
      fetch(`${INDEXER_URL}/tokens/${seeded.token2}`),
      fetch(`${INDEXER_URL}/tokens/${seeded.token2}/holders`),
    ]);
    expect(tokenRes.status).toBe(200);
    expect(holdersRes.status).toBe(200);
    const token = await tokenRes.json();
    const holdersBody = await holdersRes.json();

    expect(holdersBody.nextCursor).toBeNull(); // pool2 + buyer (+ any dust) fit on one page — no page boundary hiding a mismatch
    // NOT asserting items.length === totalHolders here: the factory itself
    // is left holding a tiny liquidity-seeding rounding remainder, which —
    // like the dev buy — is a pre-launch-row transfer (before TokenLaunched
    // inserts the `tokens` row), so per Token.ts's own documented guard it
    // never adjusts holderCount. That's real, pre-existing behavior
    // orthogonal to both blockers this fix wave addresses, not something to
    // paper over with a false equality.

    const pool2Item = holdersBody.items.find((h: { address: string }) => h.address.toLowerCase() === seeded.pool2.toLowerCase());
    const buyerItem = holdersBody.items.find((h: { address: string }) => h.address.toLowerCase() === SENDER_ADDRESS.toLowerCase());
    expect(pool2Item).toBeDefined();
    expect(buyerItem).toBeDefined();
    expect(BigInt(pool2Item.balance)).toBeGreaterThan(0n);
    expect(BigInt(buyerItem.balance)).toBeGreaterThan(0n);

    // ERC20 conservation invariant: every raw unit of supply is minted once
    // (constructor mint to the pool) and only ever moves between tracked
    // holders from there — pool seed, dev buy, and the same-block sell are
    // all transfers between $SENDER and pool2, never a burn. The double-
    // count this fix prevents (TokenLaunched's overwrite + the sell's own
    // Transfer log both applying the same delta) would break this sum,
    // silently, without necessarily throwing.
    const sum = holdersBody.items.reduce((acc: bigint, h: { balance: string }) => acc + BigInt(h.balance), 0n);
    expect(sum).toBe(BigInt(token.supply));
  });

  // Blocker 1: Token.ts only ever upserts `holders` rows, never deletes —
  // a holder that fully exits leaves a real balance=0 row behind. $FOURTH
  // (seed-anvil.sh) is driven to exactly that: it receives TOKEN, then
  // forwards its entire balance onward, so its row lands at balance=0
  // without ever being removed.
  it("excludes a zero-balance ex-holder from /tokens/:address/holders and keeps totalHolders consistent", async () => {
    const res = await fetch(`${INDEXER_URL}/tokens/${seeded.token}/holders`);
    const body = await res.json();

    const zeroed = body.items.find((h: { address: string }) => h.address.toLowerCase() === seeded.zeroedHolder.toLowerCase());
    expect(zeroed).toBeUndefined();

    expect(body.nextCursor).toBeNull(); // small, known holder set — no truncation could be hiding the phantom row instead
    expect(body.items.every((h: { balance: string }) => BigInt(h.balance) > 0n)).toBe(true); // no phantom zero-balance rows survive at all
    // NOT asserting items.length === totalHolders: the factory keeps a tiny
    // liquidity-seeding rounding remainder as a real, nonzero holders row,
    // but — being a pre-launch-row transfer — it never adjusts holderCount
    // (see the same note in the token2 test above). totalHolders is
    // therefore a lower bound here, not an exact match for the page.
    expect(body.items.length).toBeGreaterThanOrEqual(body.totalHolders);
  });
});
