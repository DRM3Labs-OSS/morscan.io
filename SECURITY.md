# Security Policy

## Supported versions

Only the latest released version of MorScan is supported with security fixes.

## Reporting a vulnerability

Please report security issues **privately**. Do **not** open a public GitHub issue,
pull request, or discussion for a vulnerability.

Email **morscan@drm3.io** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal request, config, or proof of concept helps),
- any relevant logs or output.

We will acknowledge your report, work with you on a fix, and coordinate disclosure. We
appreciate responsible disclosure and will credit reporters who want it once a fix ships.

## Scope

In scope:

- The MorScan Worker and its API (`src/`), including authentication, the wallet-connect
  and API-key flows, rate limiting, and the sync/indexing path.
- The provenance signing and verification path and the published
  key discovery endpoint (`/.well-known/morscan-keys.json`).
- Anything in this repository that could let a request read or write data it should not,
  bypass a gate, forge a signed receipt, or take down the indexer.

Out of scope:

- The internals of the `@drm3labs-oss/provenance` npm package (compiled WASM,
  separately licensed) beyond how MorScan calls it.
- Third-party services MorScan depends on (Cloudflare, Base RPC providers, CoinGecko)
  and their own vulnerabilities.
- Findings that require operator-side misconfiguration already warned against in the docs
  (for example, deploying without `MORSCAN_JWT_SECRET`, or committing secrets).
- Volumetric or denial-of-service testing against a live deployment you do not operate.

If you are unsure whether something is in scope, email us and ask.
