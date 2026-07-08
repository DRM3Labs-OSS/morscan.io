# Sync Architecture

Forward-only event projector using `eth_getLogs`. Single sync path owned by the Durable Object.

## How It Works

The `SyncCoordinator` Durable Object runs an alarm every 5 seconds. Each tick calls `sync()` from `src/sync/compute.ts` (re-exported via `src/sync/index.ts`), which:

1. Calls `eth_getLogs` over the Diamond contract for the whole block gap since the cursor (one or two calls; capped at `MAX_LOG_RANGE = 50000` blocks per call), pulling Diamond events (SessionOpened, SessionClosed, MarketplaceBidPosted, MarketplaceBidDeleted, DiamondCut)
2. Calls `eth_getLogs` over the MOR token for `Transfer` logs (holder tracking)
3. Enriches new sessions/bids with batch `getSession` / `getBid` RPC calls
4. Writes to D1 (and, if enabled, BigQuery)
5. Advances the cursor (`last_event_block` in `sync_state`)

> The Durable Object's file header still describes an older `alchemy_getTransactionReceipts` projector; the implementation in `src/sync/compute.ts` was rewritten on 2026-04-27 to use `eth_getLogs` (the header in `compute.ts` documents the rewrite). `eth_getLogs` is the live path.

**Confirmation buffer:** 5 blocks. Sync only processes blocks at least 5 behind chain head to avoid reorg risk (`CONFIRMATION_BUFFER` in `compute.ts`; Base finalizes in ~2 blocks). Builder sync keeps a wider 20-block buffer.

**Economics:** `syncEconomics()` runs every 12th tick (~60s). Reads compute balance, MOR supply, and budget from the Diamond contract. Writes to `network_economics` and `economics_history`.

**Builder:** `syncBuilderEvents()` runs every 6th tick (~30s). Uses `eth_getLogs` for builder subnet staking events on an independent cursor (`builder_sync_state`). See [`builder-plane.md`](builder-plane.md).

## Cron (every minute)

Safety net only. Restarts the DO alarm if it died (deploys can kill alarms). Rebuilds the fatboy cache. Chains provenance receipts. Does NOT run sync directly.

## RPC source and resilience

`RPC_URL` (in `wrangler.toml`) is the primary endpoint. Sync otherwise runs on
free public Base peers - no paid key required. `ALCHEMY_FALLBACK_URL` is an
optional additive endpoint (never a dependency) and is **not configured in
production**; the historical backfill is complete, so no archive RPC is needed.

- **Failover pool.** Single-shot RPC calls go through the
  `@drm3labs-oss/rpc-pool` WASM pool (`src/utils/rpc-pool.ts`): every configured
  peer is a priority-0 peer, each call routes to the least-loaded healthy one,
  and a 429/flaky endpoint is health-tracked and routed around. The peer set is
  `RPC_ENDPOINTS` in `src/sync/parsers-rpc.ts` (llamarpc, publicnode, drpc,
  1rpc, base.org, tenderly, and more). If WASM init ever throws, the caller
  falls back to the legacy sequential loop (`src/utils/rpc-fallback.ts`), so sync
  can never break on the pool.
- **Head-block fallback.** `getCurrentBlock()` (`src/utils/rpc.ts`) tries
  `RPC_URL` first, then walks its public Base fallback list, validating each
  response with `safeParseHex()` and throwing only if every endpoint fails.
- **`safeParseHex(hex): number`** returns `0` instead of `NaN` for invalid or
  empty hex, so a malformed RPC response cannot propagate `NaN` into block math.
  It is not applied at every `parseInt(hex, 16)` call site; the projector's ABI
  decoders do their own bounds checks (see [`security.md`](security.md)).
- The 5-second event projector pins to `RPC_URL` for cursor-advancing writes;
  the public fallback set is for head-block reads and diagnostics.

## Files

| File | Purpose |
|------|---------|
| `src/sync/compute.ts` | `eth_getLogs` event projector; orchestrates events, discovery, economics, stats (barrel: `src/sync/index.ts`) |
| `src/sync/compute-rpc.ts` | RPC client (`rpc`, `getEndpoints`, `eth_getLogs`) |
| `src/sync/compute-events.ts` | Per-event processors (SessionOpened/Closed, MarketplaceBidPosted/Deleted, DiamondCut, MOR transfers) |
| `src/sync/compute-discovery.ts` | Provider discovery |
| `src/sync/compute-stats.ts` | Wallet/provider stat rebuilds; `wallet_stats` + `diamond_upgrades` DDL |
| `src/sync/parsers.ts` | Barrel re-exporting `parsers-rpc.ts` (selectors, RPC) and `parsers-abi.ts` (ABI decode) |
| `src/sync/builder.ts` | Builder subnet event sync (orchestration; discovery/refresh in `builder-discovery.ts` / `builder-refresh.ts`) |
| `src/sync/events-batch.ts` | Batch RPC helpers (used by builder sync) |
| `src/durable/SyncCoordinator.ts` | 5s alarm loop; orchestrates compute + builder + economics |

## Event Signatures

| Event | Source |
|-------|--------|
| `SessionOpened(address,bytes32,address)` | Diamond contract |
| `SessionClosed(address,bytes32,address)` | Diamond contract |
| `MarketplaceBidPosted(address,bytes32,uint256)` | Diamond contract |
| `MarketplaceBidDeleted(address,bytes32,uint256)` | Diamond contract |
| `Transfer(address,address,uint256)` | MOR ERC-20 token |

## Historical backfill (operator runbook)

The backfill on the live morscan.io deployment is **already complete**, so this
section is for a fresh operator (or a deliberate re-scan), not routine ops. The
live sync only walks forward from the tip a few blocks at a time, so it runs fine
on the free public RPC pool. **A full historical backfill / re-scan is a
different job and requires an ARCHIVE-capable RPC (Alchemy, QuickNode, etc),
temporarily set as `ALCHEMY_FALLBACK_URL` for the duration of the backfill.**

Free public RPC endpoints CANNOT do this. They fail on large historical
`eth_getLogs` ranges (empty results, timeouts, or "range too wide" errors), and
the gap-proof sync deliberately refuses to skip a range it could not read, so it
stalls. Point the `ALCHEMY_FALLBACK_URL` secret at an archive-capable endpoint;
a free Alchemy account works, but has a monthly compute-unit (CU) budget and a
per-second throughput cap, which is why backfill is throttled.

### The endpoint

```
GET /sync/backfill?from=<block>&to=<block>
```

Admin-gated (same `admin` key / `MORSCAN_ADMIN_KEY_IDS` gate as all `/sync/*`
routes). Send the admin key as `X-Morscan-Key`. It re-scans `[from, to]` in
throttled chunks and **upserts** every event it finds (`INSERT OR REPLACE` /
`OR IGNORE` / `ON CONFLICT` - additive, idempotent, never deletes).

It is bounded per call by `BACKFILL_MAX_CHUNKS_PER_RUN`. When the range is larger
than one run can cover, the response includes `"done": false` and `"nextFrom": N`
- call again with `from=N` to continue. `"done": true` means the whole range is
covered.

### Why it is SAFE (does not disturb the live site)

Backfill is a **separate pass**, not a cursor rewind. It reads historical ranges
on the archive RPC and upserts events, but it **never writes the live cursor**
(`last_event_block` / `last_block` / `current_block`). The live forward sync
(the `SyncCoordinator` Durable Object) keeps running at head the whole time and
`/health` stays fresh. You do NOT stop the DO to backfill. Run it while the site
is live; watch `/health` (it should stay `status: ok`, `blocksBehind ~5`).

Because getLogs for a range that is already fully indexed just re-writes the same
rows, re-running a range is a harmless no-op. That makes 100% completeness a
matter of sweeping the range in bounded calls until every one reports `done`.

### Throttle knobs (env vars, defaults tuned for free Alchemy)

| Var | Default | Meaning |
|-----|---------|---------|
| `BACKFILL_CHUNK_BLOCKS` | `2000` | Blocks per `eth_getLogs` chunk. Smaller = gentler on the RPC, more chunks. |
| `BACKFILL_DELAY_MS` | `250` | Pause between chunks. Spreads CU/s under the free throughput cap and yields the RPC to the live sync. |
| `BACKFILL_MAX_CHUNKS_PER_RUN` | `30` | Hard cap on chunks per HTTP call (bounds subrequests + wall clock). Resume via `nextFrom`. |

### CU / time tradeoff (rough)

Each chunk is 2 `eth_getLogs` (Diamond + MOR) plus a small `eth_call` batch only
for chunks that actually contain `SessionOpened` / `BidPosted` events. On
Alchemy's pricing `eth_getLogs` is cheap (tens of CU) and `eth_call` is ~26 CU,
so a typical chunk is well under ~1k CU and most historical chunks (no events)
are ~150 CU. At the defaults (2000 blocks/chunk) a **full genesis re-scan of the
~5.8M-block history (42.4M -> head) is ~2,900 chunks, on the order of a few
hundred thousand to low-single-digit-million CU total** - a small fraction of the
~300M CU/month free budget. The throttle is therefore about *throughput* (staying
under the free per-second cap and leaving headroom for the live sync), not the
monthly budget.

Wall-clock: at default `BACKFILL_MAX_CHUNKS_PER_RUN=30` and `BACKFILL_DELAY_MS=250`,
one call covers 30 x 2000 = 60,000 blocks and takes on the order of tens of
seconds. A full genesis sweep is ~97 such calls; script them back-to-back using
each response's `nextFrom`, or bound to the active period (e.g. the last 30-90
days) first.

### If something goes wrong (recover the LIVE sync)

Backfill cannot move the live cursor, so it should not be able to break the live
site. But if the live sync is ever unhealthy for any reason (`/health`
`blocksBehind > 500`, `lastSyncAgeSeconds > 120`, or `status: error`), the
recovery is always the same three steps - stop the DO, snap the cursor to head,
restart:

```
GET /sync/coordinator/stop                     # pause the DO loop
GET /sync/reset-events?block=<current head>    # sets last_event_block + last_block to head
GET /sync/coordinator/start                    # resume the DO loop
```

`/sync/reset-events` writes `last_event_block` (the real cursor the projector
reads) AND `last_block` (what `/health` shows as `syncedBlock`), so the reset
takes effect immediately. It MUST run while the DO is stopped, otherwise the next
tick clobbers the value (the DO rewrites `last_event_block` every ~5s).
