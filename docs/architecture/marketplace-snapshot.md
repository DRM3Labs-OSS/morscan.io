# Marketplace Snapshot (CDN) - OPTIONAL

> **Optional subsystem.** Off unless an R2 bucket (`SNAPSHOT_BUCKET`) is bound;
> the snapshot writer no-ops without it. Not required to run MorScan.

MorScan can publish a signed, slim marketplace JSON to R2 every 3 minutes.
Consumers read it from a CDN custom domain instead of hitting the Worker, so the
Worker can wobble without taking downstream consumers down.

This feature is **optional**. It no-ops gracefully unless the `SNAPSHOT_BUCKET`
R2 binding is enabled in `wrangler.toml` and `MORSCAN_MNEMONIC` is set. The `*/3`
cron still fires; `writeMarketplaceSnapshot()` simply returns when the binding
is absent.

Throughout this doc, `${SNAPSHOT_PUBLIC_HOST}` is the public host you configure
(the `SNAPSHOT_PUBLIC_HOST` var, e.g. `snapshot.morscan.example.com`).

## Shape

Two R2 objects per cycle, fronted by `${SNAPSHOT_PUBLIC_HOST}`:

```
${SNAPSHOT_PUBLIC_HOST}/
├── marketplace-latest.json         ← pointer, 30s edge TTL
└── marketplace-<unix_ts>.json      ← full payload, immutable, infinite TTL
```

### `marketplace-latest.json` (pointer)

```json
{
  "v": 1,
  "url": "marketplace-1745123456.json",
  "ts": 1745123456,
  "signed_at": 1745123456,
  "signer_key_id": "morscan-snapshot-2026-07-a",
  "min_sdk_version": "0.9.0",
  "public_key": "ed25519:..."
}
```

Consumers read this first. Treat as having `Cache-Control: max-age=30`. Tiny
(~200 bytes), cheap to revalidate every refresh cycle.

### `marketplace-<ts>.json` (full payload)

```json
{
  "v": 1,
  "type": "morscan.snapshot.marketplace",
  "signed_at": 1745123456,
  "signer_key_id": "morscan-snapshot-2026-07-a",
  "min_sdk_version": "0.9.0",
  "providers": [
    { "address": "0x...", "endpoint": "..." }
  ],
  "bids": [
    {
      "bidId": "0x...",
      "provider": "0x...",
      "modelId": "0x...",
      "model": "llama-3.3-70b",
      "pricePerSecond": "0",
      "active": true
    }
  ],
  "models": [
    { "modelId": "0x...", "name": "llama-3.3-70b" }
  ],
  "_signature": {
    "algorithm": "Ed25519",
    "envelope_b64": "<base64(canonical_envelope_json)>",
    "signature_b64": "<base64(ed25519_sig)>",
    "public_key": "ed25519:<hex>",
    "signer_key_id": "morscan-snapshot-2026-07-a"
  }
}
```

Everything above `_signature` is the **signed envelope**. The envelope is
serialized canonically (top-level field order locked by the writer) and base64
encoded into `_signature.envelope_b64`. Consumers verify by:

1. base64-decoding `_signature.envelope_b64` to get the canonical envelope bytes.
2. Ed25519-verify `signature_b64` against those bytes using `public_key`.
3. Cross-check `public_key` against your well-known keys endpoint by
   `signer_key_id` (see [`provenance.md`](provenance.md)).

**Why verify the envelope bytes rather than the whole JSON object?** Consumers
may parse the JSON leniently (e.g. reordering nested keys during
serialization). Pinning signature verification to the exact bytes in
`envelope_b64` eliminates canonicalization disputes.

Target payload size: **under 100KB gzipped**. The bid list is capped at 1000
rows server-side; if you exceed that, shard (`marketplace-page-<n>-<ts>.json`)
rather than bloat a single object.

## Signing

- **Algorithm:** Ed25519 (same as the `@drm3labs-oss/provenance` npm package used for row-level provenance signing).
- **Signer:** derived from `MORSCAN_MNEMONIC` at path `drm3/snapshot/marketplace`.
  Reuses the provenance mnemonic so key custody is unchanged.
- **Key ID:** the `SNAPSHOT_SIGNER_KEY_ID` var (e.g. `morscan-snapshot-2026-07-a`).
  Rotate it on whatever cadence your key-rotation policy uses.
- **Public key publication:** publish the snapshot signer's public key at your
  well-known keys endpoint so consumers can look it up by `signer_key_id`.

## Kill switch - `min_sdk_version`

Every envelope carries `min_sdk_version`. Consumers should refuse to start if
their build version is below it. Bumping `min_sdk_version` in
`src/utils/snapshot.ts` and redeploying the Worker forces old consumer binaries
to upgrade within one snapshot cycle (≤3 min). The kill switch lives in a signed
value the consumer already reads on every refresh - no embedded secret.

## Cadence

Wired in `wrangler.toml` `[triggers].crons`:

```
crons = ["* * * * *", "*/3 * * * *", "0 3 * * *"]
```

The `src/index.ts` scheduled handler branches on `event.cron`:

| Cron          | Action                                                     |
| ------------- | ---------------------------------------------------------- |
| `* * * * *`   | delta sync + fatboy rebuild + DO liveness                  |
| `*/3 * * * *` | `writeMarketplaceSnapshot(env)` → R2 (no-op without bucket)|
| `0 3 * * *`   | `handleSnapshotPrune(env)` → delete R2 objects > 7 days    |

**Hard rule:** the snapshot writer does **not** run inside the SyncCoordinator
DO alarm loop. The cron path is independent so the delicate sync loop is never
touched.

## Infrastructure

### R2 bucket

- **Binding:** `SNAPSHOT_BUCKET` (commented out by default in `wrangler.toml`).
- **Bucket name:** e.g. `morscan-marketplace-snapshot`. Create it
  (`wrangler r2 bucket create ...`) before enabling the binding.
- **Public custom domain:** bind `${SNAPSHOT_PUBLIC_HOST}` to the R2 bucket in
  the Cloudflare dashboard.

### CF Cache rules (configure in dashboard)

| Path pattern                                   | Edge TTL |
| ---------------------------------------------- | -------- |
| `${SNAPSHOT_PUBLIC_HOST}/marketplace-latest.json` | 30s   |
| `${SNAPSHOT_PUBLIC_HOST}/marketplace-*.json`      | infinite (`max-age=31536000, immutable`) |

The writer also sets `Cache-Control` on the R2 object so downstream caches
behave correctly even without a CF cache rule.

### Prune

`handleSnapshotPrune(env)` runs daily at 03:00 UTC. It lists all
`marketplace-<ts>.json` objects and deletes anything older than 7 days.
`marketplace-latest.json` is preserved regardless of age. You can also graduate
this into an R2 lifecycle rule.

## Consumer expectations

Every consumer implements:

1. **Fetch pointer:** `GET ${SNAPSHOT_PUBLIC_HOST}/marketplace-latest.json`.
   Cache for 30s client-side.
2. **Fetch payload:** `GET ${SNAPSHOT_PUBLIC_HOST}/<pointer.url>`. Cache forever
   (it's immutable).
3. **Verify signature:** Ed25519 over the base64-decoded envelope bytes.
4. **Look up public key:** find `signer_key_id` in your key registry. Refuse to
   trust unknown signer IDs.
5. **Enforce `min_sdk_version`:** refuse to start if the local binary is too old;
   surface a clean upgrade message.
6. **Hard refresh:** append `?t=${Date.now()}` to the pointer URL to bust the
   edge cache.

## Relation to other MorScan surfaces

| Surface                                          | Who it serves                     | Auth                      |
| ------------------------------------------------ | --------------------------------- | ------------------------- |
| `marketplace-latest.json` + versioned (this doc) | SDKs, gateways, dashboards        | none (public CDN, signed) |
| `/mor/v1/all` + friends (Worker routes)          | the explorer UI, ad-hoc tools     | API key                   |
| `/mor/v1/ui-init` (fatboy)                       | MorScan's own SPA only             | UI JWT                    |

The Worker endpoints stay up; they're just no longer load-bearing for consumer
startup once the snapshot is enabled.

## Files

| File                             | Role                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| `src/utils/snapshot.ts`          | Envelope build, Ed25519 sign, R2 put, prune helper.            |
| `src/handlers/snapshot-prune.ts` | Thin wrapper called from the daily cron branch.                |
| `src/index.ts` (scheduled)       | Cron multiplex: routes `*/3 * * * *` and `0 3 * * *` patterns. |
| `wrangler.toml`                  | Cron list, `SNAPSHOT_BUCKET` R2 binding.                       |
| `src/types.ts`                   | `Env.SNAPSHOT_BUCKET?: R2Bucket`                               |
