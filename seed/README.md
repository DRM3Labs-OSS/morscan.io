# Seed helpers

Seeding a fresh MorScan node is documented in [`../docs/SEED.md`](../docs/SEED.md): sync
from scratch, or import the signed snapshot from
[morpheus-ai-base-data](https://github.com/DRM3Labs-OSS/morpheus-ai-base-data)
with `scripts/import-seed.mjs` and let live sync fill the delta from the
watermark.

This directory holds the supporting SQL for a deployment:

| File | What it is |
|------|-----------|
| `indexes.sql` | Recommended indexes. `schema.sql` creates tables but not these; apply them for query performance. |
| `bq-schema.sql` | BigQuery archive schema, for the optional off-D1 analytics archive. |
| `SCHEMA-VERSION.txt` | The Base block the current snapshot import path targets. |

The large per-table `.sql` data files are not committed (see `.gitignore`); the
data comes from the published snapshot, not from this directory.
