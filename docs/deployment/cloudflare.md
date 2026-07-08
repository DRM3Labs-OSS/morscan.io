# Cloudflare deployment (as built): morscan.io

Operator doc for the production MorScan zone + Worker. This records how the
live deployment is actually wired so it can be audited or rebuilt from
scratch. It deliberately contains NO account id, NO resource ids, and NO
tokens - those live only in the untracked local `wrangler.deploy.toml` and in
Worker secrets.

## Worker and hostnames

One Worker (`morscan`) serves everything: UI, API, cron sync, Durable Object.

| Hostname | Role |
| --- | --- |
| `morscan.io` | Production apex - the single live, indexable origin (custom domain route) |
| `www.morscan.io/*` | Zone route into the same Worker (canonicalizes to the apex) |
| `staging.morscan.io` | Permanently 301s to `https://morscan.io` (same path + query); handled in `src/index.ts` |
| `*.workers.dev` | Locked down: `LOCK_WORKERS_DEV="true"` restricts it to admin-key API access only (no UI, no demo key) |

Deploy command (from the repo root; the deploy config is local-only and
gitignored):

```bash
npx wrangler deploy --config wrangler.deploy.toml
```

`wrangler.deploy.toml` = the committed `wrangler.toml` template plus the
DRM3-specific values (account id, routes, real D1/KV ids). Never commit it.

## Zone settings the app depends on

- **Edge cache, 30s**: SSR pages set `Cache-Control: public, max-age=30, s-maxage=30`
  and are cached via the Cache API inside the Worker (`cachedPage` in
  `src/routes/ui.ts`). `s-maxage=30` drives the edge window; time-sensitive
  data refreshes every 30s.
- **Browser Cache TTL**: the zone-level Browser Cache TTL setting rewrites the
  outgoing `max-age` on cacheable HTML (observed live: `max-age=14400` while
  `s-maxage=30` stays intact). This is expected; do not "fix" the worker to
  fight it. If browser staleness ever matters, lower the zone setting rather
  than adding cache-busting.
- **AI bots: OFF / allow**: the site is deliberately agent-friendly
  (robots.txt Content-Signals `search=yes,ai-input=yes`, llms.txt, the
  `/.well-known` agent surfaces). Cloudflare's "Block AI bots" / AI Labyrinth
  features MUST stay off for this zone or the agent-ready endpoints are
  self-defeating.
- **DNSSEC: active** (as of 2026-07-06). Enabled in Cloudflare DNS; the DS
  record is published at the GoDaddy registrar, so the chain of trust is live.
- **Edge rate-limit rule**: a zone-level Cloudflare rate-limiting rule caps
  `50 requests / 10s per IP` on `/mor/v1/*`, `/console/*`, and `/capacity`,
  with a `10s` block on breach. This is the edge shield in front of the
  in-worker per-IP/per-key limits: it absorbs floods (e.g. hammering the free
  `/mor/v1/capacity` introspection endpoint) before they reach a Worker
  invocation. Keep it when re-creating the zone; the worker limits are the
  second layer, not a replacement.
- **Plan: Cloudflare Free**. The zone runs on the free plan. The Workers and D1
  free daily limits act as a natural spend ceiling: at the limit the app
  degrades (requests shed) rather than rolling into billed usage. There is no
  paid overage exposure to guard against; the guardrail is the free cap itself.
- **D1 rows-read budget backstop**. The Free plan allows ~5,000,000 D1 rows-read
  per UTC day. A `[vars]` value `D1_DAILY_READ_BUDGET` (default `4000000`) caps
  it below that: the app tracks an APPROXIMATE running rows-read total for the
  day (aggregated in the `MORSCAN_CACHE` KV namespace, key `d1reads:<UTC-date>`),
  and once the day is at budget the heavy UNCACHED `/mor/v1` endpoints
  (`/mor/v1/sessions`, `/mor/v1/sessions/analytics`, per-wallet sessions/
  transactions/gas, `/mor/v1/provenance`) shed to `503` + `Retry-After` instead
  of blowing the free quota and taking the whole site down mid-day. The cached
  endpoints (ui-init / all / analytics / holders) keep serving from KV / the CF
  Cache API. The total is a conservative per-endpoint-class estimate, not exact
  `rows_read` (see `src/utils/d1-budget.ts`); it over-counts so the guard trips
  early. It resets automatically at 00:00 UTC; force a manual reset by deleting
  the `d1reads:<UTC-date>` KV key. Admin identities bypass the shed.
- **DNS-AID agent discovery records** (HTTPS/type-65 RRs, both priority 1,
  target `morscan.io`, `alpn="h2"`):
  - `_index._agents.morscan.io`
  - `_a2a._agents.morscan.io`
  These advertise the agent discovery surface per the DNS-AID draft; keep them
  when re-creating the zone.

## Bindings (names only - ids live in wrangler.deploy.toml)

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 database (`morscan`) | The whole indexed state: sync cursors, providers/bids/sessions, holders, keys, receipts, alerts |
| `NONCE_CACHE` | KV namespace | Wallet-connect challenge nonces |
| `MORSCAN_CACHE` | KV namespace | Metrics summary, price-chart cache, other hot reads |
| `SYNC_COORDINATOR` | Durable Object (`SyncCoordinator`, SQLite class) | 5s real-time sync loop; the minute cron watchdogs it |
| `RL_STANDARD` / `RL_STRICT` / `RL_LOW` | `[[ratelimits]]` bindings | Per-IP and per-key-tier rate limiting (wrangler >= 4.36 syntax) |
| `SNAPSHOT_BUCKET` | R2 bucket (optional, currently commented out) | Signed marketplace CDN snapshot; writer no-ops without it |

## Cron triggers

Three patterns, multiplexed in `scheduled()` (`src/index.ts`):

| Cron | Work |
| --- | --- |
| `* * * * *` | DO sync watchdog, fatboy cache rebuild, canonical metrics precompute, on-chain price point, backfill grind, stake-cap refresh, receipt chaining |
| `*/3 * * * *` | Marketplace CDN snapshot writer (no-op without `SNAPSHOT_BUCKET`) |
| `0 3 * * *` | Daily R2 snapshot prune (>7 days old) |

## Secrets (names only; set with `wrangler secret put <NAME> --config wrangler.deploy.toml`)

| Secret | Purpose |
| --- | --- |
| `MORSCAN_JWT_SECRET` | UI session signing (`openssl rand -hex 32`) |
| `MORSCAN_MNEMONIC` | BIP39 seed for the Ed25519 provenance/snapshot signing keys (a real mnemonic, not hex). Public keys are published at `/.well-known/morscan-keys.json` |
| `MORSCAN_DEMO_KEY` | UI serving key embedded in explorer pages so page scripts can fetch `/mor/v1` data (per-IP limits still apply) |
| `MORSCAN_ADMIN_KEY_IDS` | Optional ops secret. Comma-separated `api_keys` ids granted admin bypass for `/sync/*`, `/mor/v1/bq/*`, `/admin/*` (`isAdminAuth`). Seed with a wallet key id like `wallet:0xYourAddr`. The `admin` key is always an admin; this only adds more. Never a real value in git |
| `ALERT_TELEGRAM_BOT_TOKEN` / `ALERT_TELEGRAM_CHAT_ID` | Optional Telegram alerting |
| `ALERT_SLACK_WEBHOOK_URL` | Optional Slack alerting |
| `ALERT_DISCORD_WEBHOOK_URL` | Optional Discord alerting |
| `ALERT_WEBHOOK_URL` | Optional generic JSON webhook alerting |

Alerts always land in the D1 `alerts` table + `/admin/alerts` with no config;
the webhook secrets only add external paging.

**Sovereignty switches ([vars], both default `"true"`).** Every DRM3-published
package is optional: `PROVENANCE_ENABLED = "false"` runs unsigned (no receipt
fields, `/version` reports `provenance: "disabled"`, the
`@drm3labs-oss/provenance` WASM is never initialized), and
`RPC_POOL_ENABLED = "false"` replaces the `@drm3labs-oss/rpc-pool` failover
pool with a plain `fetch` POST to `RPC_URL` (simple retry, no WASM). BigQuery
dual-write is already off by default. The production morscan.io deployment
keeps both switches ON (unset = enabled); they exist so a fork can run the open
core on nothing but Cloudflare and its own RPC.

**No RPC secrets.** The Alchemy RPC secrets (`ALCHEMY_FALLBACK_URL`,
`BACKFILL_ALCHEMY_URL`) have been removed from the live deployment. Sync now
runs entirely on free public Base peers (`base.gateway.tenderly.co`,
`mainnet.base.org`) through the `@drm3labs-oss/rpc-pool` failover pool, which
health-tracks and routes around any peer that 429s or flakes. The historical
backfill is complete, so no archive/paid RPC key is needed. A free-tier Alchemy
url is still *optionally* supported in code (additive capacity, never a
dependency) but is not configured in production.

## Agent-ready surface (served by the Worker, no zone config needed)

`/.well-known/api-catalog` (RFC 9727), `/.well-known/oauth-protected-resource`
(RFC 9728 - honest: no OAuth server, empty `authorization_servers`),
`/.well-known/mcp/server-card.json`, `/.well-known/agent-skills/index.json`
(+ per-skill `SKILL.md` docs with sha256 pinning), `/auth.md`, `/webmcp.js`,
markdown content negotiation (`Accept: text/markdown`) on `/`, `/about`,
`/contribute`, `/stake`, and RFC 8288 `Link` headers on HTML pages. All of it
lives in `src/handlers/agent-ready.ts` + `src/handlers/markdown-pages.ts` and
derives URLs from `PUBLIC_BASE_URL`.

## Rebuild from scratch

1. **Zone**: add `morscan.io` to the Cloudflare account (Free plan is enough);
   keep AI-bot blocking OFF; re-create the two `_agents` HTTPS records above;
   enable DNSSEC and publish the DS record at the registrar; re-create the edge
   rate-limit rule (50 req / 10s per IP on `/mor/v1/*`, `/console/*`,
   `/capacity`, 10s block).
2. **Repo**: clone, `npm install`, `node scripts/stamp-build.mjs`.
3. **Deploy config**: copy `wrangler.toml` to `wrangler.deploy.toml`; fill in
   `account_id`, the custom-domain `routes` (apex + staging + `www/*` zone
   route), and real resource ids as they are created below.
4. **D1**: `wrangler d1 create morscan`, put the id in the deploy toml, apply
   `schema.sql`, optionally import the seed (`docs/SEED.md`,
   `scripts/import-seed.mjs`).
5. **KV**: create `NONCE_CACHE` and `MORSCAN_CACHE` namespaces; ids into the
   deploy toml.
6. **Secrets**: `wrangler secret put` each name from the table above (JWT
   secret + mnemonic + demo key minimum). No RPC secret is required; sync runs
   on free public Base peers.
7. **Deploy**: `npx wrangler deploy --config wrangler.deploy.toml` (this also
   registers the DO migration and the three cron triggers).
8. **Custom domains**: wrangler creates the apex/staging custom domains from
   `routes`; confirm `www` has a zone route into the Worker.
9. **Verify**: `/health` 200 and syncing; `/version` shows the new commit +
   signed build receipt; `/.well-known/morscan-keys.json` publishes keys;
   `/mor/v1/price` returns a price; `curl -H "Accept: text/markdown" /`
   returns markdown; `Link` header present on `/`.
10. **Optional R2**: create `morscan-marketplace-snapshot`, uncomment the
    binding, bind a public host, set `SNAPSHOT_PUBLIC_HOST` +
    `SNAPSHOT_SIGNER_KEY_ID`.
