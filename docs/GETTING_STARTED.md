# Getting Started

This is the copy-paste path from a fresh clone to a running MorScan explorer,
both locally and deployed. It takes about 10 minutes.

MorScan is a single Cloudflare Worker backed by D1 (SQLite), KV, a Durable
Object, and optionally R2 and BigQuery. You will need a (free) Cloudflare
account and Node.js 20+.

## 1. Clone and install

```bash
git clone <your-fork-url> morscan
cd morscan
npm install
```

Verify the toolchain is green before changing anything:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome
npm run build       # wrangler deploy --dry-run (full build, no upload)
```

## 2. Authenticate wrangler

```bash
npx wrangler login
```

Put your Cloudflare account id in `wrangler.toml` (top of the file, add
`account_id = "..."` if it is not picked up automatically). Find it with
`npx wrangler whoami`.

## 3. Create the database and caches

```bash
# D1 database
npx wrangler d1 create morscan
#   → copy the printed database_id into wrangler.toml ([[d1_databases]].database_id)

# KV namespaces
npx wrangler kv namespace create NONCE_CACHE
#   → copy the printed id into wrangler.toml ([[kv_namespaces]] NONCE_CACHE)
npx wrangler kv namespace create MORSCAN_CACHE
#   → copy the printed id into wrangler.toml ([[kv_namespaces]] MORSCAN_CACHE)
```

The shipped `wrangler.toml` has placeholder ids (`0000...`); replace them with
the real ids printed above.

Then apply the schema (all 27 tables + indexes, from [`schema.sql`](../schema.sql)
at the repo root):

```bash
npx wrangler d1 execute morscan --remote --file=./schema.sql
```

This must run before the first deploy - the worker does not create its own
tables (except two small auxiliary ones).

## 4. Configure `wrangler.toml`

The `[vars]` block ships with working defaults. The two you most likely want to
set for your own deployment:

| Var | Set it to |
|-----|-----------|
| `PUBLIC_BASE_URL` | Your deployed origin, e.g. `https://morscan.<you>.workers.dev`. Used for OG tags, the OpenAPI server URL, sitemap, `llms.txt`, and provenance `content_uri`. |
| `RPC_URL` | Any Base L2 RPC. The default (`base.llamarpc.com`) is a free public endpoint that rate-limits and has outages; the rpc-pool fails over to other public Base endpoints automatically, but a dedicated provider is recommended for production. |

Everything else (`DIAMOND_ADDRESS`, `BUILDER_CONTRACT`) points at the live
Morpheus contracts on Base mainnet and should be left alone unless you are
indexing a different deployment.

### Full env-var reference

**`[vars]` (non-secret, committed in `wrangler.toml`):**

| Var | Required | Purpose |
|-----|----------|---------|
| `DIAMOND_ADDRESS` | yes | Morpheus Diamond contract (Base mainnet). |
| `RPC_URL` | yes | Primary Base RPC endpoint. |
| `BUILDER_CONTRACT` | yes | BuildersV4 proxy (Base). |
| `PUBLIC_BASE_URL` | recommended | Your deployed origin (no trailing slash). |
| `LOCK_WORKERS_DEV` | no | `true` restricts the `*.workers.dev` origin to admin-key API calls only (no UI). Default: open, so the copy-paste path below just works. |
| `COMING_SOON_HOSTS` | no | Comma-separated hostnames that serve a static coming-soon page instead of the UI (`/health` + brand assets stay live). |
| `REGISTER_URL` | no | Where the signup / upgrade link on the access-tier cards points. Default `/about`. |
| `SSO_APP_ID` | no | Audience id for IdP launch tokens. Default `morscan`. |
| `SSO_HUB_URL` | no | IdP hub origin the sign-in button bounces through. |
| `SSO_LAUNCH_URL` | no | Full launch URL for the "Sign in with <IdP>" button. Unset hides the button. |
| `IDP_NAME` | no | Display name of the IdP on the sign-in button. |
| `SNAPSHOT_PUBLIC_HOST` | no | Public host fronting the optional R2 snapshot bucket. |
| `SNAPSHOT_SIGNER_KEY_ID` | no | Key id stamped into the signed snapshot envelope. |
| `BIGQUERY_ENABLED` | no | `true` to enable the optional BigQuery archive. Default `false`. |
| `BIGQUERY_PROJECT_ID` / `BIGQUERY_DATASET_ID` | no | Only if BigQuery is enabled. |
| `PROVENANCE_ENABLED` | no | Default `true`. Set `false` to run unsigned: no receipt fields on responses, `/version` reports `provenance: "disabled"`, and the `@drm3labs-oss/provenance` WASM is never initialized. |
| `RPC_POOL_ENABLED` | no | Default `true`. Set `false` to replace the `@drm3labs-oss/rpc-pool` failover pool with a plain `fetch` POST to `RPC_URL` (simple retry, no WASM). |

**Secrets (`wrangler secret put <NAME>`, never committed):**

| Secret | Required | Purpose |
|--------|----------|---------|
| `MORSCAN_JWT_SECRET` | yes (for the UI) | HMAC secret signing dashboard session cookies. `openssl rand -hex 32`. Login throws if unset - no default means no auth bypass. |
| `MORSCAN_MNEMONIC` | no | A real BIP39 mnemonic (12/24 words) for Ed25519 provenance/snapshot signing. Signing and snapshots no-op when unset. **Not** random hex. |
| `MORSCAN_DEMO_KEY` | no | Full-access demo key embedded in the UI's "Use Demo Key" button. |
| `SSO_APP_KEY` | no | This app's derived IdP launch key, for optional single-sign-on. Unset = IdP sign-in disabled (wallet + API-key sign-in are unaffected). |
| `ALCHEMY_FALLBACK_URL` | no | Alchemy RPC URL used by the sync projector as a last-resort fallback. |
| `BIGQUERY_SERVICE_ACCOUNT_KEY` | no | Base64 service-account JSON. Only if BigQuery is enabled. |
| `ALERT_TELEGRAM_BOT_TOKEN` | no | Telegram bot token from @BotFather. Needs `ALERT_TELEGRAM_CHAT_ID` too. See "Alerting" below. |
| `ALERT_TELEGRAM_CHAT_ID` | no | Target Telegram chat / channel id for alerts. |
| `ALERT_SLACK_WEBHOOK_URL` | no | Slack Incoming Webhook URL. Alerts POST `{ text }`. |
| `ALERT_DISCORD_WEBHOOK_URL` | no | Discord webhook URL. Alerts POST `{ content }`. |
| `ALERT_WEBHOOK_URL` | no | Generic webhook. Receives the full JSON `{ level, kind, message, ts, host }`. |
| `ALERT_SYNC_STALL_SECONDS` | no | Stall threshold override (default `120`). Can be a plain `[vars]` value or a secret. |

For local development, copy `.env.example` to `.env` and fill in the secrets;
`wrangler dev` reads it. **Never commit `.env`.**

## 5. Run locally

```bash
cp .env.example .env        # then set MORSCAN_JWT_SECRET at minimum
openssl rand -hex 32        # paste into MORSCAN_JWT_SECRET in .env
npm run dev                 # wrangler dev
```

Open the printed `http://localhost:8787`. The login page renders immediately.
There is no data yet - the next step indexes it.

## 6. Set secrets for a deployed instance

When you are ready to deploy (skip for purely local runs):

```bash
openssl rand -hex 32 | npx wrangler secret put MORSCAN_JWT_SECRET     # required

# optional:
printf '%s' "<real BIP39 mnemonic>"  | npx wrangler secret put MORSCAN_MNEMONIC
printf '%s' "mor_$(openssl rand -hex 16)" | npx wrangler secret put MORSCAN_DEMO_KEY
```

## 7. Create an admin API key

The gated `/sync/*` admin routes need an API key whose `keyId` is the admin
identity. Generate one and insert it into D1:

```bash
KEY="mor_admin_$(openssl rand -hex 16)"
echo "Save this admin key: $KEY"
npx wrangler d1 execute morscan --remote \
  --command="INSERT INTO api_keys (id, key, name, rate_limit, created_at) VALUES ('admin', '$KEY', 'Admin', 1000000, $(date +%s));"
```

> The admin identity is the key **id**, not the key value: `isAdminAuth()`
> accepts the row with `id = 'admin'` (plus any ids listed in the optional
> `MORSCAN_ADMIN_KEY_IDS` var). `created_at` is NOT NULL - include it.

## 8. Deploy

```bash
npx wrangler deploy
```

## 9. Seed and index from chain

```bash
# Optional: seed from the published snapshot so you skip the long cold catch-up.
# It verifies the signed snapshot, loads it, and sets the sync watermark so the
# first sync resumes from the snapshot block. Edits the REMOTE D1. See SEED.md.
DATASET_DIR=/path/to/morpheus-ai-base-data \
BLOB=/path/to/morpheus-ai-base-data-<block>.sql.gz \
TARGET_DB=morscan WRANGLER_CONFIG=wrangler.toml \
node scripts/import-seed.mjs

# Start the 5-second forward-only sync loop. (The Durable Object also
# auto-starts, but this kicks it immediately.)
curl "$PUBLIC_BASE_URL/sync/coordinator/start" -H "X-Morscan-Key: $KEY"
```

Within ~60 seconds, providers, bids, models, and network economics populate.
Because the snapshot sets the sync cursors, the first sync resumes from the
snapshot watermark block instead of re-indexing from chain. If you skip the
seed, sync starts near chain head and history backfills slowly.

The two seeding paths (from scratch, or from the published snapshot) are laid
out in [`SEED.md`](SEED.md). The snapshot itself is a separate signed, CC0
project: [morpheus-ai-base-data](https://github.com/DRM3Labs-OSS/morpheus-ai-base-data).

## 10. View the dashboard

- `https://<your-worker>/` - public landing page with live network stats.
- `https://<your-worker>/compute/providers` - provider leaderboard (read-only, no sign-in).
- `https://<your-worker>/compute/consumers` - consumer wallets and sessions.
- `https://<your-worker>/console` - wallet-first console (connect to mint a free API key).
- `https://<your-worker>/health` - sync status, block heights, counts (no auth).
- `https://<your-worker>/openapi.json` - full API spec; `/api/playground` is interactive.

## Alerting

MorScan watches its own sync loop and records operational alerts (sync stalls,
RPC failures, and self-heal recoveries) to the in-app admin alert area at
**`/admin/alerts`**. This works out of the box with **no configuration** - a
fresh clone records alerts to D1 and shows them on that page.

To also get paged in real time, set any of these (all optional, layer as many
as you want):

| Channel | Env var(s) | How to get it |
|---------|-----------|----------------|
| Telegram | `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID` | In Telegram, message **@BotFather**, `/newbot`, copy the token. Then message your new bot once and open `https://api.telegram.org/bot<TOKEN>/getUpdates` to read your `chat.id` (for a group, add the bot and use the negative group id). |
| Slack | `ALERT_SLACK_WEBHOOK_URL` | Create a Slack app -> Incoming Webhooks -> add to a channel -> copy the webhook URL. |
| Discord | `ALERT_DISCORD_WEBHOOK_URL` | Channel settings -> Integrations -> Webhooks -> New Webhook -> copy the URL. |
| Anything else | `ALERT_WEBHOOK_URL` | Any HTTPS endpoint. It receives the full JSON `{ level, kind, message, ts, host }` - wire it to PagerDuty, Opsgenie, a Worker, etc. |

Set them as secrets (they are credentials), e.g.:

```bash
printf '%s' "<botfather-token>" | npx wrangler secret put ALERT_TELEGRAM_BOT_TOKEN
printf '%s' "<chat-id>"         | npx wrangler secret put ALERT_TELEGRAM_CHAT_ID
```

That is the whole integration - **no code changes.** MorScan detects on a
state transition (it fires once when sync goes stale and once when it recovers,
not every tick), records the alert to `/admin/alerts`, then best-effort fans
out to whichever channels you configured. A failing or unset channel never
blocks the others or the sync loop.

Open `https://<your-worker>/admin/alerts?key=<your-admin-key>` and click
**Send test alert** to verify your wiring end to end.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Login failed` / 500 on `/login` | `MORSCAN_JWT_SECRET` is not set. Set it (`wrangler secret put` for deployed, `.env` for local). |
| Dashboard is empty | Sync has not run. Hit `/sync/coordinator/start` with your admin key, or wait for the DO to auto-start. Check `/health`. |
| `/sync/*` returns 403 | The key you used is not the admin key. Only the admin `keyId` may call sync routes; the demo key is rejected. |
| `D1_ERROR: no such table` | The schema was not applied. Run `npx wrangler d1 execute <db> --remote --file=./schema.sql` (step 3). |
| RPC errors / sync stalls | The default public `RPC_URL` is rate-limited. Point `RPC_URL` at a dedicated Base RPC, optionally set `ALCHEMY_FALLBACK_URL`. |
| `scripts/import-seed.mjs` fails verification | The snapshot did not verify against its own key, or the target D1 is not empty. Re-download the Release asset and seed only a fresh D1. See [`SEED.md`](SEED.md). |
| Provenance receipts are absent | `MORSCAN_MNEMONIC` is unset. Signing no-ops without it; set a real BIP39 mnemonic to enable. |
| Snapshot writer does nothing | The `SNAPSHOT_BUCKET` R2 binding is commented out by default. See [`architecture/marketplace-snapshot.md`](architecture/marketplace-snapshot.md). |

## Next

- [`architecture/deployment.md`](architecture/deployment.md) - the operator reference for every moving part.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) - how MorScan is put together, with links to every subsystem doc.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) - build, test, layout, and conventions.
