import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// M1 regression: a routine ABI regen must NOT promote deployed factory/locker
// addresses into the committed per-chain address files unless explicitly opted
// in, and even then must refuse an Anvil/Foundry default deployer on a
// non-testnet (production) chain id — otherwise a local-fork rehearsal artifact
// for chain 4663 (the real mainnet id) would silently overwrite the committed
// (now REAL, mainnet-deployed) factory/locker with throwaway fork addresses.
//
// The generator is driven into scratch output dirs (ABIS_OUT_DIR /
// ADDRESSES_OUT_DIR) seeded with a copy of the committed address files, so this
// test exercises the real end-to-end script without mutating — or racing
// concurrent readers of — the committed tree.
//
// The tests DO write fake `contracts/broadcast/Deploy.s.sol/<chain>/run-latest.json`
// artifacts (that path is the generator's only input for promotion). Because a
// real deploy's broadcast log lives at exactly that path, the whole broadcast
// dir is snapshotted in `before` and restored in `after` — an earlier version
// simply `rmSync`'d it and wiped the real 2026-08-27 mainnet deploy log.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = join(__dirname, "..");
const SCRIPT = join(SHARED_DIR, "scripts", "gen-abis.mjs");
const COMMITTED_ADDRESSES_DIR = join(SHARED_DIR, "addresses");
const CONTRACTS_BROADCAST = join(SHARED_DIR, "..", "..", "contracts", "broadcast");
const broadcastDir = (chainId) => join(CONTRACTS_BROADCAST, "Deploy.s.sol", String(chainId));

const ANVIL_DEFAULT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // mnemonic account #0
const FORK_FACTORY = "0x00000000000000000000000000000000DeaDBeef";
const FORK_LOCKER = "0x000000000000000000000000000000000bADc0DE";
const REAL_DEPLOYER = "0x1111111111111111111111111111111111111111";

let scratch;
let abisOut;
let addressesOut;
let broadcastBackup; // snapshot of the real contracts/broadcast dir, restored in `after`

const readOut = (chainId) => JSON.parse(readFileSync(join(addressesOut, `${chainId}.json`), "utf8"));
const readCommitted = (chainId) =>
  JSON.parse(readFileSync(join(COMMITTED_ADDRESSES_DIR, `${chainId}.json`), "utf8"));

function broadcastArtifact({ factory, locker, deployer }) {
  return JSON.stringify({
    transactions: [
      {
        transactionType: "CREATE",
        contractName: "LaunchFactory",
        contractAddress: factory,
        transaction: { from: deployer },
      },
      {
        transactionType: "CREATE",
        contractName: "Locker",
        contractAddress: locker,
        transaction: { from: deployer },
      },
    ],
  });
}

function writeBroadcast(chainId, artifact) {
  const dir = broadcastDir(chainId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run-latest.json"), artifact);
}

function runGenAbis(env = {}) {
  execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ABIS_OUT_DIR: abisOut, ADDRESSES_OUT_DIR: addressesOut, ...env },
    stdio: "pipe",
  });
}

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "gen-abis-"));
  abisOut = join(scratch, "abis");
  addressesOut = join(scratch, "addresses");
  // Preserve any real broadcast logs before the tests start clobbering that dir.
  if (existsSync(CONTRACTS_BROADCAST)) {
    broadcastBackup = join(scratch, "broadcast-backup");
    cpSync(CONTRACTS_BROADCAST, broadcastBackup, { recursive: true });
  }
});

after(() => {
  if (existsSync(CONTRACTS_BROADCAST)) rmSync(CONTRACTS_BROADCAST, { recursive: true, force: true });
  if (broadcastBackup && existsSync(broadcastBackup)) cpSync(broadcastBackup, CONTRACTS_BROADCAST, { recursive: true });
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh scratch output seeded with the REAL committed address files, so the
  // "preserve committed factory/locker" path reads the true committed values
  // (the live mainnet addresses for 4663, null placeholders for 46630).
  rmSync(abisOut, { recursive: true, force: true });
  rmSync(addressesOut, { recursive: true, force: true });
  mkdirSync(abisOut, { recursive: true });
  cpSync(COMMITTED_ADDRESSES_DIR, addressesOut, { recursive: true });
  if (existsSync(CONTRACTS_BROADCAST)) rmSync(CONTRACTS_BROADCAST, { recursive: true, force: true });
});

test("default (non-promote) run preserves the committed 4663 factory/locker verbatim even with a fork broadcast present", () => {
  const committed = readCommitted(4663);
  assert.notEqual(committed.factory?.toLowerCase(), FORK_FACTORY.toLowerCase(), "fixture must differ from committed");
  writeBroadcast(4663, broadcastArtifact({ factory: FORK_FACTORY, locker: FORK_LOCKER, deployer: ANVIL_DEFAULT }));

  runGenAbis(); // no PROMOTE_DEPLOY_ADDRESSES flag — the default path

  const a = readOut(4663);
  assert.equal(a.factory, committed.factory, "default run must NOT promote a fork factory into 4663");
  assert.equal(a.locker, committed.locker, "default run must NOT promote a fork locker into 4663");
  // The static DEX addresses are still (re)written as before.
  assert.equal(a.weth, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
});

test("PROMOTE=1 still refuses an Anvil-default deployer on the non-testnet id 4663", () => {
  const committed = readCommitted(4663);
  writeBroadcast(4663, broadcastArtifact({ factory: FORK_FACTORY, locker: FORK_LOCKER, deployer: ANVIL_DEFAULT }));

  runGenAbis({ PROMOTE_DEPLOY_ADDRESSES: "1" });

  const a = readOut(4663);
  assert.equal(a.factory, committed.factory, "promotion must be refused for a default deployer on mainnet id 4663");
  assert.equal(a.locker, committed.locker);
});

test("PROMOTE=1 promotes a broadcast on testnet 46630 (guard is testnet-exempt, proving the path is live)", () => {
  // Even the Anvil default account promotes on a testnet id — the guard only
  // fires for non-testnet chains.
  writeBroadcast(46630, broadcastArtifact({ factory: FORK_FACTORY, locker: FORK_LOCKER, deployer: ANVIL_DEFAULT }));

  runGenAbis({ PROMOTE_DEPLOY_ADDRESSES: "1" });

  const a = readOut(46630);
  assert.equal(a.factory.toLowerCase(), FORK_FACTORY.toLowerCase(), "testnet promotion should write the broadcast factory");
  assert.equal(a.locker.toLowerCase(), FORK_LOCKER.toLowerCase());
});

test("PROMOTE=1 promotes a real (non-default) deployer even on the non-testnet id 4663", () => {
  writeBroadcast(4663, broadcastArtifact({ factory: FORK_FACTORY, locker: FORK_LOCKER, deployer: REAL_DEPLOYER }));

  runGenAbis({ PROMOTE_DEPLOY_ADDRESSES: "1" });

  const a = readOut(4663);
  assert.equal(a.factory.toLowerCase(), FORK_FACTORY.toLowerCase(), "a genuine deployer should promote on 4663");
  assert.equal(a.locker.toLowerCase(), FORK_LOCKER.toLowerCase());
});
