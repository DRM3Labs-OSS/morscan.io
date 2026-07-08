# Changelog

Releases are tagged vX.Y.Z on GitHub.

## Unreleased

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
