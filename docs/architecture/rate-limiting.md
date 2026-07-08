# Rate Limiting and Metering

Two layers, checked on every gated request (`src/utils/auth/rate-limit.ts`):
a **minute burst** limit (abuse protection) and **day/month volume caps** (the
metered good). Keys are per-wallet: connecting a wallet at `/console` mints a
free bottom-tier key, and staking MOR raises its caps (see
[Stake-indexed caps](#stake-indexed-caps) and `src/utils/stake-tier.ts`).

## Metering model

The rule: meter the value, not the meta.

- **Free, IP-rate-limited (never spends key quota):** `GET /health`,
  `GET /mor/v1/price`, and `GET /mor/v1/capacity`. Checking your remaining
  capacity must never cost capacity. `/mor/v1/capacity` still requires a valid
  key so it can report *your* numbers, but calling it does not decrement them.
- **Metered, flat 1 tick per call:** every real data endpoint (holders,
  sessions, models, bids, builder, analytics, and the rest of `/mor/v1/*`)
  counts as exactly one call against the per-minute, daily, and monthly limits.
  Flat and predictable, no per-endpoint weighting; a genuinely expensive query
  could cost more ticks later, but flat-per-call is the model.
- **What you pay with:** capacity, not fiat. The free key is generous (60/min,
  2,000/day, 40,000/mo). Heavier users raise their limits by staking MOR on the
  MorScan subnet - more stake, more capacity, principal stays yours. Limits
  re-check about once a minute and the moment you reconnect.
- **The console demo:** `/console` shows this directly. **Run a query** makes a
  real metered data call (returns real data, draws quota down); **Check
  capacity** reads your remaining for free.

The rest of this doc is the enforcement mechanism behind that model.

## Minute burst layer

- **Enforcement**: Workers rate-limiting bindings (`[[ratelimits]]` in
  `wrangler.toml`) when configured, pooled by tier (`RL_LOW` 10/min, `RL_MED` 60/min,
  `RL_STRICT` 30/min, `RL_STANDARD` 100/min). Without bindings, a per-isolate
  in-memory `Map` is the best-effort fallback (a Worker isolate's module scope
  persists across requests; new minute = reset; stale entries pruned past 10K).
- **Dual**: per-IP (100/min, keyed on `CF-Connecting-IP`) + per-key
  (`api_keys.rate_limit`). Either can reject.
- **Exemptions**: admin identities skip both checks. Keys whose limit exceeds
  the binding pools (the serving key at 1M/min) skip the per-key binding check
  only; each client IP still rides the per-IP budget.

## Day/month volume layer

- `usage_counters` rows per key per UTC bucket (`d:YYYY-MM-DD` / `m:YYYY-MM`),
  incremented with one batched UPSERT per request.
- Caps come from the key's `api_keys` row (`daily_cap`/`monthly_cap`; NULL
  means the free defaults, 2,000/day and 40,000/month).
- Caps + counters are cached per isolate for 60s, so steady state adds ~zero
  extra D1 reads. Consequence: enforcement lands within a minute or two of a
  counter crossing the line, not on the exact request.
- Enforce-then-count: a capped request never consumes quota. Fails open on D1
  errors - a broken meter must not take the API down.
- Exemptions: the `admin` key id; the env-configured serving key has no
  `api_keys` row, so there is nothing to cap (per-IP still applies).

## Stake-indexed caps

Wallet keys (`api_keys` id `wallet:<address>`) get caps from `capsForStake()`:

- Unstaked: 60/min, 2,000/day, 40,000/month.
- Staked (MOR on the MorScan builder subnet): burst = max(30, min(10000, 3 x MOR));
  monthly volume scales with a per-MOR bracket that rises with stake; daily = 5%
  of monthly.

Caps are written onto the key row at wallet verify and re-checked by the minute
cron (`refreshWalletCaps()`), so a stake change lands within a minute or two.

## Free introspection

`/health`, `/mor/v1/price`, and `/mor/v1/capacity` are never key-metered:
checking remaining capacity must not cost capacity. They ride a per-IP-only
budget (`checkIpRateLimit()`, default 60/min).

## Client feedback

Metered responses and 429s carry `X-RateLimit-Limit`/`-Reset` (and, where
known, `-Remaining`) plus `X-RateLimit-Limit-Day/-Month` and
`X-RateLimit-Remaining-Day/-Month`, so SDKs can back off before hitting a cap.
`POST /login` is additionally limited to 10 req/min per IP.

## Design notes

### Why not D1 for the minute layer?
A D1-backed minute counter would do read + increment + cleanup writes per
request, competing with sync writes for D1's write budget. Burst limits are
approximate by nature - an isolate recycling and losing its counters is fine.
The volume layer does use D1 (`usage_counters`), but amortized to two UPSERTs
per request with 60s-cached reads.

### Why not Durable Objects?
A DO would be authoritative across isolates but adds latency per request. The
rate-limiting bindings provide durable cross-isolate enforcement for the burst
layer without that cost; the in-memory path remains only as the unconfigured
fallback.
