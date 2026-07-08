# MorScan Specs

Planned features and improvements. When a spec is fully implemented, it moves to `docs/architecture/` and is rewritten as architecture (how it works) rather than spec (how it should work).

## Pending

- [`compute-provider-pool.md`](./compute-provider-pool.md) - track the Morpheus
  compute provider pool itself (balance, emission flows, provider claims) and
  fill the empty Daily Emissions and APR columns on `/pools`. Status: Proposed.

The builder staking plane spec shipped; the as-built reference
is [`../architecture/builder-plane.md`](../architecture/builder-plane.md)
(remaining route ideas - the "My Stakes" wallet page, cross-plane wallet view,
FeeConfig decoding - are noted there).

> **BigQuery dual-write:** optional and **off by default**
> (`BIGQUERY_ENABLED = "false"` in `wrangler.toml`). No pending producer-side
> work: `provider_stats` and every reasonable D1 table already have dual-write
> hooks. The as-built reference is
> [`../architecture/bigquery-dual-write.md`](../architecture/bigquery-dual-write.md).
> When adding a new dual-write target, add its DDL to `seed/bq-schema.sql` and
> its row builder to `src/utils/bigquery/rows.ts`.
