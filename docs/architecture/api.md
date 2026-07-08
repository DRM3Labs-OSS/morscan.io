# API Reference

Three caller types (`src/routes/`):

- **Public** - a small allowlist (`src/routes/public.ts`), no auth.
- **Gated `/mor/v1/*`** - `src/routes/api.ts`. SDK clients (wallet-signed
  requests) authenticate with signature headers. Everything else (the explorer
  UI's serving key, personal keys from `/console`, admin) authenticates with an
  `X-Morscan-Key` API key (or `Authorization: Bearer`). Metered endpoints count
  a flat 1 call against the key's per-minute,
  daily, and monthly caps and return `X-RateLimit-*` headers (see
  [`rate-limiting.md`](rate-limiting.md)).
- **Admin** - `/trigger-sync` and `/sync/*` require an API key whose `keyId` is an
  admin id (`admin`, or one listed in `MORSCAN_ADMIN_KEY_IDS`).

The OpenAPI 3.1 spec at `/openapi.json` advertises a curated public subset; the
full route set is below. See [`security.md`](security.md).

## Public (no auth)

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Sync status, block heights, provider/bid/session counts, diamond-upgrade summary (3s edge cache) |
| `GET /teaser` | Public teaser stats for the landing surfaces (rate-limited 30/min per IP) |
| `GET /mor/v1/price` | MOR/USD + ETH/USD, read on-chain (Base DEX pool + Chainlink feed); CoinGecko is a last-resort fallback (60s edge cache) |
| `GET /chart.svg` | Pre-rendered 90-day MOR price chart (SVG) |
| `POST /notify` | Launch-list email capture |
| `GET /openapi.json` (`/openapi`) | OpenAPI 3.1 specification |
| `GET /llms.txt`, `/llms-full.txt` | AI-discovery metadata |
| `GET /robots.txt`, `/sitemap.xml` | Crawl metadata |
| `GET /.well-known/morscan-keys.json` | Ed25519 key discovery (see [`provenance.md`](provenance.md)) |

## Capacity introspection (free, IP-limited)

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/capacity` | The calling key's remaining minute/day/month capacity. Requires a valid key but never spends quota (per-IP limit only) |

## Marketplace (`/mor/v1/*`)

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/all` (alias `/mor/v1/marketplace`) | Full marketplace blob - providers, bids, model names, reputation, economics, history (KV cache 30s; row-signed) |
| `GET /mor/v1/providers` | Provider list with endpoints and stake (row-signed) |
| `GET /mor/v1/providers/:address` | Provider detail - bids, sessions, reputation (CF cache 5m) |
| `GET /mor/v1/bids` | All bids with model names and pricing |
| `GET /mor/v1/pools` | Pool stats |
| `GET /mor/v1/analytics` | Network analytics (KV cache 5m) |
| `GET /mor/v1/price/chart` | 90-day MOR price chart data (KV cache 10m) |

## Sessions & wallets

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/sessions` | All sessions, paginated (`?page=&limit=`; row-signed) |
| `GET /mor/v1/sessions/analytics` | Per-wallet analytics from precomputed `wallet_stats` |
| `GET /mor/v1/sessions/daily` | 30-day session + economics trend |
| `GET /mor/v1/sessions/:wallet` | Sessions for a specific wallet |
| `GET /mor/v1/wallet/:wallet` | Full wallet detail with the `accounting` object (see [`canonical-accounting.md`](canonical-accounting.md)) |
| `GET /mor/v1/wallet/:wallet/audit` | Plaintext four-bucket audit |
| `GET /mor/v1/wallet/:wallet/transactions` | Transaction history |
| `GET /mor/v1/wallet/:wallet/gas` | Gas-cost breakdown |

## Models

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/models` | All registered models with human-readable names (row-signed) |
| `GET /mor/v1/models/lookup` | Model ID → name mapping |
| `GET /mor/v1/models/demand` | Model demand heatmap (KV cache 10m) |
| `GET /mor/v1/models/:modelId` | Specific model detail |
| `POST /mor/v1/models/:modelId` | Set a model name (admin key) |

## Reputation

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/reputation` | All provider reputation scores |
| `GET /mor/v1/reputation/:provider` | Detailed reputation |
| `GET /mor/v1/disputes` | Recent disputed sessions |

## Holders, leaderboard, upgrades

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/holders` | MOR holders ranked by balance (paginated) |
| `GET /mor/v1/holders/dust` | Dust-balance holders |
| `GET /mor/v1/leaderboard` | Top providers and wallets |
| `GET /mor/v1/upgrades` | DiamondCut upgrade history (from `diamond_upgrades`) |

## Builder plane (`/mor/v1/builder/*`)

See [`builder-plane.md`](builder-plane.md).

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/builder/subnets` | All subnets |
| `GET /mor/v1/builder/subnets/:subnetId` | Subnet detail |
| `GET /mor/v1/builder/stakes/:wallet` | A wallet's subnet positions |
| `GET /mor/v1/builder/stats` | Global builder stats |
| `GET /mor/v1/builder/events` | Recent deposit/withdraw/claim events |
| `GET /mor/v1/builder/all` | Builder fatboy blob |

## Provenance & status

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/provenance` | Receipt history, action counts, chain metadata |
| `GET /mor/v1/sync-status` | Sync status detail |
| `GET /mor/v1/ui-init` | Fatboy blob for the SPA (not in OpenAPI) |

## BigQuery admin

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/bq/status` | BigQuery dual-write status |
| `POST /mor/v1/bq/backfill` | BigQuery backfill (admin key) |

## Console & session (`src/routes/auth/`)

| Endpoint | Description |
|----------|-------------|
| `GET /console` | Wallet-first sign-in + API-key management page |
| `GET /console/wallet/challenge` | Mint a single-use sign-in nonce |
| `POST /console/wallet/verify` | Verify the signed challenge; creates the session and a free API key |
| `GET /console/wallet/status`, `POST /console/wallet/disconnect` | Session probe / sign-out |
| `POST /console/key`, `POST /console/key/revoke` | Create/rotate or delete the identity's key |
| `GET /console/usage` | The signed-in key's live usage vs. caps |
| `POST /login` | Key sign-in for returning key holders (issues the session JWT) |
| `GET /login`, `GET /logout` | Redirect to `/console` (with/without clearing the session) |

## Admin sync (`X-Morscan-Key` with an admin keyId)

| Endpoint | Description |
|----------|-------------|
| `GET /trigger-sync` | Run one sync pass |
| `GET /sync/events` | Run one event sync pass |
| `GET /sync/reset-events?block=` | Reset the cursor and resync |
| `GET /sync/backfill-tx` | Backfill missing tx hashes |
| `GET /sync/backfill?from=&to=` | Backfill a historical block range |
| `GET /sync/backfill-holders` | Resumable holder-history re-scan from token deploy |
| `GET /sync/holder-balances?limit=` | Recompute exact balances for the stalest holders |
| `GET /sync/discover-bids` | Discover historical/retracted bids |
| `GET /sync/builder-events` | Run one builder event sync |
| `GET /sync/builder-full` | Full builder state rebuild |
| `GET /sync/coordinator/start` | Start the 5-second sync loop |
| `GET /sync/coordinator/stop` | Stop the loop |
| `GET /sync/coordinator/status` | Loop status + next alarm |
