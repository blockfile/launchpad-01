import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Automates the local-Anvil bring-up for launch.anvil.test.ts, mirroring the
// harness already proven in indexer/test/integration/. It runs BEFORE test
// collection, so it can populate FACTORY_ADDRESS/ANVIL_RPC_URL that the test
// module reads at import time (its `describe.skipIf(!FACTORY)` guard then runs
// for real). If Foundry isn't installed, or SKIP_ANVIL=1, or the caller
// already provided FACTORY_ADDRESS (manual mode, brief Step 6), this no-ops
// and the test skips cleanly — so CI without a fork never fails here.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = path.resolve(__dirname, "../../../../contracts");

const PORT = Number(process.env.ANVIL_PORT ?? 8547);
const RPC_URL = `http://127.0.0.1:${PORT}`;
const FORK_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

// Anvil's well-known default account #0 — the deployer, and therefore this
// pre-fee-safety Deploy.s.sol's protocolWallet + the test's launcher.
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEN_K_ETH_WEI_HEX = "0x" + (10_000n * 10n ** 18n).toString(16);

// Foundry (anvil/forge/cast) is NOT on PATH on this machine — it lives under
// ~/.foundry/bin. Invoke by absolute path AND prepend that dir to the child's
// PATH so forge/cast resolve too. Overridable via FOUNDRY_BIN for CI.
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? path.join(os.homedir(), ".foundry", "bin");
const isWin = process.platform === "win32";
const bin = (name: string) => path.join(FOUNDRY_BIN, isWin ? `${name}.exe` : name);
const ANVIL_BIN = bin("anvil");
const FORGE_BIN = bin("forge");
const CAST_BIN = bin("cast");
const PATH_WITH_FOUNDRY = `${FOUNDRY_BIN}${path.delimiter}${process.env.PATH ?? ""}`;
const childEnv = { ...process.env, PATH: PATH_WITH_FOUNDRY };

let anvil: ChildProcess | undefined;

function killTree(child: ChildProcess | undefined) {
  if (!child?.pid) return;
  if (isWin) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    child.kill();
  }
}

async function rpcCall(method: string, params: unknown[] = []): Promise<string> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(`${method} -> ${body.error.message}`);
  return body.result!;
}

async function waitForRpc(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Confirm it's OUR fork (chain 4663), not a stale listener on the port.
      if (Number(await rpcCall("eth_chainId")) === 4663) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Anvil RPC at ${RPC_URL} did not become ready (chain 4663) within ${timeoutMs}ms`);
}

async function startAnvilWithRetry(attempts = 4): Promise<ChildProcess> {
  let lastErr = "";
  for (let i = 1; i <= attempts; i++) {
    const child = spawn(
      ANVIL_BIN,
      ["--chain-id", "4663", "--fork-url", FORK_URL, "--port", String(PORT), "--silent"],
      { stdio: ["ignore", "ignore", "pipe"], env: childEnv, shell: isWin },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => (stderr += `spawn error: ${e.message}\n`));
    try {
      await waitForRpc();
      return child;
    } catch (e) {
      lastErr = `${(e as Error).message}\n--- anvil stderr ---\n${stderr}`;
      killTree(child);
      await new Promise((r) => setTimeout(r, 2_000));
      console.error(`anvil fork bring-up attempt ${i}/${attempts} failed:\n${lastErr}`);
    }
  }
  throw new Error(`anvil fork could not be brought up after ${attempts} attempts.\n${lastErr}`);
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retrySync<T>(label: string, fn: () => T, attempts = 5, delayMs = 3_000): T {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      console.error(`${label} attempt ${i}/${attempts} failed: ${(e as Error).message}`);
      if (i < attempts) sleepSync(delayMs); // brief pause before the next (fork-flaky-RPC) retry
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${(lastErr as Error)?.message}`);
}

function castRpc(method: string, ...args: string[]) {
  execFileSync(CAST_BIN, ["rpc", method, ...args, "--rpc-url", RPC_URL], { env: childEnv, stdio: "ignore" });
}

function readDeployedFactory(): string {
  const runPath = path.join(CONTRACTS_ROOT, "broadcast/Deploy.s.sol/4663/run-latest.json");
  const run = JSON.parse(readFileSync(runPath, "utf8")) as {
    transactions: { transactionType: string; contractName: string; contractAddress: string }[];
  };
  const tx = run.transactions.find(
    (t) => t.transactionType === "CREATE" && t.contractName === "LaunchFactory",
  );
  if (!tx) throw new Error("LaunchFactory CREATE tx not found in broadcast/Deploy.s.sol/4663/run-latest.json");
  return tx.contractAddress;
}

export default async function setup(): Promise<() => void> {
  // Manual mode (brief Step 6): the caller stood up a chain and passed the
  // address in. Don't spin up a second Anvil — just use theirs.
  if (process.env.FACTORY_ADDRESS) return () => {};
  if (process.env.SKIP_ANVIL === "1") {
    console.warn("[anvil] SKIP_ANVIL=1 — launch.anvil.test.ts will skip.");
    return () => {};
  }
  if (!existsSync(ANVIL_BIN) || !existsSync(FORGE_BIN) || !existsSync(CAST_BIN)) {
    console.warn(`[anvil] Foundry not found under ${FOUNDRY_BIN} — launch.anvil.test.ts will skip.`);
    return () => {};
  }

  anvil = await startAnvilWithRetry();

  // CRITICAL fork gotcha: on chain 4663 the real chain has Anvil's default dev
  // accounts EIP-7702-delegated to a sweeper. The deployer (#0) is also this
  // pre-fee-safety Deploy.s.sol's protocolWallet, so the launch fee it receives
  // would be swept mid-tx. Reset it to a plain, funded EOA before deploying —
  // exactly as indexer/test/integration/seed-anvil.sh does. Fork artifact, not
  // a contract bug: a real deploy's protocolWallet is a normal wallet.
  retrySync("reset deployer account", () => {
    castRpc("anvil_setCode", DEPLOYER, "0x");
    castRpc("anvil_setBalance", DEPLOYER, TEN_K_ETH_WEI_HEX);
  });

  retrySync("forge deploy", () =>
    execFileSync(
      FORGE_BIN,
      ["script", "script/Deploy.s.sol", "--rpc-url", RPC_URL, "--broadcast", "--private-key", DEPLOYER_KEY],
      { cwd: CONTRACTS_ROOT, env: childEnv, stdio: "ignore", maxBuffer: 32 * 1024 * 1024 },
    ),
  );

  const factory = readDeployedFactory();
  // The local deploy's address flows via env only — never written back into
  // packages/shared/addresses/4663.json (that stays the record of A's real deploy).
  process.env.FACTORY_ADDRESS = factory;
  process.env.ANVIL_RPC_URL = RPC_URL;
  console.log(`[anvil] LaunchFactory deployed at ${factory} on ${RPC_URL}`);

  return () => killTree(anvil);
}
