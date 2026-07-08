# Reproducibility: proving the build and the runtime

MorScan is source-open, so anyone can clone it, and anyone can stand up a
copycat. This document explains how to prove two separate things:

1. **The build** you are running is really this source (nothing hidden was
   compiled in).
2. **The runtime** is honest: the data it serves is what it claims, and it comes
   from the operator whose keys are published, not from an impostor.

The second point is the important one for copycats: a copycat can copy the code,
but **cannot forge signed receipts without the private mnemonic behind the
published keys.** Signatures, not code secrecy, are the integrity guarantee.

## Part 1: proving the build

MorScan is a single Cloudflare Worker with a tiny, fully public dependency set.
There is nothing to trust in the toolchain that you cannot re-run yourself.

### Green checks (run them yourself)

```bash
npm ci            # install exactly the locked dependency tree
npm run typecheck # tsc --noEmit, zero errors
npm run lint      # biome, zero errors
npm run build     # wrangler deploy --dry-run: a full bundle + build check
npx playwright test   # auth, login-flow, and health-contract specs
```

`npm ci` installs from `package-lock.json`, so the dependency tree is pinned and
reproducible. The lockfile is committed.

### Deterministic-ish inputs

- **Seven runtime dependencies**, all published to the public npm registry (see
  [DEPENDENCIES.md](DEPENDENCIES.md#npm-packages-packagejson)). No private
  registry, no gated package.
- **The provenance signer is a pinned npm package**, `@drm3labs-oss/provenance`
  (compiled WASM + JS bindings). The committed `package-lock.json` locks its
  exact resolved version and integrity hash, which `npm ci` enforces. Verify the
  pin yourself:

  ```bash
  npm ls @drm3labs-oss/provenance
  grep -A3 '"node_modules/@drm3labs-oss/provenance"' package-lock.json
  # shows the resolved tarball URL and its sha512 integrity hash
  ```

- **No build-time code generation** pulls from the network. `wrangler deploy`
  bundles the committed source and the locked dependencies, nothing else.

### What a reviewer verifies

- The `package-lock.json` integrity hashes match what npm resolves, including
  the pinned `@drm3labs-oss/provenance` version.
- `npm run build` produces a bundle with no surprise network origins (the CSP in
  `src/handlers/ui/shared.ts` and the outbound-host list in
  [DEPENDENCIES.md](DEPENDENCIES.md#external-hosts-the-running-worker-contacts)
  are the complete egress surface).

## Part 2: proving the runtime is honest

Every data response MorScan serves can be verified offline against published
Ed25519 keys. You do not have to trust the indexer; you check it.

### The signing model

When `MORSCAN_MNEMONIC` is set, MorScan signs with Ed25519 keys derived from that
mnemonic:

- `morscan/cache` signs individual data receipts.
- `morscan/signer` signs the periodic service attestation (a Merkle root over a
  batch of receipts).

The mnemonic is a **secret the operator generates and holds.** It is never in the
repo, never sent anywhere, and is the sole thing that can produce a valid
signature under the operator's published public key.

Signing is optional: with `MORSCAN_MNEMONIC` unset or `PROVENANCE_ENABLED=false`
an instance runs honestly unsigned - no receipt fields on responses, `/version`
reports `provenance: "disabled"` when the switch is off, and the signer WASM is
never initialized. Everything in this section applies only to signed instances;
against an unsigned one the verifier reports `UNSIGNED` rather than `FAIL`.

### The published keys

Public keys are served at:

```
/.well-known/morscan-keys.json      # schema drm3-keys/v2
```

The response carries `current` keys and full rotation `history`, each with a
lifecycle `status` (`current` / `superseded` / `compromised` / `revoked` /
`retired`) and validity windows, plus the latest service attestation. This lets a
verifier interpret which key was valid when a receipt was signed.

### Offline verification steps

The steps below are automated by a runnable verifier, so you do not have to
re-implement them:

```bash
npm run verify:receipt                                      # checks /mor/v1/price
node scripts/verify-receipt.mjs https://morscan.io/version  # any signed endpoint
```

This is the single canonical walkthrough; other docs point here rather than
repeat it. Anyone, with no access to the running instance beyond fetching two
public URLs, can verify a response by hand:

1. Fetch the public keys from `/.well-known/morscan-keys.json`.
2. Fetch a data endpoint, e.g. `/mor/v1/providers`. Each row carries a `_receipt`
   id; the response carries a `_provenance` envelope with the producer, receipt
   count, and Merkle root.
3. Recompute each row's canonical hash and confirm it matches its receipt.
4. Verify each receipt's Ed25519 signature against the `current` (or
   validity-window-matched historical) public key. Any standard Ed25519 library
   works; MorScan itself uses `@noble/curves` for its wallet-signature
   verification, so no WASM is required to verify.
5. Recompute the Merkle root from the row receipts and match it to `_provenance`.
6. Cross-check the latest service attestation from the well-known endpoint.

If any step fails, the data was altered or was not produced by the holder of the
published key.

### Why a copycat cannot fake it

A copycat can clone the code and even copy your public keys into their own
`/.well-known/morscan-keys.json`. They still cannot produce receipts that verify,
because:

- Signing requires the **private** mnemonic, which is never published.
- Copying your public key does not let them sign; Ed25519 verification would fail
  for anything they sign with a different key.
- If they publish their OWN key and sign with their OWN mnemonic, the receipts
  verify against THEIR key, not yours. A consumer who pins the real operator's
  key (or discovers it from a trusted origin) will reject the impostor.

So the trust anchor is: **which public key does the consumer trust, and does the
data verify against it.** Code being open changes nothing about that guarantee.

### Honest freshness at `/health`

`/health` reports sync state without spin. It reads the REAL current block from
RPC (`getCurrentBlock`, `src/utils/rpc.ts`) rather than estimating from wall
clock, so lag can never be masked by an estimate. The endpoint exposes
`syncedBlock`, `currentBlock`, `blocksBehind`, and `lastSyncTs` so a monitor can
judge staleness itself. A stalled sync surfaces here within about a minute, and
the cron watchdog reschedules it (see
[architecture/sync.md](architecture/sync.md)).

## Summary

| Claim | How you prove it | Trust anchor |
|-------|------------------|--------------|
| The build is this source | `npm ci` + green checks + lockfile integrity hashes | Public lockfile on a public registry |
| The data is unaltered | Recompute row hashes vs receipts | Canonical hashing |
| The data is from the real operator | Verify Ed25519 receipts vs published keys | The operator's private mnemonic |
| The instance is fresh | `/health` real-block freshness | On-chain block height |

See [DEPENDENCIES.md](DEPENDENCIES.md) for the full dependency and integration
inventory.
