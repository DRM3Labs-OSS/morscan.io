# Provenance - row-level signing and key discovery

MorScan signs every row of its data endpoints with an Ed25519 receipt and an
aggregate Merkle root, periodically chains those receipts into a service
attestation, and publishes the public keys at a stable well-known endpoint, so
any consumer can verify both individual rows and the response envelope offline.

## Row-level signing

Every row response uses the same pattern. The helper is `signBatchResponse`
(implemented in `src/utils/provenance-sign.ts`, re-exported from
`src/utils/provenance.ts`), which signs each row with `ReceiptBuilder` and chains
the receipts with `Chain` from the
[`@drm3labs-oss/provenance`](https://www.npmjs.com/package/@drm3labs-oss/provenance)
npm package.

| Endpoint | Action | Producer | Handler |
|---|---|---|---|
| `/mor/v1/providers` | `blockchain.providers` | `morscan/cache` | `src/handlers/marketplace.ts` |
| `/mor/v1/all` | `blockchain.all` | `morscan/cache` | `src/handlers/marketplace-all.ts` |
| `/mor/v1/models` | `blockchain.models` | `morscan/cache` | `src/handlers/models.ts` |
| `/mor/v1/sessions` | `blockchain.sessions` | `morscan/cache` | `src/handlers/sessions-list.ts` |

### Response shape

```json
{
  "providers": [
    { "address": "0x…", "_receipt": "rcpt_…" },
    { "address": "0x…", "_receipt": "rcpt_…" }
  ],
  "_provenance": {
    "service": "morscan",
    "producer": "morscan/cache",
    "receipt_count": 247,
    "merkle_root": "sha256:…"
  },
  "_provenance_aggregate": { /* legacy aggregate Receipt - kept for backward compat */ }
}
```

`_provenance_aggregate` (a single full Receipt over the response body) is
preserved on every endpoint so older consumers that parse the legacy shape
continue to work. New consumers should read `_provenance` and per-row `_receipt`
IDs.

## Unsigned mode (the off-switch)

Provenance is optional. An instance runs unsigned in either of two ways: leave
`MORSCAN_MNEMONIC` unset (signing no-ops), or set `PROVENANCE_ENABLED=false`
(the explicit switch). In unsigned mode responses carry none of the receipt
fields above, `/version` reports `provenance: "disabled"` when the switch is
off, and the `@drm3labs-oss/provenance` WASM module is never initialized
(init is lazy in `src/utils/provenance-core.ts`; no signing call site is ever
reached). `/mor/v1/provenance` stays readable but marks `signing: "disabled"`
and serves only historical receipts. The runnable verifier reports an honest
`UNSIGNED` result against such an instance instead of implying tampering.

## Service attestation

MorScan runs a periodic Merkle batching job (`chainReceipts()` in
`src/utils/provenance.ts`) that groups receipts into chains. The service signer
(`morscan/signer`, derived from `MORSCAN_MNEMONIC` via `@drm3labs-oss/provenance`)
signs the chain root and writes it into the `service_attestations` D1 table. The
latest attestation is exposed in `/.well-known/morscan-keys.json` (the
`latest_attestation` field).

## Key discovery: `/.well-known/morscan-keys.json`

Publishes the Ed25519 public keys a MorScan instance uses to sign provenance
receipts and service attestations, so consumers of that instance can verify
signatures offline.

`GET /.well-known/morscan-keys.json` (public, no auth, `Cache-Control: public, max-age=60`).

The schema is `drm3-keys/v2`: `current[]` + `history[]` arrays where every key
carries an explicit lifecycle `status`, `valid_from`, and (optionally)
`valid_until` / `expected_valid_until`. The status values (enforced by a CHECK
constraint on the `key_history` D1 table, see `schema.sql`) are:

| Status | Meaning |
|--------|---------|
| `current` | Active signing key; appears in `current[]` |
| `superseded` | Rotated out on schedule; historical signatures remain valid |
| `compromised` | Key material exposure; reject |
| `revoked` | Withdrawn for other reasons; reject |
| `retired` | Decommissioned, no longer in use |

Verifiers MUST reject keys with status `compromised` or `revoked`. All
non-`current` keys appear in `history[]`.

```json
{
  "schema": "drm3-keys/v2",
  "service": "morscan",
  "product": "MorScan",
  "algorithm": "Ed25519",
  "current": [
    {
      "path": "morscan/cache",
      "key": "ed25519:…",
      "valid_from": "2026-01-01T00:00:00Z",
      "expected_valid_until": "2027-01-01T00:00:00Z",
      "status": "current",
      "note": "Initial production key. Scheduled annual rotation."
    },
    {
      "path": "morscan/signer",
      "key": "ed25519:…",
      "valid_from": "2026-01-01T00:00:00Z",
      "expected_valid_until": "2027-01-01T00:00:00Z",
      "status": "current",
      "note": "Initial production signer. Scheduled annual rotation."
    }
  ],
  "history": [],
  "published": "…",
  "latest_attestation": {
    "id": "...",
    "merkle_root": "...",
    "receipt_count": 12345,
    "from_timestamp": "2026-06-11T00:17:03.820+00:00",
    "to_timestamp":   "2026-06-11T00:17:05.089+00:00",
    "signature": "...",
    "public_key": "ed25519:...",
    "created_at": "..."
  }
}
```

Non-`current` entries also carry `valid_until` and `rotation_reason` when set.
`latest_attestation` is `null` when the `service_attestations` D1 table is empty
(e.g. fresh deploy).

### The two keys

Both keys are derived from `MORSCAN_MNEMONIC` via the `Keyring` in
`@drm3labs-oss/provenance`:

| Path            | Used by                                                          |
|-----------------|------------------------------------------------------------------|
| `morscan/cache`  | Per-row receipt signing on `/mor/v1/providers` and `/mor/v1/all` |
| `morscan/signer` | Service-level attestation receipts (Merkle root over batches)   |

## Verification

The canonical verifier is runnable, so consumers do not have to re-implement the
steps:

```bash
npm run verify:receipt                                      # checks /mor/v1/price
node scripts/verify-receipt.mjs https://morscan.io/version  # any signed endpoint
```

The same check also runs in a browser at `GET /verify` (`src/ui/pages/verify.html`):
the page fetches a live signed response, walks through each verification step in
plain words, and runs the Ed25519 math with WebCrypto on the visitor's machine.
Its verification core is a line-for-line port of `scripts/verify-receipt.mjs`;
`tests/unit/verify-page.test.ts` holds the two implementations byte-for-byte
equal against a fixture captured from the live API.

It fetches a signed response, recomputes the receipt hash, verifies the Ed25519
signature, and confirms the signing key is published at
`/.well-known/morscan-keys.json` with a validity window covering the receipt. The
full step-by-step offline procedure (and why a copycat cannot fake it) is in
[`../REPRODUCIBILITY.md`](../REPRODUCIBILITY.md); this doc does not repeat it.

## Relation to `/mor/v1/provenance`

`/mor/v1/provenance` (auth-gated) returns receipt history, action counts, and
chain metadata. It is **not** replaced by the well-known endpoint: `well-known`
is the public, schema-stable key advertisement a running instance's consumers use
to verify its signatures; `/mor/v1/provenance` remains the rich, gated view.

## Code

- Row/aggregate signing: `src/utils/provenance-sign.ts`, `src/utils/provenance.ts`
- Well-known handler: `src/handlers/well-known.ts`
- Route wired in `src/routes/public.ts` (`/.well-known/morscan-keys.json`)
- Key state: `key_history` + `service_attestations` D1 tables (`schema.sql`)
- Keypair derivation: `src/utils/provenance.ts` (`getSignerPublicKey`, `getServiceSignerPublicKey`)
