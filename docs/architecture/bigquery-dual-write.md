# BigQuery dual-write - OPTIONAL

An optional capability of the reference `AnalyticsProvider`: append-only
dual-write of MorScan's indexed rows (sessions, bids, providers, models,
economics, builder events) to your own BigQuery dataset.

**Off by default.** `wrangler.toml` ships `BIGQUERY_ENABLED = "false"`. D1 is
the source of truth in either state; writes are fire-and-forget from
`ctx.waitUntil` hooks (`writeBqSafe`, `src/utils/bigquery/client.ts`), so a
BigQuery outage never touches D1 sync.

## Enabling

1. Create a GCP project and a BigQuery dataset.
2. Create a service account with BigQuery data-editor on the dataset.
3. Set `BIGQUERY_ENABLED = "true"`, `BIGQUERY_PROJECT_ID`, and
   `BIGQUERY_DATASET_ID` in `wrangler.toml`.
4. Push the service account JSON key:
   `npx wrangler secret put BIGQUERY_SERVICE_ACCOUNT_KEY`.
5. Deploy, then verify with `GET /mor/v1/bq/status`, which returns
   `{ enabled, hasServiceAccountKey, projectId, datasetId }`.

Flip `BIGQUERY_ENABLED` back to `"false"` to pause all dual-write.

## Notes

- Tables partition on `observed_at` (DAY); DDL is in `seed/bq-schema.sql`.
- Rows dedupe on `insertId` in the streaming buffer, so repeat observations
  and backfill sweeps are safe. Backfill endpoints:
  `POST /mor/v1/bq/backfill?table=<name>&limit=&after=` (admin key required).
- Keep downstream queries bounded by a partition filter on `observed_at`.

The seam is the contract; BigQuery is just the reference. To target a
different warehouse, swap the `AnalyticsProvider` (see
`src/providers/README.md`).
