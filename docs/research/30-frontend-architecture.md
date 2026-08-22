# Frontend Architecture — pons-style launchpad

Design research for the client application: page inventory, stack choice, data
flow (indexer vs. direct chain reads), and how trading executes against
Uniswap V3. Written to feed the rest of the project's design, not to be a
final spec — open questions are called out inline.

Sources: `ponsfamily.com` (the live product this project is modeled on),
`docs.ponsfamily.com` / `ponsfamily.com/integration` (protocol + integration
docs), and the local `d:\projects\pons-launcher\frontend` (a *console for
operating* the launchpad from the server side — not the launchpad itself, but
a rich source of UI conventions and a useful contrast in trust model).

---

## 1. What pons's own site actually is

pons (`ponsfamily.com`, built for Robinhood Chain, chain id 4663) is a
**non-custodial** launchpad: "Your wallet submits every transaction. pons does
not custody assets." Every mutating action — launch, buy, sell — is a
transaction the visitor's own wallet signs and broadcasts. This is the
opposite trust model from `pons-launcher/frontend`, which is a private
operator console where a *server-held* keystore signs bundle transactions
(see §7). That distinction matters: **the launchpad we are designing is a
wallet-signing dapp**, and the local repo's `api.js` (server does the signing,
`x-api-key` gate) is not the pattern to copy for the trading site itself — it
is the pattern to copy for the *reusable UI conventions* it demonstrates
(forms, toasts, modals, IPFS upload flow).

### Site map

| Route | Page |
|---|---|
| `/launchpad` | Explore — token list |
| `/launchpad/create` | Launch a token |
| `/launchpad/{tokenAddress}` | Token trade page |
| `/analytics` | Dune-powered protocol analytics (volume, revenue, launches) |
| `/profile` | Wallet's own launches / holdings |
| `docs.ponsfamily.com` | Protocol + integration docs |

Global chrome: logo, `⌘K` search, primary "Create" CTA, nav (Explore /
Analytics / Create / Profile / Docs).

### Protocol facts worth carrying into the design (verified via docs + WebFetch, 2026-08-22)

- **v1**: factory deploys a **fixed 1,000,000,000-supply** token straight into
  a **Uniswap V3** pool (WETH pair, **1% fee tier**) in one transaction — *no
  bonding curve*. Launch fee **0.0005 ETH**. Price is derived from the pool's
  live `slot0` (`sqrtPriceX96` squared → price, converted to USD via an ETH
  oracle). A "graduation" threshold of **4.2 ETH** raised is tracked but
  trading never migrates — "nothing moves or migrates," it's a status label,
  not a pool change.
- **Launch protection**: the deployer's own initial buy is the only trade that
  executes in the launch block; for a short window after, every other wallet
  is capped at **5% of supply per buy** (**2-block** restriction window).
- **Fees**: trading fee split is **70% creator / 30% protocol** on current
  launches (90/10 grandfathered on legacy tokens). Protocol's share funds
  buybacks (80%) and operations (20%).
- **v2** (a second factory, confirmed independently in the local repo, see
  `pons-launcher/README.md:180-213`) launches a **bonding curve** holding the
  full supply; a Uniswap **v4** pool is built only at graduation (**4.2 ETH**
  raised is the v2 number too, curve fee `curveFeeBps` read from config). v2
  adds an **opening tax** on buys (starts ~99%, decays to 0 over a few
  seconds, charged on the buy's *recipient*) with a declared-exemption list
  (max 32 addresses) for the launching team's own wallets — "the sanctioned
  pathway for organized teams that bundle their opening buys."
- **No off-chain API is required by the protocol** — docs explicitly say
  metadata reads directly off the token contract (`name()`, `symbol()`,
  `liquidityPool()`) and indexing is done by watching `TokenLaunched` and
  `Swap` events with viem. This is a strong signal about the *reference*
  approach: contracts are the source of truth, and a frontend is free to add
  its own indexer for anything that needs sorting/history (see §6).

### Explore page (`/launchpad`)

Confirmed controls (WebFetch, two passes):
- Sort: **Recent buys**, **Newest**, **Oldest**
- Time window: **All / 24h / 7d**
- Protocol filter: **Both / v1 / v2**
- Visible metrics per row: **market cap**, **volume**
- Framing copy: "Tokens still climbing toward graduation on Robinhood Chain" —
  i.e. the default view is graduating/live tokens, with graduated presumably a
  separate filter state (not confirmed by fetch, but consistent with every
  competitor in this space, see §2).

The full column set (age, holders, liquidity, %change, per-row sparkline,
graduation progress bar) could not be confirmed from static fetches (client
rendered, likely behind JS hydration the fetcher doesn't execute) — treat
those as **inferred from category convention** (§2), not confirmed pons
behavior. Flag as an open question if pixel-parity with pons matters.

### Create page (`/launchpad/create`)

Confirmed fields, in order:

| Field | Notes |
|---|---|
| Name | text |
| Ticker | text |
| Description | textarea |
| Token image | "Choose image" upload |
| X profile | `x.com/…` |
| Telegram | `t.me/…` |
| Paired asset | selector, defaults ETH |
| Developer buy | ETH amount |
| Trade fee | read-only display, populated after config load |
| **Holder fee sharing** | toggle — "Route this launch's creator fees to its holders, distributed pro-rata and pushed to their wallets" |
| Creator wallet | optional, "Leave blank to use your connected wallet" |
| Creator tax | percent input, "Traders pay 0.00% in total, up to 10% of it yours" |
| Snipe tax exemptions | section (v2's exemption list, see above) |

Summary strip: **Launch fee 0.0005 ETH · Paired with ETH · Graduation —
· Liquidity: Locked**. Primary action is **Connect wallet** until a wallet is
attached, then presumably **Launch**. No name/decimals/supply fields beyond
name+ticker — **supply is fixed and picked implicitly by which launch config /
protocol is chosen**, not typed by the user. This matches the local repo's
`launchConfigs` model exactly (`LaunchForm.jsx:319-329` — supply, curve fee,
graduation threshold all come from a numbered, pre-approved config the user
picks, not free-typed).

### Token trade page (`/launchpad/{token}`)

Confirmed from a live example (`…/0xe2433b514f09e58ebfa3bedc9d46a6e5e43e820c`,
"PEEPS"):

- Trade widget: **Market / Limit / Orders** tabs (Limit/Orders may be
  disabled/future — v1 pools do support arbitrary limit orders in principle
  since they're a real Uniswap V3 pool, unlike a bonding curve) and a
  **Sell** tab; amount input denominated in ETH with **25/50/75/100%**
  quick-select, a **Slippage: 1% (Adjust)** control, and **Buy** /
  **Connect wallet** buttons.
- Token/pool identity: icon, name + symbol, **pool address** shown (not the
  token address — `0x260aB456bBADd9F8f8D80cF72Fdc911B42293C6d`), and outbound
  links to **X, Telegram, Dexscreener, GeckoTerminal**. Notably: pons **links
  out to Dexscreener/GeckoTerminal** rather than necessarily owning the
  candlestick chart itself — worth deciding explicitly whether our clone
  builds its own chart (recommended, see §6.3) or also defers to a partner
  chart embed for v1.
- **Recent trades** section (async, "Loading trades" placeholder confirmed).
- **Holders** tab/count.

---

## 2. Category conventions (pump.fun-style launchpads generally)

Beyond pons specifically, the wider memecoin-launchpad genre (pump.fun and its
many forks/clones) converges on a small set of UI conventions worth adopting
because users already have muscle memory for them:

- **Explore grid/list toggle**, tabs for **New / Graduating soon / Graduated**
  (or a single sortable table with a graduation-progress column instead of
  three tabs — both patterns are common).
- A **bonding-curve progress bar** per row and on the token page itself (% of
  the graduation threshold raised), since that number is the entire narrative
  arc of a pre-graduation token.
- **Dev/creator holding %** and **top-10-holder %** surfaced prominently as a
  rug/safety signal, often color-coded.
- Per-row **age** ("3m", "2h", "5d") rather than a timestamp — recency is a
  first-class sort key in this category, hence pons's own "Newest/Oldest"
  filter.
- Trade page nearly always: chart on top/left, buy/sell panel on top/right or
  as a sticky sidebar, token info + description + socials below the chart,
  holders table and recent-trades table as tabs or stacked sections beneath.
- Buy/sell almost always defaults the **input token** (ETH/SOL/base asset) and
  lets the user flip to size by the **output token**, with percentage
  shortcuts against the connected wallet's balance — exactly what pons does.

These are treated as defaults to deviate from deliberately, not requirements.

---

## 3. Reusable patterns from `pons-launcher/frontend`

This repo is a **bundler/operator console**, not the trading site, and it
signs with server-held keys (`frontend/src/api.js:1-71` — API key in
`sessionStorage`, all "money" calls are `fetch('/api/...')`, never a wallet
signature). That whole model is **inverted** for the actual launchpad (client
wallet signs everything), so treat the backend-signing plumbing as
non-transferable. What *does* transfer, as concrete, load-bearing patterns:

- **IPFS logo upload flow** (`frontend/src/components/LogoField.jsx:1-123`):
  accept list `image/png|jpeg|webp|gif`, 5 MB ceiling, a **mandatory
  confirmation checkbox** ("I understand that selected artwork will be
  moderated and uploaded to public IPFS") gating the file picker, immediate
  local preview via `URL.createObjectURL`, upload-in-flight disables the arm
  switch elsewhere on the page (`onUploading` callback,
  `LaunchForm.jsx:240` `ready = ... && !uploading`), and a failed upload
  clears both the value and the thumbnail together so the two never go out of
  sync (`LogoField.jsx:50-55`). This is the right shape for our Create page's
  logo field, backed by whatever pinning service we choose (see §5).
- **Config-driven launch, not free-typed supply** (`LaunchForm.jsx:319-423`):
  the form fetches `launchConfigs`/`dexConfigs` from the factory (or an API
  mirroring it) and renders them as a picker; each config's enforced rules
  (max wallet %, restriction blocks, curve fee, graduation threshold) are
  echoed back to the user as a "What config #N enforces" notice **before**
  they commit. This is good UX for exactly the reason pons's own create page
  has no free-typed supply field either — supply/curve/fee are protocol
  policy, not user input.
- **Two-step commit for anything irreversible**: a disabled "arm" switch that
  must be explicitly flipped before a spend button is enabled, then a
  **confirmation modal** that freezes the exact request body at the moment it
  opened (`LaunchForm.jsx:74`, `208-225`, `488-527`) so nothing recomputed
  between "review" and "confirm" can drift from what's shown. The modal's
  danger styling and copy change per irreversibility (`live` vs dry-run,
  `Modal danger={live}`). Directly applicable to both **Launch** and
  **Sell**, and worth extending to **first-time swap approval** on the trade
  page.
- **Optimistic-but-honest busy states**: a named `busy` string (not just a
  boolean) so multiple buttons in the same panel can each show their own
  spinner without racing each other (`LaunchForm.jsx:67`, `195-204`).
- **A single global toast bus** (`api.js:43-53`, `Toaster.jsx`): a
  `CustomEvent` (`pons:notice`) any module can dispatch, one listener renders
  it. Simple, framework-agnostic, and avoids prop-drilling a notify function
  through every panel — worth keeping even inside React/Next, or replacing
  with a toast library that offers the same "dispatch from anywhere" shape
  (e.g. `sonner`).
- **Per-role wallet scanning via a `variant`/`roles` indirection**
  (`frontend/src/variant.js`, `v3/roles.js`, `v4/roles.js`) — not directly
  relevant to a public trading site (no wallet roles there), but the *pattern*
  of "each protocol version/tab owns its own module tree, imports shared
  chrome only, never edits another version's files" (spelled out at length in
  `docs/superpowers/plans/2026-08-17-v3-relay-chain.md:35-104`, "THE
  ISOLATION RULE") is worth carrying into how we structure **v1-pool-style
  tokens vs v2-bonding-curve tokens** in the new frontend: one Trade page
  component that branches early into two rendering/data paths, not a single
  component with `if (isV2)` sprinkled through shared logic that both must
  stay correct for.
- **Format helpers as one shared module** (`frontend/src/format.js`,
  `shortAddress`) — small, but worth just copying the idea: one place that
  defines how an address, a token amount, and a small ETH price are ever
  displayed, imported everywhere, so "8+4 chars" or "8 decimal places" is a
  single constant instead of a convention re-invented per component.

None of `App.jsx`'s tab-switching/six-step-sequence machinery
(`frontend/src/App.jsx`, `components/Sequence.jsx`, `components/Step.jsx`)
transfers directly — that's a *procedure* UI (do these 6 things in order to
fire a bundle), and a public launchpad is a *destination* UI (explore, then
jump to any token, then trade) — but the **step-state-lifted-to-parent**
pattern (`onDraft`, `onSizing` callbacks pushing child form state up so a
persistent header can render "what's missing," `LaunchForm.jsx:96-124`) is a
clean answer for the Create page's own "what do you still need before you can
launch" affordance.

---

## 4. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15+, App Router** | Server components for the Explore list's initial paint (SEO + fast TTFB on a data-heavy page), route handlers as a thin BFF in front of the indexer, `next/image` for logos, file-based routing matching the `/launchpad/{token}` shape directly. |
| Chain layer | **viem** | Already the tool pons's own docs use for indexing/reads; typed, tree-shakeable, no async-provider ceremony. |
| React chain hooks | **wagmi v2** (viem-based) + **TanStack Query v5** | Wallet state, `useReadContract`/`useReadContracts` (multicall) for batched on-chain reads, `useWriteContract` + `useWaitForTransactionReceipt` for the two irreversible actions (launch, swap), query caching/retry for anything polled (pool price, quote). |
| Wallet connect UI | **RainbowKit** (default) with a **Privy** option flagged for later | RainbowKit ships a cohesive, fast-to-integrate modal on top of wagmi and is the closest match to "connect wallet" being a one-line CTA the way pons's own site treats it. Privy is worth a follow-up decision only if onboarding non-crypto-native users (embedded wallet, email/social login) becomes a goal — not needed for parity with pons, which is wallet-only. |
| Charting | **lightweight-charts v5** (TradingView) | Purpose-built candlestick/line charts, tiny (~45 KB), MIT-ish license, the de-facto default for this exact use case. v5's API is `chart.addSeries(CandlestickSeries, {...})` (breaking change from v4's `addCandlestickSeries()` — pin the major version and follow the v4→v5 migration guide if templating off older examples). Wrap it in one thin React component (`useRef` + `useEffect` init, imperative `setData`/`update` calls) rather than pulling in a heavier React-charts abstraction. |
| Styling | **Tailwind CSS** (+ shadcn/ui or Radix primitives for modal/dropdown/tabs) | Fast to theme, easy to keep the "danger vs. safe" color convention from the local repo's `styles.css` consistent (irreversible actions get one committed color, everywhere, no exceptions). |
| Indexer | **Custom lightweight indexer** (Ponder, or a hand-rolled viem log-watcher + Postgres) reading `TokenLaunched`/`Swap`/`Transfer` events from both factories | Required for anything the Explore page needs (sort by volume/market cap/age across *all* tokens, recent-trades history, holder counts) — a single RPC node cannot answer "top 50 tokens by 24h volume" on demand. Ponder is purpose-built for exactly this (typed event handlers → Postgres → GraphQL/REST) and matches the "index `TokenLaunched` and `Swap`" guidance in pons's own integration docs almost verbatim. |
| IPFS pinning | A pinning service behind a small API route (Pinata, web3.storage, or a self-hosted equivalent to the `PONS_IPFS_UPLOAD_URL` proxy the local repo talks to, `pons-launcher/README.md:135`) | Never pin directly from the browser with a secret API key embedded in it — proxy through a Next.js route handler the way the local console proxies through its Express backend (`frontend/src/api.js:106-115`, `uploadLogo`). |
| State/forms | React Hook Form + Zod for the Create form | Matches the config-driven-validation shape in §3 (client validates against live-fetched factory config, not hardcoded limits). |

---

## 5. Data flow: indexer API vs. direct contract reads

Two different needs, two different sources — do not force one to serve both:

**Use direct contract reads (viem/wagmi, no indexer) for:**
- A single token's *current* state on its own trade page: pool `slot0` /
  curve reserves for live price, `totalSupply`, `balanceOf` for the connected
  wallet, `name()`/`symbol()`/`decimals()`/on-chain metadata URI, graduation
  threshold vs. raised amount, restriction-window status. These are cheap,
  small, and must be *live* (poll every few seconds via
  `useReadContracts` + a short `refetchInterval`, or subscribe to the pool's
  `Swap`/curve's buy/sell events over a websocket provider for push updates).
- The **quote** step of a trade (QuoterV2 `quoteExactInputSingle`/
  `quoteExactOutputSingle` — see §6.3) — must reflect the current block, never
  a cached/indexed number.
- The **write** itself (`useWriteContract` calling the factory's
  `launchToken`, the curve's `buy`/`sell`, or the router's
  `exactInputSingle`) — always direct, always through the connected wallet.

**Use the indexer API for:**
- The **Explore** table: sort/filter across every token by volume, market cap,
  age, holder count, graduation %, protocol version — this is fundamentally a
  query over historical event data, not something an RPC node answers.
- **Recent trades** and **candlestick history** on the trade page — OHLCV
  bars are built by the indexer aggregating `Swap` events into buckets;
  "recent trades" is a paginated read of the same event table.
- **Holders list** — either the indexer maintains running balances from
  `Transfer` events, or (simpler, slower) it's fetched from a
  block-explorer-style API if the chain provides one.
- Search (`⌘K`) — name/symbol/address lookup across all launched tokens.

The trade page is therefore a **hybrid**: chart history + recent trades +
holders come from the indexer API (fast, cheap, works even under RPC rate
limits — see the project's own `relay-rate-limit.md` memory note on how
punishing a chain's rate limits can get), while price-you're-about-to-pay and
the buy/sell transaction itself are always direct-from-chain, never trusted
from the indexer, so a stale index can never cause a bad fill.

Architecture: Next.js route handlers (`/api/tokens`, `/api/tokens/[addr]`,
`/api/tokens/[addr]/trades`, `/api/tokens/[addr]/candles`) sit in front of the
indexer's Postgres/GraphQL, giving the frontend one same-origin API surface
(mirroring the local repo's "one origin, no CORS" deploy shape,
`pons-launcher/README.md:81-84`) and a place to add caching/rate-limiting
independent of the indexer's own service.

---

## 6. Page-by-page design

### 6.1 Explore / Trending (`/`)

- **Tabs or a single filter row**: New · Graduating · Graduated (or a
  graduation-%-sortable column instead of tabs — decide based on how visually
  busy the table already is), plus pons's own confirmed **protocol filter**
  (Both/v1/v2 — call it "Curve" vs "Pool" or similar if we want plainer
  language) and **time window** (24h/7d/All).
- **Sort**: Newest, Trending/volume, Market cap, Recent buys (pons's own
  default), % graduated.
- **Columns**: logo+name+symbol, price, market cap, 24h volume, 24h change %,
  holders, age, a graduation progress bar (curve tokens only — pool tokens
  from v1 don't have one, per docs), protocol badge.
- Server component fetches the first page for fast paint; client takes over
  for live sort/filter and periodic refresh (TanStack Query, `refetchInterval`
  in the 10-30s range — this is a list, not a livestream, no need for a
  websocket here).
- Row click → `/token/[address]`.

### 6.2 Launch / Create (`/create`)

Fields (per §1's confirmed pons form, adapted):

- Name, Symbol/Ticker, Description
- Logo upload (LogoField pattern from §3: accept list, size cap, moderation
  checkbox gate, immediate preview, upload-blocks-submit)
- Socials: X, Telegram, (Discord/Website/Farcaster optional, per the local
  repo's fuller set, `LaunchForm.jsx:286-301` — pons's live form only
  confirmed X + Telegram, but the richer set costs nothing and several
  aggregator sites read all of them)
- **Launch config picker** (protocol/curve variant, if offering more than
  one), each rendering its own enforced rules live (config-driven, §3)
- Paired asset (display-only if only ETH is ever offered)
- Dev buy amount (ETH)
- Creator fee wallet (optional, defaults to connected wallet)
- Creator tax / fee split (bounded by the live-fetched factory max, never a
  hardcoded client-side ceiling)
- Holder fee-sharing toggle (if the target protocol version supports it)
- Read-only summary strip: launch fee, paired asset, graduation threshold
- **Connect wallet** gates everything until present; **Launch** is the
  irreversible action and gets the arm-switch + confirm-modal treatment from
  §3, showing the exact predicted token address (if the factory exposes a
  `predict...Address`-style call, as pons v2's does) before commit.
- On submit: upload logo → get IPFS URI → build `launchToken(...)` calldata →
  `useWriteContract` with `value = launchFee + devBuyEth` → wait for receipt →
  redirect to the new token's trade page.

### 6.3 Token / Trade page (`/token/[address]`)

Layout: chart + trade panel above the fold, info/holders/trades below.

- **Chart** (lightweight-charts): candlesticks built from the indexer's OHLCV
  endpoint, timeframe selector (1m/5m/1h/1d), live-updating last candle from
  either a short poll or a websocket subscription to new `Swap` events.
- **Buy/Sell panel**: tabs, amount input denominated in the base asset with
  25/50/75/100%-of-balance shortcuts (matches pons's confirmed widget,
  §1), a slippage control (default ~1%, adjustable), and the two irreversible
  actions:
  - **Quote**: on every input change (debounced), call the on-chain quoter —
    for a graduated/v1 pool token this is Uniswap V3's `QuoterV2.
    quoteExactInputSingle({tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96:
    0n})` via a `staticCall`/`eth_call` (QuoterV2 is *not* a view function — it
    reverts internally and decodes the revert data, so it must be invoked as a
    simulated call, never trusted as a plain read that always succeeds); for a
    pre-graduation bonding-curve token, quote against the curve's own
    constant-product math directly (no Uniswap contract exists yet).
  - **Swap**: build `minAmountOut` from the fresh quote times
    `(1 - slippageBps/10000)` — never 0, never derived from a stale quote —
    and call `SwapRouter02.exactInputSingle({...})` through
    `useWriteContract`, or the curve's own `buy`/`sell` pre-graduation. First
    trade of an ERC-20 needs an `approve` (for sells and for any input token
    that isn't the native asset); check `allowance` first and only prompt for
    approval when it's insufficient, exactly the "approve exactly the amount
    being sold, every time" discipline the local repo's V3 module documents
    (`docs/superpowers/plans/2026-08-17-v3-relay-chain.md:259-267`) — it costs
    one extra transaction but leaves no standing allowance behind.
  - Post-graduation vs pre-graduation is a **branch at the page level**, not a
    shared code path with conditionals threaded through (§3's isolation
    lesson) — a curve-trading component and a pool-trading component, sharing
    only the chart and the info panel.
  - Surface the restriction window / opening-tax state plainly when active
    (pons v2's snipe tax and v1's launch-block restriction both change what a
    buy actually nets the user) rather than letting a trade silently return
    less than the quote implied.
- **Info panel**: logo, name, symbol, contract + pool address, description,
  social icons (out-link, matching pons's X/Telegram/Dexscreener/GeckoTerminal
  set — worth keeping the "link to a third-party chart" convention as a
  secondary affordance even if we own our own chart, since traders already
  expect it), supply, market cap, creator address + fee split, graduation
  progress (curve tokens) or "graduated — trading is in the Uniswap V3 pool"
  status line (pool tokens).
- **Holders** tab: indexer-backed table, address, balance, % of supply,
  top-10 concentration called out.
- **Recent trades** tab: indexer-backed table, time, side (buy/sell), amount,
  price, trader address, tx link.

### 6.4 Wallet connect + portfolio (`/portfolio` or a header dropdown)

- Header: RainbowKit's connect button (address/ENS-or-truncated-address,
  balance, chain indicator, disconnect).
- Portfolio page: every token the connected wallet holds that this launchpad
  indexes (join the indexer's `Transfer`-derived balances against the
  wallet's address), current value, unrealized P/L if cost basis is tracked,
  a per-holding "launched by you" badge (useful for a creator checking their
  own fee-eligible launches — mirrors pons's own `/profile`), and quick
  links into each token's trade page. This is entirely indexer-backed (no
  practical way to enumerate "every token this address holds" from raw RPC
  without an index), with a manual "add token by address" fallback for
  anything the indexer hasn't backfilled yet.

---

## 7. Contrast: this repo's trust model vs. the launchpad's

Worth stating explicitly since it's easy to blur: `pons-launcher` is a tool
that *drives* pons's factory on behalf of an operator who has handed the tool
their private keys (encrypted keystore, `KEYSTORE_PASSPHRASE`,
`pons-launcher/README.md:281-304`). It calls the same `PonsLaunchFactory` the
public site calls, but every transaction is signed server-side and never
touches a browser wallet. That is the right model for a bundler/automation
tool and the wrong model for the launchpad frontend itself, which must be
non-custodial like pons's own site — wagmi/viem in the browser, wallet
extension or WalletConnect signs, nothing resembling an API key that can move
funds. Keep this boundary sharp when reusing code: the *UI conventions*
(§3) cross over cleanly; the *money-moving plumbing* (`api.js`'s
`x-api-key`-gated fetch layer) must not.

---

## 8. Open questions for the design phase

1. **Chart ownership**: build our own candlestick chart from indexed swaps
   (recommended, gives full control over timeframe/branding) or, like pons
   itself appears to partly do, lean on an out-link to Dexscreener/
   GeckoTerminal for the heavy analytical view and keep an in-house chart
   minimal? Pons's own trade page links to both but its own chart's depth
   wasn't confirmed by static fetch.
   Sources: [PEEPS trade page](https://www.ponsfamily.com/launchpad/0xe2433b514f09e58ebfa3bedc9d46a6e5e43e820c)
2. **One protocol variant or two**: does the new launchpad offer both a
   straight-to-Uniswap-V3-pool launch (v1-style, simpler, no graduation drama)
   and a bonding-curve-then-graduate launch (v2-style, more of the genre's
   expected mechanic)? This materially changes the Create form (config
   picker vs. none) and the Trade page (branch at all vs. single code path).
3. **Indexer build-vs-buy**: Ponder/Envio self-hosted vs. an existing
   block-explorer/Dune-style API (pons's own `/analytics` runs on Dune) — a
   build decision, not a research one, but worth flagging that pons's
   protocol docs explicitly say no off-chain API is *required*, meaning a
   minimal-viable version of this product could ship Explore/trades/candles
   reading live off an archive-node's logs before investing in a full indexer.
4. **Wallet kit**: RainbowKit vs. ConnectKit vs. Privy — recommended
   RainbowKit for parity with a crypto-native, wallet-first audience matching
   pons's own "connect wallet" pattern; revisit only if onboarding
   non-crypto-native users becomes a stated goal.

---

## Sources

- [Explore · pons](https://www.ponsfamily.com/launchpad)
- [Launch a token · pons](https://www.ponsfamily.com/launchpad/create)
- [Peeps - Buy token · pons](https://www.ponsfamily.com/launchpad/0xe2433b514f09e58ebfa3bedc9d46a6e5e43e820c) (example trade page)
- [pons docs](https://docs.ponsfamily.com/) (protocol mechanics, integration guidance, redirects to `ponsfamily.com/integration`)
- `d:\projects\pons-launcher\README.md` (factory addresses, fees, v1/v2 mechanics as verified on-chain 2026-07-25)
- `d:\projects\pons-launcher\frontend\src\components\LaunchForm.jsx`
- `d:\projects\pons-launcher\frontend\src\components\LogoField.jsx`
- `d:\projects\pons-launcher\frontend\src\api.js`
- `d:\projects\pons-launcher\frontend\src\components\SellPanel.jsx`
- `d:\projects\pons-launcher\frontend\src\components\ActivityPanel.jsx`
- `d:\projects\pons-launcher\frontend\src\App.jsx`
- `d:\projects\pons-launcher\docs\superpowers\plans\2026-08-17-v3-relay-chain.md` (isolation-by-module pattern; Relay/quote validation discipline)
- [Uniswap docs — Getting a Quote (QuoterV2)](https://docs.uniswap.org/sdk/v3/guides/swaps/quoting)
- [Uniswap `IQuoterV2` reference](https://docs.uniswap.org/contracts/v3/reference/periphery/interfaces/IQuoterV2)
- [`SwapRouter02.sol`](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/SwapRouter02.sol)
- [Lightweight Charts — from v4 to v5 migration](https://tradingview.github.io/lightweight-charts/docs/migrations/from-v4-to-v5)
- [Lightweight Charts — Series types](https://tradingview.github.io/lightweight-charts/docs/series-types)
- wagmi v2 / viem v2 / TanStack Query v5 as the 2026 standard React web3 stack (general web search, multiple corroborating sources)
- RainbowKit vs ConnectKit vs Privy comparisons (general web search, multiple corroborating sources)
