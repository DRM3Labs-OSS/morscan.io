# Alerting

MorScan has a small, self-contained operational alerting system
(`src/alerts/index.ts`). It exists to answer one question loudly: **is the
scanner still keeping up with the chain, and if not, does someone get paged.**

A broken alert path fails silently, so this is documented and unit-tested
(`tests/unit/alerts.test.ts`).

## Two jobs

### 1. Detection (deduped, state-transition)

`runAlertDetection(env, health)` runs on the **minute cron**
(`src/index.ts`, right after the sync heartbeat). It consumes the sync
watchdog's health signal (read-only - it never touches the Durable Object's
alarm or cursor) and compares it to the last-known state persisted in
`sync_state` under the key `alert_state`. It fires an alert **only on a state
transition**, so the operator is paged once per event, not every tick.

| kind | level | fires when |
|------|-------|-----------|
| `sync_stall` | critical | `lastSyncAge` crosses above the stall threshold |
| `sync_recovered` | info | sync is fresh again after having been stalled |
| `rpc_failing` | warning | the watchdog's chain-head read returned nothing (`liveHead === 0`), i.e. the RPC pool plus fallback could not reach any endpoint |
| `rpc_recovered` | info | the head read succeeds again |
| `test` | info | fired manually from the admin test button |

The stall threshold defaults to **120 seconds** and is overridable with
`ALERT_SYNC_STALL_SECONDS`.

Notes on the signals:

- A `null` `liveHead` (signal absent) is treated as **not failing** - only a
  literal `0` (no real chain head is 0) counts as an RPC failure. A one-tick
  blip self-clears on the next minute and fires `rpc_recovered`. This is a
  best-effort heuristic, documented as such in the code.
- Baseline state is healthy, so a fresh clone never fires spurious alerts on
  first boot.

### 2. Recording plus fan-out

`notifyAlert(env, input)` does two things:

1. **Always records** the alert to the D1 `alerts` table (`id, ts, level, kind,
   message, resolved`). This is awaited and is the source of truth. The in-app
   admin view at **`/admin/alerts`** reads this table. Recording works with zero
   external configuration.
2. **Optionally fans out** to whichever notification channels the operator has
   configured. Every channel is optional and **best-effort**: a failing or unset
   channel never throws and never blocks the caller or the cron.

## Channels and configuration

All channels are configured purely by env var. Nothing is hardcoded; any
operator plugs in their own.

| channel | env var(s) | payload |
|---------|-----------|---------|
| Telegram | `ALERT_TELEGRAM_BOT_TOKEN` **and** `ALERT_TELEGRAM_CHAT_ID` (both required) | multi-line chat text |
| Slack | `ALERT_SLACK_WEBHOOK_URL` | `{ text }` chat message |
| Discord | `ALERT_DISCORD_WEBHOOK_URL` | `{ content }` chat message |
| Generic webhook | `ALERT_WEBHOOK_URL` | structured JSON `{ level, kind, message, ts, host }` |

The chat channels (Telegram / Slack / Discord) share one human-readable body
carrying the level, kind, message, host, and ISO time. The generic webhook
instead receives the structured payload above, for machine consumption.

The host label in messages comes from `PUBLIC_BASE_URL` (falling back to
`morscan`).

## Fan-out semantics

- **Never throws.** A channel error is caught and logged, never propagated.
- **Never blocks the cron.** From the cron, sends run in `ctx.waitUntil` so a
  slow channel does not delay the tick (fire-and-forget).
- **Unset channels are skipped.** Only configured channels are attempted.
- The admin test button uses `awaitChannels: true` so the operator sees each
  channel's real send status.

## Testing your wiring

Fire a real alert through every configured channel:

```
POST /api/admin/alerts/test
```

Admin-gated (same gate as `/admin/alerts`; the admin key arrives via the console
session). It sends an `info` / `test` alert and returns each channel's send
result, so you can confirm Telegram / Slack / Discord / webhook are actually
reachable before you rely on them.

## What is covered by tests

`tests/unit/alerts.test.ts` pins: `configuredChannels` (Telegram needs both
values; the others need their one URL), the `alertHost` fallback chain, that
`notifyAlert` always records a row and only fans out to configured channels with
the correct url and body shape, and the `runAlertDetection` state machine -
fires each transition **exactly once** and stays silent while state is
unchanged.

Not unit-tested (documented gaps): the live network delivery to Telegram / Slack
/ Discord (stubbed in tests) and the Durable Object watchdog that *produces* the
health signal (only the pure detection logic that consumes it is tested).

Live tested-state (2026-07-07, production): `POST /api/admin/alerts/test`
recorded a row in the D1 `alerts` table, `/api/admin/alerts` and `/admin/alerts`
returned it, and the configured Telegram channel delivered (HTTP 200); the
detection state machine has also fired real `sync_recovered` / `rpc_recovered`
transitions in the live log. Slack / Discord / generic-webhook senders remain
unit-tested only (no channel configured to exercise them live).
