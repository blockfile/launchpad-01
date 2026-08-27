// pm2 process file for the rhpad.fun server (see docs/deployments/rhpad-fun-ubuntu.md).
//
//   pm2 start ecosystem.config.cjs          # first boot
//   pm2 reload ecosystem.config.cjs         # after `git pull` + rebuild
//
// Two long-running processes; nginx serves the built SPA (web/dist) itself:
//   rhpad-indexer  Ponder, HTTP API on 127.0.0.1:42069  (nginx: /indexer/ → here)
//   rhpad-pin      web/server/serve.ts build, 127.0.0.1:3001 (nginx: /api/pin → here)
//
// Secrets are NOT in this file. They live in `<repo>/.env.pm2` (gitignored,
// KEY=VALUE lines) and are loaded here at `pm2 start`/`reload` time. Ponder
// additionally reads `indexer/.env.local` on its own.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

const secrets = loadEnvFile(path.join(ROOT, ".env.pm2"));

// Bump this when the indexer's schema or handler logic changes (Ponder needs a
// fresh Postgres schema per incompatible deployment); keep it to restart the
// same build and resume where it left off.
const PONDER_SCHEMA = process.env.PONDER_SCHEMA || "rhpad_v1";

module.exports = {
  apps: [
    {
      name: "rhpad-indexer",
      cwd: path.join(ROOT, "indexer"),
      script: path.join(ROOT, "node_modules", ".bin", "ponder"),
      args: `start --schema ${PONDER_SCHEMA} --hostname 127.0.0.1 --port 42069`,
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PONDER_CHAIN_ID: "4663",
        PONDER_START_BLOCK: "47146567", // Locker deploy block on mainnet — see docs/deployments/4663-mainnet.md
        PONDER_RPC_URL: secrets.PONDER_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
        DATABASE_URL: secrets.DATABASE_URL, // required: pglite is NOT durable — use Postgres in production
        PONDER_LOG_LEVEL: secrets.PONDER_LOG_LEVEL || "info",
      },
      max_memory_restart: "1500M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      kill_timeout: 15000,
      time: true,
    },
    {
      name: "rhpad-pin",
      cwd: path.join(ROOT, "web"),
      script: "dist-server/serve.js", // built by `npm run build:server --workspace web`
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PIN_HOST: "127.0.0.1",
        PIN_PORT: "3001",
        PINATA_JWT: secrets.PINATA_JWT, // unset → MockPinProvider (fake ipfs:// URIs) — never leave unset in prod
      },
      max_memory_restart: "300M",
      restart_delay: 2000,
      time: true,
    },
  ],
};
