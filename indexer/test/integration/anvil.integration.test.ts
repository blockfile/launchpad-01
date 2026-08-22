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
let seeded: { factory: string; token: string; pool: string };

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
});
