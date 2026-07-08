# Seeding MorScan history

MorScan indexes the Morpheus AI network from Base mainnet. A fresh deploy needs
history before its dashboards are useful.

**Quickstart: skip the full historical sync.** Import the latest published data
snapshot, then catch up only the small delta from the snapshot watermark to chain
head. That turns a multi-hour backfill from the contract deploy blocks into about
ten minutes of sync. This is Path B below, and it is the recommended way to stand
up a node.

The snapshot is its own project, not part of MorScan:

**[DRM3Labs-OSS/morpheus-ai-base-data](https://github.com/DRM3Labs-OSS/morpheus-ai-base-data)** - a signed, CC0 SQL snapshot of Morpheus network activity on Base, verifiable against a key committed to that repo. Snapshots are published up to a high watermark; the most recent is at block 48,249,693 (July 5 2026).

MorScan is one consumer of it.

## Two ways to stand up a caught-up node

### Path A: from scratch (sync from the contract deploy blocks)

A fresh clone with no seed starts near chain head and backfills history from the
contract deploy blocks via RPC. The MOR token deployed at Base block 15,002,375
(2024-05-27) and the Morpheus Diamond at block 39,593,197, so a full holder and
transfer backfill replays close to two years of Base blocks (about 33 million
blocks). On a rate-limited public RPC that is slow: hours to days, and the
historical `getLogs` sweep wants an archive-capable RPC (see
[docs/DEPENDENCIES.md](DEPENDENCIES.md)). This is the zero-dependency path,
and the numbers come straight from chain, but you wait for the backfill.

1. Create the D1 database and KV caches, then apply the schema. (Full setup,
   including the KV ids and `wrangler.toml` edits, is in
   [docs/GETTING_STARTED.md](GETTING_STARTED.md); the minimum is:)

   ```bash
   npx wrangler d1 create morscan
   #   -> copy the printed database_id into wrangler.toml ([[d1_databases]])
   npx wrangler kv namespace create NONCE_CACHE
   npx wrangler kv namespace create MORSCAN_CACHE
   #   -> copy each printed id into its [[kv_namespaces]] entry
   npx wrangler d1 execute morscan --remote --file=./schema.sql
   ```

2. Set the one required secret and deploy:

   ```bash
   openssl rand -hex 32 | npx wrangler secret put MORSCAN_JWT_SECRET
   npx wrangler deploy
   ```

3. Create an admin API key (the `/sync/*` routes are admin-gated) and start the
   live sync loop. Live sync begins near chain head, so the site is fresh right
   away; history fills in behind it in step 4.

   ```bash
   KEY="mor_admin_$(openssl rand -hex 16)"
   echo "Save this admin key: $KEY"
   npx wrangler d1 execute morscan --remote \
     --command="INSERT INTO api_keys (id, key, name, rate_limit, created_at) VALUES ('admin','$KEY','Admin',1000000,$(date +%s));"

   BASE="https://<your-worker-origin>"   # e.g. https://morscan.example.workers.dev
   curl "$BASE/sync/coordinator/start" -H "X-Morscan-Key: $KEY"
   ```

4. Backfill history from the deploy blocks. Both calls are throttled and
   resumable: each returns `{"nextFrom": <block>, "done": false}` while there is
   more to do, or `{"done": true}` when the range is covered. Re-call with
   `from=<nextFrom>` until done. `<HEAD>` is the current synced block, shown at
   `$BASE/health` as `syncedBlock`.

   ```bash
   # Sessions, bids and MOR transfers, from the Diamond deploy block forward:
   curl "$BASE/sync/backfill?from=39593197&to=<HEAD>" -H "X-Morscan-Key: $KEY"
   #   -> repeat with ?from=<nextFrom>&to=<HEAD> until {"done":true}

   # Holder history, from the MOR token deploy block forward (?from=15002375
   # restarts the campaign from the token deploy; to defaults to head):
   curl "$BASE/sync/backfill-holders?from=15002375" -H "X-Morscan-Key: $KEY"
   #   -> repeat with ?from=<nextFrom> until {"done":true}
   ```

### Path B: seed from the published snapshot (fast)

Import the signed snapshot from
[morpheus-ai-base-data](https://github.com/DRM3Labs-OSS/morpheus-ai-base-data),
then let live sync fill only the delta from the snapshot watermark
(block 48,249,693) to head. Done promptly after a snapshot is published, that
delta is small: roughly ten minutes of sync, not a full-history replay.

1. Create a fresh, empty D1 database and the KV caches (do NOT apply this repo's
   `schema.sql` - the importer applies the snapshot's own schema in step 4). An
   authed wrangler with write access to that D1 is required.

   ```bash
   npx wrangler d1 create morscan
   #   -> copy the printed database_id into wrangler.toml ([[d1_databases]])
   npx wrangler kv namespace create NONCE_CACHE
   npx wrangler kv namespace create MORSCAN_CACHE
   #   -> copy each printed id into its [[kv_namespaces]] entry
   ```

   `wrangler.toml` (the committed template you configured in
   [docs/GETTING_STARTED.md](GETTING_STARTED.md)) is the config used
   throughout below. If you keep a separate private deploy config, point
   `WRANGLER_CONFIG` (and `--config`) at that file instead.

2. Clone the dataset and install its deps (its verifier needs them):

   ```bash
   git clone https://github.com/DRM3Labs-OSS/morpheus-ai-base-data
   cd morpheus-ai-base-data && npm install && cd -
   ```

3. Download the snapshot Release asset (`morpheus-ai-base-data-<block>.sql.gz`)
   from that repo's Releases.

4. Run the importer. It verifies the snapshot with the dataset's own verifier,
   applies the shipped schema, loads the data, and sets the sync watermark
   (`TARGET_DB` is the D1 name from step 1):

   ```bash
   DATASET_DIR=/path/to/morpheus-ai-base-data \
   BLOB=/path/to/morpheus-ai-base-data-<block>.sql.gz \
   TARGET_DB=morscan WRANGLER_CONFIG=wrangler.toml \
   node scripts/import-seed.mjs
   ```

   The importer refuses to run against a populated D1, so it is safe to re-run.
   To rehearse the whole thing against a local database first, add `LOCAL=1`.

5. Deploy the worker and start the sync loop. It resumes from
   `watermark_block + 1` (48,249,694), so it only fetches the delta from the
   watermark forward, not a full-history replay.

   ```bash
   openssl rand -hex 32 | npx wrangler secret put MORSCAN_JWT_SECRET
   npx wrangler deploy

   # Admin key for the gated /sync routes, then kick the loop:
   KEY="mor_admin_$(openssl rand -hex 16)"
   echo "Save this admin key: $KEY"
   npx wrangler d1 execute morscan --remote \
     --command="INSERT INTO api_keys (id, key, name, rate_limit, created_at) VALUES ('admin','$KEY','Admin',1000000,$(date +%s));"
   curl "https://<your-worker-origin>/sync/coordinator/start" -H "X-Morscan-Key: $KEY"
   ```

Notes:

- The snapshot ships its own `schema.sql` (the exact schema the data was dumped
  under), so the import is self-consistent even if this repo's `schema.sql` has
  drifted. Use the dataset's schema for a seeded deploy.
- Only Morpheus network data is imported. Operator tables (API keys, config, the
  indexer's own signing keys and receipts) are not in the snapshot; set those up
  as normal for your deployment.
- Per-provider session offsets and the holder-balance backfill start from
  defaults after a seed; the first sync re-establishes them idempotently.

## Just want the numbers? (no MorScan, no Node)

If you only need the data (holders, sessions, providers, and the full MOR/USD
price history), you do not need MorScan at all. Grab the snapshot and query it
directly.

```bash
# from a clone of morpheus-ai-base-data, with the Release asset downloaded
gunzip -k morpheus-ai-base-data-<block>.sql.gz
sqlite3 morpheus.db < schema.sql
sqlite3 morpheus.db < morpheus-ai-base-data-<block>.sql
```

```sql
-- Top providers by compute sessions served
SELECT provider, COUNT(*) AS sessions
FROM sessions GROUP BY provider ORDER BY sessions DESC LIMIT 5;

-- Holders and total MOR held
SELECT COUNT(*) AS holders, ROUND(SUM(CAST(mor_balance_wei AS REAL))/1e18) AS total_mor
FROM mor_holders WHERE CAST(mor_balance_wei AS REAL) > 0;

-- MOR/USD range over the full price history (pool origin 2024-09-24 to watermark)
SELECT ROUND(MIN(usd),4) AS low, ROUND(MAX(usd),4) AS high, COUNT(*) AS points
FROM price_history;
```

DuckDB works too: `duckdb -c "INSTALL sqlite; LOAD sqlite; ATTACH 'morpheus.db' AS m (TYPE sqlite); SELECT * FROM m.network_economics;"`. See that repo's `queries/examples.sql` and its data dictionary for every table.
