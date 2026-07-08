# Data Coverage, Backfill, and the Syncing State

> How MorScan indexes Base, how far back each dataset really goes, how the
> historical backfill works, and how sync/indexing state is shown honestly. If a
> number on the site looks low, this file explains whether it is incomplete and
> why, and how it converges to complete.

## The honesty principle

MorScan never shows an incomplete number as if it were final. Every dataset has a
real, known **from-block** (its coverage floor). When coverage is still climbing,
the UI says so ("indexing full history: N% complete") rather than presenting a
partial count as the truth. This is the same honesty posture as the rest of the
site (per-contract lag on /health, signed receipts, "not indexed" admissions).

## Coverage by dataset

| Dataset | Coverage floor | Source of the floor | Complete? |
|---------|----------------|---------------------|-----------|
| Builder / subnets | block `24,381,796` (`BUILDER_DEPLOY_BLOCK`) | BuildersV4 proxy deploy block | Yes, by construction |
| Sessions / compute | `head - 100` at first init | `initSync` default (no deploy floor) | Backfills to the Diamond deploy block |
| MOR holders | the compute-sync start | populated from MOR Transfer events seen during compute sync | Backfills to the MOR token deploy block |

The exact live floors are published in `/health` (coverage section) so this is
never ambiguous.

### Why holders can read low before backfill

The holder count is the number of wallets in `mor_holders`, populated from MOR
`Transfer` events seen after indexing began. A wallet that acquired MOR earlier
and simply held (no transfer since) is never seen by the forward sync, so it is
missing until backfill reaches it. Basescan counts from the token's deployment,
so it reports more. The fix is to replay the full MOR transfer history from the
token deploy block and recompute net balances; the honest holder count is then
wallets with `mor_balance_wei > 0`, which is what Basescan counts. Balances
themselves come from an idempotent `balanceOf` refresh at head (not from the log
re-scan), so the count matches Basescan even while the deep history is still
filling in.

## The backfill: a separate pass, not a cursor rewind

Two independent things read the chain:

1. **Live sync** (the `SyncCoordinator` Durable Object): stays pinned at the head,
   processing new blocks as they arrive (~1 every 2s on Base). Its cursor is D1
   key `last_event_block`. This keeps the site fresh and must never be rewound.

2. **Backfill** (`/sync/backfill?from=X&to=Y`, `src/sync/backfill.ts`): a
   **separate pass** that re-scans a historical range and upserts events
   (`INSERT OR REPLACE`, idempotent, never deletes) **without touching the live
   cursor**. So the site stays live at head while history fills in behind it.

Because the backfill covers a **fixed** historical range (a dataset's deploy
block up to where live sync took over), and that range does not grow, the
backfill converges to 100% coverage given any positive throughput. New blocks are
never the backfill's problem; the live sync owns those. It is not "will it
finish," only "let it grind until the fixed range is done."

### Throttling for a free archive tier

Historical `eth_getLogs` requires an **archive-capable RPC**. Free *public* Base
endpoints cannot serve large historical ranges (they fail, and the gap-proof sync
correctly refuses to skip, so it stalls). Point `ALCHEMY_FALLBACK_URL` at an
archive-capable endpoint (a free-tier Alchemy Base key works); the backfill
prefers it over the public pool. A free tier has real limits (compute-unit budget
and a per-second throughput cap), so the backfill is throttled and resumable:

- `BACKFILL_CHUNK_BLOCKS` (default 2000) - blocks per `getLogs` chunk. Tune DOWN
  if the archive tier rejects the range.
- `BACKFILL_DELAY_MS` (default 250) - pause between chunks, to respect rate limits.
- `BACKFILL_MAX_CHUNKS_PER_RUN` (default 30) - ~60k blocks per endpoint call;
  call repeatedly (resumable via the returned `nextFrom`) to walk a large range.

A full historical re-scan on a free tier is a grind, not instant. That is fine
(see convergence above); being mid-backfill is a normal, honestly-labeled state.

### Tracking catch-up time

The backfill records its own throughput (blocks/sec, wall-clock per window) and a
derived ETA to full coverage (`blocks_remaining / avg_blocks_per_sec`). This is
persisted as a progress row and surfaced in `/health` and the syncing indicator.
It is also the decision signal for whether a free archive tier is sufficient or a
paid tier is worth it to catch up faster.

## Catch-up speed

Two mechanisms fill history, and they compose:

1. **The cron floor (automatic).** The minute cron in `src/index.ts` advances the
   holder backfill one bounded, locked window per tick, genesis-ward from the
   frontier. It never touches the live cursor, survives deploys, and converges
   with zero babysitting. It is the always-on safety net, not the speed play.
2. **Scripted `/sync/backfill` sweeps (fast path).** Each admin-gated call covers
   up to `BACKFILL_MAX_CHUNKS_PER_RUN x BACKFILL_CHUNK_BLOCKS` blocks (60,000 at
   the defaults) in tens of seconds and returns `nextFrom` for the next call.
   Script calls back-to-back to walk a large range. The compute-unit and
   wall-clock math is in
   [DEPENDENCIES.md](DEPENDENCIES.md#historical-backfill-requires-an-archive-rpc):
   at the defaults a full re-scan of the ~5.8M-block history is ~2,900 chunks
   (~97 calls), a small fraction of a free monthly CU budget.

A paid archive tier removes the throughput caps, so the same sweep finishes much
faster; raise `BACKFILL_CHUNK_BLOCKS` and lower `BACKFILL_DELAY_MS` accordingly.
Because the holder COUNT comes from the `balanceOf` refresh (not the log
re-scan), there is no user-visible penalty while the deep scan grinds in the
background under the honest syncing banner.

## The syncing / indexing state (shown, not hidden)

The signals already exist on `/health`: `blocksBehind`, `syncStale`, `status`
(ok / degraded / error), `lastSyncAgeSeconds`, plus per-dataset coverage. The UI
turns these into a clear indicator wherever an incomplete count appears (e.g. the
holder count): "Indexing full history: N% complete (from block X of Y), ~H hours
remaining at M blocks/sec." When coverage reaches ~100%, the indicator resolves
to the plain final count (plus, for holders, the dust breakdown and Basescan
cross-check). A visitor should always be able to tell whether a number is final
or still climbing, and why.

## Operational recovery (the live cursor)

The live compute cursor is D1 `sync_state` key **`last_event_block`** (read in
`compute.ts`, written each tick). The Durable Object writes it every tick, so any
manual cursor change MUST: stop the DO (`GET /sync/coordinator/stop`), set
`last_event_block` in D1, restart (`GET /sync/coordinator/start`) - otherwise the
DO clobbers the change via a race. Do NOT rewind the live cursor to backfill; use
the separate `/sync/backfill` pass instead. If the live sync ever stalls (behind
grows, `age` climbs, status error): stop DO, set `last_event_block` to head,
start DO, verify it advances.

## Summary

- Builder data is complete by construction. Sessions and holders backfill to
  their true deploy blocks via the separate-pass, archive-RPC backfill.
- The backfill converges to 100% regardless of speed; it just grinds a fixed
  range. Being mid-backfill is fine and is labeled as such.
- The syncing state is shown honestly (percent complete + ETA), never a partial
  number dressed as final, and holders are cross-checked against Basescan.
