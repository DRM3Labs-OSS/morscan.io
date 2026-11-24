# Rate Limiting and Metering

> **Status: LIVE** - 2026-11-24. Describes rate limiting, metering and the global ceilings as deployed.

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

## Per-door IP pools

A door that asks `checkRateLimit` / `checkIpRateLimit` for a tighter per-IP
limit than the API's 100/min gets the fixed pool that holds it (`ipPool()`):
10/min `RL_LOW` (`POST /login`, `POST /notify`), 30/min `RL_STRICT`
(`/teaser`, the wallet challenge and verify, `POST /mor/v1/keys/purchase`),
60/min `RL_MED` (`/mor/v1/capacity`), each under its own key
(`ip:<path>:<ip>`). So the limit a door names is the limit it gets, and a
flood of one door never spends another door's or the API's budget. The
default door (every `/mor/v1` call) stays `RL_STANDARD` under `ip:<ip>`.

## Global ceilings (exact)

Per-IP limits stop one address. A botnet has thousands, so every door a
stranger can make expensive also has a GLOBAL ceiling, counted exactly by
the `CallMeter` Durable Object (`src/durable/CallMeter.ts`, called through
`meterTake()` in `src/utils/call-meter.ts`; one object per counting key,
single-threaded; a hot key is spread over shards that each hold their share
of the limit, so the total admitted never exceeds it). Only paths that
already pay a database round trip call it (a cache miss, a write done off the
response path), so a request served from a cache never waits on it.

| Door | Ceiling | When it is passed | On a counter error |
|------|---------|-------------------|--------------------|
| Detail-page render (`/compute/providers/<addr>`, `/compute/consumers/wallet/<addr>`, `/compute/models/<id or slug>`, `/builder/subnet/<id>`), cache miss only | 300 renders/min for everyone; 120/min for crawlers Cloudflare has verified, counted apart so a flood never starves search engines. First shed: 100 renders/min per IP (`RL_STANDARD`, `render:<ip>`). `src/utils/render-budget.ts` | 429, `Retry-After` | open |
| `/mor/v1/sessions` cache miss by a free caller | 120/min | 429, `Retry-After` | open |
| Heavy uncached reads (`d1-budget.ts`) | a day budget per caller class | 503, `Retry-After` to 00:00 UTC | open |
| Usage-log rows (`usage-track.ts`) | 600/min and 50,000/UTC day; past 100 rows/min from one IP its rows are sampled 1 in 20 at weight 20 | row not written | closed (row dropped) |
| `POST /notify` signups | 200/UTC day | 429, `Retry-After` | closed |
| Wallet challenges minted | 300/min | 429, `Retry-After` | open |

Without the `CALL_METER` binding the per-IP limits still apply and the
global ceilings are off.

## Caller classes

`src/utils/caller-class.ts` names who pays for a call, and the
shared-database guards budget by it: `admin` (never shed); `paid` (call packs,
x402 payments, keys whose stake raised their burst above the free tier);
`free` (the public serving key, wallet-signature callers, bottom-tier keys).
Free traffic can only spend free budgets: the D1 read budget has one per
class (`D1_FREE_READ_BUDGET`, default half of `D1_DAILY_READ_BUDGET`), and it
is taken before a pack debit or an x402 settlement, so a shed call is never
charged. A free caller's `/mor/v1/sessions` reaches page 50 at most (keyed
and paying callers keep 1000), and its signed receipts ship inline without a
stored copy.

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

### Why not Durable Objects for every request?
A DO is authoritative across isolates but adds a round trip to wherever the
object lives. The rate-limiting bindings give the per-IP burst layer
cross-isolate enforcement without that cost, so a DO counter (`CallMeter`)
is used only for the global ceilings above, on paths that already pay a
database round trip; the in-memory path remains only as the unconfigured
fallback for the bindings.
