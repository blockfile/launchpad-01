# rhpad.fun — Ubuntu server runbook

Single Ubuntu box (22.04 / 24.04) serving everything for **https://rhpad.fun**:

| Piece | How it runs | Port | nginx route |
|---|---|---|---|
| Web (Vite SPA, `web/dist`) | static files, served by nginx | — | `/` (SPA fallback to `index.html`) |
| Indexer (Ponder, `indexer/`) | pm2 `rhpad-indexer`, Postgres-backed | 127.0.0.1:42069 | `/indexer/` → Ponder (prefix stripped) |
| Logo pinning (`web/server/serve.ts` → `web/dist-server/serve.js`) | pm2 `rhpad-pin` | 127.0.0.1:3001 | `/api/pin` |

The web app defaults `VITE_INDEXER_URL` to `/indexer`, so one domain, no CORS, no second subdomain.
Contracts are already live on Robinhood Chain mainnet — see [4663-mainnet.md](./4663-mainnet.md); the web reads their
addresses from the committed `packages/shared/addresses/4663.json`, so no contract env vars are needed on the server.

Before you start: point DNS **A records for `rhpad.fun` and `www.rhpad.fun`** at the server's IP and wait until
`dig +short rhpad.fun` returns it (certbot needs this). Everything below is run as a sudo-capable user over SSH.

---

## 1. Base system + firewall

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl git build-essential ufw

sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

## 2. Node.js 22 LTS + npm (NodeSource)

Vite 8 needs Node ≥ 22.12; Node 22 is the current LTS.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
node -v   # v22.x
npm -v    # 10.x
```

## 3. pm2 (process manager, auto-start on reboot)

```bash
sudo npm install -g pm2
pm2 -v

# make pm2 resurrect your processes after a reboot (run the command it prints)
pm2 startup systemd -u "$USER" --hp "$HOME"
```

## 4. PostgreSQL (Ponder's production database)

Ponder's default pglite store is in-memory/dev-only; production needs Postgres.

```bash
sudo apt -y install postgresql postgresql-contrib
sudo systemctl enable --now postgresql

# create a role + database for the indexer (pick your own password)
sudo -u postgres psql <<'SQL'
CREATE ROLE ponder WITH LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE rhpad OWNER ponder;
SQL

# sanity check
psql "postgresql://ponder:CHANGE_ME_STRONG_PASSWORD@127.0.0.1:5432/rhpad" -c 'select 1;'
```

## 5. nginx

```bash
sudo apt -y install nginx
sudo systemctl enable --now nginx
curl -sI http://127.0.0.1 | head -1   # HTTP/1.1 200 OK
```

## 6. Clone the repo into /var/www and build

```bash
sudo mkdir -p /var/www
sudo chown "$USER":"$USER" /var/www
cd /var/www
git clone https://github.com/blockfile/launchpad-01.git rhpad.fun
cd /var/www/rhpad.fun

# installs every workspace (packages/shared, indexer, web). Keep devDependencies:
# the web build runs `tsc -b` and Ponder's build needs them.
npm ci
```

### 6a. Environment files (never committed)

```bash
# --- Ponder (reads indexer/.env.local on its own) ---
cat > /var/www/rhpad.fun/indexer/.env.local <<'EOF'
PONDER_CHAIN_ID=4663
PONDER_START_BLOCK=47146567
PONDER_RPC_URL=https://rpc.mainnet.chain.robinhood.com
DATABASE_URL=postgresql://ponder:CHANGE_ME_STRONG_PASSWORD@127.0.0.1:5432/rhpad
EOF

# --- secrets for pm2 (loaded by ecosystem.config.cjs) ---
cat > /var/www/rhpad.fun/.env.pm2 <<'EOF'
DATABASE_URL=postgresql://ponder:CHANGE_ME_STRONG_PASSWORD@127.0.0.1:5432/rhpad
PONDER_RPC_URL=https://rpc.mainnet.chain.robinhood.com
PINATA_JWT=PASTE_YOUR_PINATA_JWT
EOF
chmod 600 /var/www/rhpad.fun/.env.pm2 /var/www/rhpad.fun/indexer/.env.local

# --- web build-time vars (baked into the bundle by Vite) ---
cat > /var/www/rhpad.fun/web/.env <<'EOF'
VITE_WALLETCONNECT_PROJECT_ID=PASTE_FROM_cloud.reown.com
EOF
```

Notes:
- `PINATA_JWT` — from https://app.pinata.cloud (API Keys → *pinFileToIPFS* scope). Without it the pin server silently
  returns fake `ipfs://mock-…` URIs.
- `VITE_WALLETCONNECT_PROJECT_ID` — free at https://cloud.reown.com. Without it the app still works with injected
  wallets (MetaMask) but logs 403s from WalletConnect.
- The public RPC is rate-limited/flaky; if you get a dedicated Robinhood Chain RPC URL, put it in `PONDER_RPC_URL`.
- Do **not** set `VITE_LOCAL_RPC_URL`, `VITE_FACTORY_ADDRESS`, `VITE_LOCKER_ADDRESS`, `VITE_INDEXER_URL` — those are
  local-dev overrides. The MSW mock worker is dev-only and is not in the production bundle.

### 6b. Build

```bash
cd /var/www/rhpad.fun
npm run build --workspace web           # tsc -b && vite build  → web/dist
npm run build:server --workspace web    # vite build -c vite.server.config.ts → web/dist-server/serve.js
ls web/dist/index.html web/dist-server/serve.js
```

## 7. Start the indexer + pin server with pm2

```bash
cd /var/www/rhpad.fun
pm2 start ecosystem.config.cjs
pm2 save                      # persist for `pm2 startup`
pm2 status
pm2 logs rhpad-indexer --lines 50   # should show the sync progressing from block 47146567
pm2 logs rhpad-pin --lines 5        # "[pin] listening on http://127.0.0.1:3001 (provider: pinata)"

curl -s http://127.0.0.1:42069/tokens | head -c 300
curl -s http://127.0.0.1:3001/healthz   # ok
```

Ponder first-run notes: it backfills from block 47146567 to head, then follows live. The API answers during backfill.

## 8. nginx site (sudo tee)

```bash
sudo tee /etc/nginx/sites-available/rhpad.fun >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name rhpad.fun www.rhpad.fun;

    root /var/www/rhpad.fun/web/dist;
    index index.html;

    # logo uploads are capped at 5 MB by the pin handler; give nginx headroom
    client_max_body_size 6m;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript image/svg+xml;
    gzip_min_length 1024;

    # Ponder HTTP API. Trailing slashes matter: /indexer/tokens → http://127.0.0.1:42069/tokens
    location /indexer/ {
        proxy_pass http://127.0.0.1:42069/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # logo → IPFS pin (node server built from web/server/serve.ts)
    location = /api/pin {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering on;
    }

    # hashed Vite assets: cache forever
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # SPA: every other path falls back to index.html (React Router)
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
}
EOF

sudo ln -sf /etc/nginx/sites-available/rhpad.fun /etc/nginx/sites-enabled/rhpad.fun
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# plain-HTTP smoke test before TLS
curl -sI http://rhpad.fun | head -1                       # 200
curl -s  http://rhpad.fun/indexer/tokens | head -c 200    # JSON from Ponder
```

## 9. HTTPS with certbot (Let's Encrypt)

```bash
sudo snap install core && sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot

# obtains the cert AND rewrites the nginx server block for 443 + HTTP→HTTPS redirect
sudo certbot --nginx -d rhpad.fun -d www.rhpad.fun --redirect -m you@example.com --agree-tos --no-eff-email

sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run          # auto-renewal is installed as a systemd timer by the snap
```

## 10. Verify

```bash
curl -sI https://rhpad.fun | head -1                                   # 200
curl -s  https://rhpad.fun/indexer/tokens | head -c 300                # tokens JSON
curl -s  https://rhpad.fun/indexer/stats                               # global stats
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: text/plain' https://rhpad.fun/api/pin   # 400 (route reaches the pin server)
pm2 status
```

Open https://rhpad.fun → Explore should list every token launched through the mainnet factory; Launch reads the
0.0005 ETH fee live from the contract. Connect MetaMask on Robinhood Chain (4663).

## 11. Updating the site later

```bash
cd /var/www/rhpad.fun
git pull
npm ci
npm run build --workspace web && npm run build:server --workspace web
pm2 reload ecosystem.config.cjs      # zero-downtime restart of indexer + pin server
pm2 save
```

If the **indexer's schema or handlers changed**, Ponder needs a fresh Postgres schema name:
`PONDER_SCHEMA=rhpad_v2 pm2 reload ecosystem.config.cjs` (it re-backfills from block 47146567; the old schema can be
dropped in Postgres afterwards). A plain restart of the same build keeps `rhpad_v1` and resumes.

## Troubleshooting

| Symptom | Check |
|---|---|
| `/indexer/tokens` → 502 | `pm2 logs rhpad-indexer` — usually `DATABASE_URL` wrong or Postgres not running (`systemctl status postgresql`). |
| Explore is empty but the contract has launches | Ponder still backfilling (`pm2 logs`), or `PONDER_START_BLOCK` set later than 47146567. |
| Logo upload returns `ipfs://mock-…` | `PINATA_JWT` missing from `.env.pm2`; fix and `pm2 reload ecosystem.config.cjs`. |
| Launch page says no factory for this chain | Wallet is not on chain 4663, or `packages/shared/addresses/4663.json` was overwritten (must be `0x12967ddc…`). |
| RPC rate-limit errors in indexer logs | `hardenedHttp` retries transient errors; if persistent, move `PONDER_RPC_URL` to a dedicated endpoint. |
| certbot fails | DNS not propagated yet, or port 80 blocked (`sudo ufw status`). |
