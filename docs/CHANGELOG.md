# Changelog

Releases are tagged vX.Y.Z on GitHub.

## Unreleased

## v2.46.0 - 2026-07-18 - canonical model URLs

The pretty spelling: `/compute/models/kimi-k3`. Canonical model names get
canonical URLs.

- Every canonical model resolves at the slug of its display name; the page
  is the same aggregated view as the listing-id URLs, which keep working
  forever. Arriving via a listing id swaps the address bar to the slug
  (same document, no redirect), and `rel="canonical"` points every spelling
  at the slug URL. Slug collisions keep the first-listed group; the others
  stay on their id URLs.
- The sitemap lists every canonical model URL (generated from the live
  registry, cached an hour), so crawlers discover models by name.
- The family table links canonical models by slug; the API exposes
  `model.slug` and per-family-model slugs.

## v2.45.0 - 2026-07-18 - canonical model pages

A model page is now about the MODEL, not one registration. "Kimi K3" can be
listed on chain many times, under many spellings, by any number of
providers; the page aggregates all of it.

- Canonical grouping: listings whose normalized names agree ("Kimi K3",
  "moonshotai/kimi-k3", "Kimi-K3") render one page - providers offering the
  model, sessions, consumers, stake, asks, and the 30-day chart all span
  every listing. An On-Chain Listings table itemizes each registration.
  Every listing URL renders the same canonical page; the busiest listing is
  the SEO-canonical URL.
- ":web" and ":tee" variants fold in as capability badges (on the header,
  each bid, each listing, and each family row) instead of appearing as
  separate models.
- The family card collapses to canonical models (not raw listings), and its
  Providers Overall counts everyone who has served or is bidding across the
  family.
- Curation beats heuristics: new `models.family` and `models.canonical`
  columns pin a listing's family and canonical name (admin POST
  /mor/v1/models/:id accepts `family` and `canonical`); the name heuristic
  fills the rest.
- Description-gap workflow: the daily cron raises a `model_descriptions`
  alert when new listings arrive without a description (watermarked, so a
  listing is reported once), and `scripts/model-descriptions.mjs`
  emits/applies the fill (empty rows only, curation preserved).
- The /console connect view sits on one column: same width, same left edge
  for the copy, access cards, stake table, price widget, and key sign-in
  (previously a mix of centered 420px and left 460px blocks).

## v2.44.1 - 2026-07-18 - honest provider counts on model pages

- The model page's Providers tile now counts every provider that has served
  the listing or is bidding on it, so it can no longer read "0 providers"
  above a table of providers with real session history (it previously
  counted only live bidders).
- The no-bids state explains itself: how many providers have served the
  listing and when the last session opened, so retracted supply does not
  read as broken data. A note under the model id explains that a page is
  one on-chain registry listing that any provider can bid to serve.
- New guard test: package.json and src/version.ts must agree before any
  deploy or tag (a release was once tagged with the two skewed).

## v2.44.0 - 2026-07-18 - model detail pages

Every model gets a real page: `/compute/models/:modelId`.

- Landing-search model results now open the model's own page instead of
  jumping mid-page into the analytics table. Model names across the explorer
  (analytics Model Demand table, provider detail bids/reputation/sessions,
  the landing live feed, the market-tape "new model" items) click through.
- The page: name, registration date, curated description, active bids with
  providers and pricing (Lock 1hr / 10 MOR gets), the ask spread, a 30-day
  daily-session chart, per-provider reputation on the model, and recent
  sessions.
- The model family card: every flavor of the family (grouped by normalized
  name), each linked, with first-seen dates, per-flavor sessions and stake,
  TEE and web-search variant badges, and family-overall totals (sessions,
  distinct providers, MOR staked with an approximate USD figure).
- New signed API endpoint `GET /mor/v1/models/:modelId/detail` (OpenAPI +
  llms.txt documented). Model descriptions curated for ~300 registered
  models; unknown listings stay description-free rather than guessed at.
- Landing search: builder-subnet rows now show the subnet's current staked
  MOR inline.
- The compute plane's contract banner is one thin row again: the upgrade
  note rides inline (details in its tooltip) instead of wrapping the banner
  onto a second line.

## v2.29.0 - 2026-07-08 - the human verify page

`GET /verify` - a public, standalone page that verifies a live signed API
response in the visitor's own browser and narrates every step.

- The page fetches a signed response (default `/mor/v1/price`), finds its
  Ed25519 receipt, fetches the published keys from
  `/.well-known/morscan-keys.json`, and runs the signature math with WebCrypto
  locally: the server is not part of the verdict. Each step renders as it
  completes, in plain words, ending in a clear VERIFIED / FAILED / UNSIGNED
  verdict. The raw response JSON and the canonical signed payload sit in a
  collapsible panel.
- Any endpoint on the origin can be verified via an input, and any response or
  bare receipt JSON can be pasted in; both paths run the same walkthrough.
  Keyless calls to metered endpoints get an honest 402 explanation. Keys with
  status `compromised` or `revoked` are rejected per the drm3-keys/v2 schema.
- The verification core is a line-for-line port of
  `scripts/verify-receipt.mjs` (which stays the CLI/agent path).
  `tests/unit/verify-page.test.ts` evaluates the shipped page script and the
  shipped CLI script from disk and holds them byte-for-byte equal against a
  receipt captured from the live API, then verifies that real signature
  through the page's own WebCrypto path.
- Browsers without Ed25519 WebCrypto get a graceful pointer to the CLI
  verifier instead of a false failure.
- The composed footer stamp's "verify" link now points at `/verify` (the
  human walkthrough); `/version` stays the machine receipt and is linked from
  the page. `/verify` joins the sitemap, `/about`'s provenance section,
  `llms.txt`, and `/auth.md`.
- New spec: `docs/specs/compute-provider-pool.md` (Proposed) - track the
  compute provider pool itself (balance, emission flows, provider claims) and
  fill the empty Daily Emissions and APR columns on `/pools`.

## v2.28.0 - 2026-07-07 - sovereignty switches

Every DRM3-published dependency is now optional with an explicit off-switch.

- `PROVENANCE_ENABLED` (default `true`): set `false` to run unsigned - no
  receipt fields on responses, `/version` reports `provenance: "disabled"`,
  `/mor/v1/provenance` marks `signing: "disabled"`, and the
  `@drm3labs-oss/provenance` WASM is never initialized (lazy init; the disabled
  path never touches the blob). Unset behaves exactly as before.
- `RPC_POOL_ENABLED` (default `true`): set `false` to replace the
  `@drm3labs-oss/rpc-pool` failover pool with a plain `fetch` single transport
  (POST to `RPC_URL`, one honest retry); the pool WASM is never initialized.
- `/version` gains an explicit `provenance: "enabled" | "disabled"` marker.
- `scripts/verify-receipt.mjs` reports `UNSIGNED` (not `FAIL`) against an
  instance running with provenance off.
- Docs: README "Optional dependencies" section; env tables and dependency
  inventory updated; the BigQuery dual-write doc rewritten spare as
  `docs/architecture/bigquery-dual-write.md`; alerting doc gains the live
  tested-state line (D1 recording + admin surface + Telegram verified live;
  Slack/Discord/webhook senders unit-tested only).
- Tests: 11 new unit tests (provenance switch golden/disabled paths, rpc-pool
  plain transport + retry + no-WASM assertions); suite now 109 green.
