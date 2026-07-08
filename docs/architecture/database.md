# Database Schema

Cloudflare D1 (SQLite). The `database_id` is configured per-deployment in
`wrangler.toml`. The canonical DDL is [`schema.sql`](../../schema.sql) at the
repo root (27 tables).

> **Schema creation.** Apply `schema.sql` before first deploy. Only
> `wallet_stats` and `diamond_upgrades` are also created in code
> (`ensureWalletStatsSchema` / `ensureDiamondUpgradesTable` in
> `src/sync/compute-stats.ts`). Every other table must already exist in D1
> before first sync - the code writes to them with `INSERT`/`INSERT OR REPLACE`
> and does not create them. `seed/indexes.sql` adds indexes (assuming the tables
> exist); `seed/sessions_part*.sql` load session rows.

## Core tables

| Table | Primary Key | Purpose |
|-------|-------------|---------|
| `sessions` | `id` | All sessions (active + closed) - user, bid_id, provider, model_id, stake, timestamps, closeout type, tx hashes. **Caveat:** `close_tx_hash` is sparsely populated (~64 rows vs ~103K closed sessions); closes repaired by the phantom-session sweep have `closed_at` but no tx hash. |
| `bids` | `bid_id` | Model offerings - provider, model_id, price_per_second, nonce, created/deleted timestamps |
| `providers` | `address` | Provider registrations - address, endpoint URL, stake, timestamps |
| `models` | `model_id` | Human-readable model names from the ModelRegistry contract |
| `mor_holders` | `wallet` | MOR token holders - balances, `last_transfer_block`, `has_sessions`, `updated_at` |
| `sync_state` | `key` | Key/value sync metadata - `last_event_block`, `last_block`, `current_block`, cached prices, fatboy cache |
| `config` | `key` | Key/value runtime config |

## Analytics tables

| Table | Primary Key | Purpose |
|-------|-------------|---------|
| `provider_stats` | `(provider, model_id)` | Per-provider per-model reputation - session/active/disputed counts, total stake |
| `wallet_stats` | `wallet` | Precomputed per-wallet analytics (instant reads, no GROUP BY). Created in code. |
| `network_economics` | `id` (singleton, `id=1`) | `compute_balance`, `total_supply`, `staking_factor`, `updated_at` |
| `economics_history` | `date` | Daily snapshots for 30-day trend analysis |
| `gas_costs` | `tx_hash` | Transaction receipt gas data for cost analytics |
| `price_history` | `ts` | On-chain MOR/ETH price points recorded by the price handler; powers the 24h change and the self-owned chart |

## Builder plane tables

See [`builder-plane.md`](builder-plane.md).

| Table | Primary Key | Purpose |
|-------|-------------|---------|
| `builder_subnets` | `subnet_id` | Subnet name, admin, totals, rewards |
| `builder_stakes` | `(subnet_id, wallet)` unique | Per-wallet subnet positions (also drives stake-indexed API-key caps) |
| `builder_events` | `id` | Deposit/withdraw/claim/fee events |
| `builder_sync_state` | `key` | Independent builder sync cursor |

## Provenance tables

| Table | Primary Key | Purpose |
|-------|-------------|---------|
| `provenance_receipts` | `id` | Per-response/row receipts (action, hashes, public_key, signature, receipt_json) |
| `service_attestations` | `id` | Merkle-chained batch attestations (merkle_root, receipt_count, signature) |
| `key_history` | - | Signing-key lifecycle rows served by `/.well-known/morscan-keys.json` |

## Access & metering tables

| Table | Primary Key | Purpose |
|-------|-------------|---------|
| `api_keys` | `id` | API keys - `key`, `name`, `rate_limit`, `daily_cap`, `monthly_cap`, usage timestamps. Id conventions: `admin` (operator), `wallet:<address>` (per-wallet keys from `/console`), `user:<id>` (IdP identities). |
| `usage_counters` | `(key_id, bucket)` | Day/month metering counters per key (`d:YYYY-MM-DD` / `m:YYYY-MM` UTC buckets). See [`rate-limiting.md`](rate-limiting.md). |
| `ci_wallets` | `wallet` | Allowlisted CI wallets; wallet-signed requests from these are rate-limited to the free tier |

Minute-burst rate limiting does not use D1 (rate-limiting bindings plus an
in-memory fallback); only the day/month volume counters live in
`usage_counters`.

## Telemetry & ops tables

| Table | Primary Key | Purpose |
|-------|-------------|---------|
| `signer_attestations` | `derived_address` | Maps a derived signer address to its staking wallet (wallet-auth) |
| `diamond_upgrades` | `(block_number, ...)` | DiamondCut upgrades (created in code) |
| `notify_list` | `email` | Launch-list email capture (`POST /notify`) |
| `alerts` | `id` | Operational alerts (sync stalls, RPC failures, recoveries); shown at `/admin/alerts` |

## Key relationships

```
sessions.bid_id  → bids.bid_id → bids.provider, bids.model_id
sessions.provider, sessions.model_id (denormalized for fast queries)
provider_stats.(provider, model_id) → computed from sessions
wallet_stats.wallet → computed from sessions
api_keys.id 'wallet:<addr>' → caps from builder_stakes (MorScan subnet)
```

## Seed data

Historical sessions are seeded to avoid a long cold re-sync on fresh deploys -
~97k sessions split across 10 SQL files under `seed/` (the seed assumes the
`sessions` table already exists). See [`../../seed/README.md`](../../seed/README.md).

Tables **not** seeded (populated by sync): providers, bids, models, mor_holders,
provider_stats, wallet_stats, network_economics, economics_history, sync_state,
and the builder tables.
