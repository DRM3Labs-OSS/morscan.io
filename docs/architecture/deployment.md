# Deployment

MorScan is a single Cloudflare Worker plus D1, KV, an optional R2 bucket, and a
Durable Object. This is the operator's guide to standing up your own instance.

For a copy-paste, zero-to-running walkthrough see
[`../GETTING_STARTED.md`](../GETTING_STARTED.md). This file is the reference for
the moving parts.

## Secrets model

Three distinct secrets, never overloaded:

- `MORSCAN_JWT_SECRET` - random (`openssl rand -hex 32`), signs UI session JWTs
  only. **Required for sign-in:** session creation throws if it is unset (no
  default = no auth bypass).
- `MORSCAN_MNEMONIC` - a **real BIP39 mnemonic** (12/24 words), used for
  provenance signing only. `Keyring.fromMnemonic()` derives the `morscan/cache`
  and `morscan/signer` keys; `src/utils/snapshot.ts` signs the CDN snapshot with
  it. Never `openssl rand`. Optional - signing/snapshots no-op when it is unset.
- `MORSCAN_DEMO_KEY` - optional serving key injected into the public explorer
  pages (`window.MORSCAN_API_KEY`) so the page scripts can call the metered API.
  Per-IP rate limits still apply to every client. A Worker secret, never in git.

## Quick redeploy (existing installation)

```bash
npm install
npx wrangler deploy
```

## Fresh deploy (from scratch)

```bash
# 1. Create the D1 database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create morscan

# 2. Create the KV namespaces, paste each printed id into wrangler.toml
npx wrangler kv namespace create NONCE_CACHE
npx wrangler kv namespace create MORSCAN_CACHE

# 3. Set your account_id and the ids above in wrangler.toml.

# 4. Apply the schema (all tables + indexes, from schema.sql at the repo root).
#    This must run before the first deploy - the worker does not create its own
#    tables (except two small auxiliary ones).
npx wrangler d1 execute morscan --remote --file=./schema.sql

# 5. Set the required secret (sign-in fails without it):
openssl rand -hex 32 | npx wrangler secret put MORSCAN_JWT_SECRET

#    Optional secrets:
printf '%s' "<real BIP39 mnemonic>" | npx wrangler secret put MORSCAN_MNEMONIC      # provenance signing
printf '%s' "mor_$(openssl rand -hex 16)" | npx wrangler secret put MORSCAN_DEMO_KEY  # UI serving key

# 6. Insert an admin API key. Generate your own; this row is the admin identity
#    used to call the gated /sync/* routes. created_at is NOT NULL - include it.
KEY="mor_admin_$(openssl rand -hex 16)"
echo "Admin key: $KEY"   # save it
npx wrangler d1 execute morscan --remote \
  --command="INSERT INTO api_keys (id, key, name, rate_limit, created_at) VALUES ('admin', '$KEY', 'Admin', 1000000, $(date +%s));"

# 7. Deploy the Worker
npx wrangler deploy

# 8. Seed history from the published snapshot (optional, avoids hours of cold
#    re-sync). See ../SEED.md for this and the from-scratch path.
DATASET_DIR=/path/to/morpheus-ai-base-data \
BLOB=/path/to/morpheus-ai-base-data-<block>.sql.gz \
TARGET_DB=morscan WRANGLER_CONFIG=wrangler.deploy.toml \
node scripts/import-seed.mjs

# 9. Start the sync loop (or just wait - the Durable Object auto-starts)
curl "$PUBLIC_BASE_URL/sync/coordinator/start" -H "X-Morscan-Key: $KEY"
```

> **Schema note:** [`schema.sql`](../../schema.sql) at the repo root is the
> canonical DDL (27 tables). Only two auxiliary tables (`wallet_stats`,
> `diamond_upgrades`) are also created in code on first sync
> (`src/sync/compute-stats.ts`); everything else must exist before the worker
> writes to it. A fresh deploy works with no seed at all - incremental sync
> backfills from the chain, just slowly. To seed instead, import the published
> snapshot (see [`../SEED.md`](../SEED.md)). The `seed/` directory holds
> the recommended indexes (`indexes.sql`) and the BigQuery archive schema
> (`bq-schema.sql`).

## Environment

### `[vars]` (non-secret, in `wrangler.toml`)

| Var | Default / Example |
|-----|-------------------|
| `DIAMOND_ADDRESS` | `0x6aBE1d282f72B474E54527D93b979A4f64d3030a` (Morpheus Diamond, Base mainnet) |
| `RPC_URL` | `https://base.llamarpc.com` (any Base L2 RPC) |
| `BUILDER_CONTRACT` | `0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9` (BuildersV4 proxy, Base) |
| `PUBLIC_BASE_URL` | Your deployed origin, e.g. `https://morscan.example.com` |
| `SNAPSHOT_PUBLIC_HOST` | Public host fronting the R2 snapshot bucket. |
| `SNAPSHOT_SIGNER_KEY_ID` | Key id advertised in the signed snapshot envelope. |
| `BIGQUERY_ENABLED` / `BIGQUERY_PROJECT_ID` / `BIGQUERY_DATASET_ID` | Optional BigQuery archive (off by default). |

### Secrets (`wrangler secret put <NAME>`)

| Secret | Purpose |
|--------|---------|
| `MORSCAN_JWT_SECRET` | **Required.** Random UI-session HMAC secret. Sign-in throws if unset. |
| `MORSCAN_MNEMONIC` | Optional. Real BIP39 mnemonic for provenance signing (`morscan/cache`, `morscan/signer`). Never `openssl rand`. |
| `MORSCAN_DEMO_KEY` | Optional. Serving key embedded in the public UI pages. `mor_<hex>`. |
| `MORSCAN_ADMIN_KEY_IDS` | Optional. Comma-separated `api_keys` ids granted admin bypass for `/sync/*`, `/mor/v1/bq/*`, `/admin/*` (`isAdminAuth`). A wallet key id like `wallet:0xYourAddr`. The `admin` key is always an admin; this only adds more. |
| `ALCHEMY_FALLBACK_URL` | Optional. Alchemy RPC URL used by the sync loop as a last-resort fallback. |
| `BIGQUERY_SERVICE_ACCOUNT_KEY` | Only if BigQuery is enabled. Base64 service-account JSON. |

## Contracts (Base Mainnet)

These are public on-chain addresses the explorer indexes.

| Contract | Address |
|----------|---------|
| Morpheus Diamond | `0x6aBE1d282f72B474E54527D93b979A4f64d3030a` |
| MOR Token | `0x7431aDa8a591C955a994a21710752EF9b882b8e3` |
| BuildersV4 | `0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9` |

## Infrastructure

- **Runtime:** Cloudflare Workers (serverless edge).
- **Database:** Cloudflare D1 (SQLite). `database_id` set per-deployment in `wrangler.toml`.
- **Cache:** two KV namespaces (`NONCE_CACHE`, `MORSCAN_CACHE`) + the CF Cache API.
- **Durable Object:** `SyncCoordinator` runs a 5-second forward-only sync loop:
  `eth_getLogs` over the Diamond and MOR token contracts, projected into D1
  (see [`sync.md`](sync.md)).
- **Cron:** every minute (delta sync + fatboy cache rebuild + wallet-cap refresh),
  every 3 minutes (optional snapshot writer), daily 03:00 UTC (snapshot prune).
- **Storage (optional):** R2 bucket for the signed marketplace snapshot; BigQuery for the analytics archive.
