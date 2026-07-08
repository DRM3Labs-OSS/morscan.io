# Dependency transparency

MorScan is built to be forked. This document is the complete, audited list of
everything the running Worker touches outside its own code: every external
service, every DRM3-specific integration, and every hardcoded network constant.
For each one it says whether it is required or optional, the env var that
controls it, how you replace or disable it, and what happens with nothing set.

For proving that a build and a running instance are honest (the copycat
question), see [REPRODUCIBILITY.md](REPRODUCIBILITY.md).

## What a fresh clone needs

A fresh clone needs a Cloudflare account and a Base L2 RPC endpoint, and nothing
else. On the Cloudflare side you create a D1 database and two KV namespaces and
paste their ids into `wrangler.toml` - a few `wrangler` commands, walked through
in [GETTING_STARTED.md](GETTING_STARTED.md). The Base RPC ships with a working
public default (`base.llamarpc.com`) committed in `wrangler.toml`, so that one is
optional to change. Everything else in this document is optional and
configurable, and nothing is bolted to DRM3's infrastructure.

Specifically, a zero-config clone (no secrets beyond the UI session key, no
`SSO_*`, no `MORSCAN_MNEMONIC`, no BigQuery, no snapshot bucket) runs:

- **wallet-first** - sign-in is EIP-191 `personal_sign` at `/console`. No
  identity provider is contacted. The "Sign in with DRM3" button is hidden
  unless you configure one.
- **on public RPC** - an 11-endpoint public Base RPC pool with per-call
  failover, plus your optional `RPC_URL` and `ALCHEMY_FALLBACK_URL`.
- **with on-chain pricing** - MOR/USD is read from a Base DEX pool and a
  Chainlink feed over that same RPC pool. No price API key. No CoinGecko on the
  hot path.
- **unsigned but honest** - responses are served without provenance receipts
  until you set your OWN `MORSCAN_MNEMONIC`. Signing no-ops gracefully; it never
  blocks a request. `PROVENANCE_ENABLED=false` makes the same unsigned mode an
  explicit switch: `/version` reports `provenance: "disabled"` and the signer
  WASM is never initialized.

## Default behavior with nothing configured

| Subsystem | Zero-config behavior | To turn it on |
|-----------|----------------------|---------------|
| Blockchain reads | Public Base RPC pool (11 endpoints) | Set `RPC_URL` / `ALCHEMY_FALLBACK_URL` for a private endpoint |
| MOR/USD + ETH/USD price | Read on-chain from Base DEX + Chainlink | Nothing to do; works out of the box |
| CoinGecko | Not on the hot path; last-resort fallback only | No key needed, ever |
| Identity / SSO | Disabled. Wallet-connect is the only sign-in | Set the `SSO_*` vars for an IdP |
| Provenance signing | No-op (responses unsigned) | Set your own `MORSCAN_MNEMONIC`. Explicit off-switch: `PROVENANCE_ENABLED=false` (the signer WASM is never initialized) |
| RPC failover pool | On (free public Base peers) | Off-switch: `RPC_POOL_ENABLED=false` uses a plain `fetch` POST to `RPC_URL` instead (no WASM) |
| Alerting channels | Alerts recorded to `/admin/alerts` only | Set any `ALERT_*` channel var |
| BigQuery archive | Off (D1 only) | Set `BIGQUERY_ENABLED=true` + project/dataset/key |
| R2 CDN snapshot | Writer no-ops (no binding) | Add the `SNAPSHOT_BUCKET` R2 binding |

## Full dependency inventory

Legend: **R** = required for the core explorer to function, **O** = optional.

### npm packages (`package.json`)

| Package | R/O | What it is | Notes for adopters |
|---------|-----|------------|--------------------|
| `@drm3labs-oss/provenance` (`^0.2.0`) | O | Ed25519 provenance signer (compiled WASM + JS bindings). | Published on npm; pinned in `package-lock.json`. MIT-licensed binary; source not published. Off-switch: `PROVENANCE_ENABLED=false` runs unsigned and never initializes the WASM. See "Provenance" below. |
| `@drm3labs-oss/rpc-pool` (`^0.2.8`) | O | Base RPC failover pool. | Published OSS (MIT), on npm + crates.io. No private registry. Off-switch: `RPC_POOL_ENABLED=false` uses a plain `fetch` POST to `RPC_URL` (no WASM). |
| `@noble/curves` (`^2.0.1`) | R | Ed25519 + secp256k1 primitives. | Used for wallet-signature verification. Standard library. |
| `@noble/hashes` (`^2.0.1`) | R | Hash primitives. | Standard library. |
| `@resvg/resvg-wasm` (`^2.6.2`) | R | SVG-to-PNG rasterizer (WASM). | Renders the social-preview (OG) images (`src/handlers/og-image.ts`). Standard library. |
| `@walletconnect/ethereum-provider` (`^2.23.10`) | R | WalletConnect provider. | Powers the wallet-connect flow on `/console`; bundled for the browser via `npm run build:wc`. Standard library. |
| `mustache` (`^4.2.0`) | R | HTML templating for the dashboard. | Standard library. |
| dev: `wrangler`, `typescript`, `@biomejs/biome`, `@cloudflare/workers-types`, `@playwright/test`, `esbuild` | R (dev) | Build, typecheck, lint, test. | All public. |

All seven runtime dependencies are published to the public npm registry: five
standard libraries plus two DRM3 Labs packages. There are no private or gated
packages. Both DRM3 packages carry an explicit off-switch
(`PROVENANCE_ENABLED=false`, `RPC_POOL_ENABLED=false`); switched off, neither
WASM module is ever initialized and the open core runs on nothing but
Cloudflare and your RPC.

### External services the running Worker can contact

| Service | R/O | Where | Purpose | Replace / disable |
|---------|-----|-------|---------|-------------------|
| Base RPC (public pool) | R | `src/sync/parsers-rpc.ts`, `src/utils/rpc.ts`, `src/utils/onchain-price.ts` | All chain reads: `eth_getLogs`, `eth_call`, balances, DEX price. | Set `RPC_URL` and/or `ALCHEMY_FALLBACK_URL` to your own endpoint. The 11 public endpoints stay as a safety net. |
| Base DEX pool + Chainlink feed | R | `src/utils/onchain-price.ts` | MOR/USD and ETH/USD price, read over the RPC pool. | These are Base mainnet contract addresses (network constants); read via whatever RPC you point at. |
| CoinGecko (`api.coingecko.com`) | O | `src/handlers/price.ts` | Last-resort price fallback if the on-chain read fails, and the historical chart baseline until enough on-chain points accrue. | No key required. Runs off the hot path; if you never want it, the on-chain read already covers the live price and your own `price_history` fills the chart over ~90 days. |
| Morpheus Dashboard Goldsky API (`dashboard.mor.org`) | O | `src/sync/builder-discovery.ts` | Supplements builder-subnet metadata (staker counts, names) that raw RPC cannot give. | Morpheus-ecosystem endpoint, not DRM3. Degrades gracefully: on any error the sync skips that chain and keeps on-chain data. |
| Alert channels: Telegram, Slack, Discord, generic webhook | O | `src/alerts/index.ts` | Operational paging on sync stalls / RPC failure. | Each is a separate `ALERT_*` var. Unset = that channel is skipped. Alerts always land in `/admin/alerts` regardless. |
| BigQuery (`*.googleapis.com`) | O | `src/utils/bigquery/client.ts` | Optional analytics dual-write archive. | `BIGQUERY_ENABLED=false` by default. Enable with project/dataset + a service-account key secret. |
| IdP hub (`SSO_HUB_URL`) | O | `src/routes/auth/sso.ts` | SSO sign-in bounce, only if you configure an IdP. | Unset = no contact; wallet-only. |

### Cloudflare primitives (bindings you create)

These are the platform your Worker runs on, not third-party dependencies. The
setup is in [GETTING_STARTED.md](GETTING_STARTED.md#3-create-the-database-and-caches).

| Binding | R/O | Purpose |
|---------|-----|---------|
| `DB` (D1) | R | The hot store: providers, bids, sessions, models, holders, economics, receipts, keys. |
| `SYNC_COORDINATOR` (Durable Object) | R | Owns the single 5-second `eth_getLogs` sync loop. |
| `NONCE_CACHE` (KV) | O | Best-effort wallet-sig / SSO replay dedup. Falls back to tight TTLs if absent. |
| `MORSCAN_CACHE` (KV) | O | API response cache to reduce D1 reads. |
| `SNAPSHOT_BUCKET` (R2) | O | Signed marketplace CDN snapshot target. Writer no-ops without it. |
| `RL_STANDARD` / `RL_STRICT` / `RL_LOW` (Rate limiters) | O | Durable rate limits. Fall back to per-isolate counters if absent. |

## External hosts the running Worker contacts

The complete list of outbound hosts, for a security review or an egress
allowlist. Everything marked optional is silent unless you configure it.

| Host | R/O | Why |
|------|-----|-----|
| The Base RPC endpoints in `RPC_ENDPOINTS` (llamarpc, publicnode, drpc, 1rpc, mainnet.base.org, tenderly, meowrpc, blastapi, blockpi, omniatech, nodies) + your `RPC_URL` + `ALCHEMY_FALLBACK_URL` | R | Chain reads and on-chain price. |
| `api.coingecko.com` | O | Price fallback + chart baseline. No key. |
| `dashboard.mor.org` | O | Builder-subnet metadata (Morpheus ecosystem). |
| `api.telegram.org` | O | Alert channel, only if `ALERT_TELEGRAM_*` set. |
| Your Slack / Discord / webhook URLs | O | Alert channels, only if the matching `ALERT_*` var is set. |
| `*.googleapis.com` (oauth2, bigquery) | O | BigQuery archive, only if `BIGQUERY_ENABLED=true`. |

**Not outbound calls (redirects or static links only), for the record:**

- `drm3.network` - the "by DRM3 Labs" credit link on the optional coming-soon
  page and the operator footer.
- `basescan.org`, `github.com/MorpheusAIs` - links rendered into the UI / API
  responses. The Worker never fetches them.
- `unpkg.com`, `fonts.googleapis.com`, `fonts.gstatic.com`,
  `static.cloudflareinsights.com` - present in the Content-Security-Policy
  allowlist (`src/handlers/ui/shared.ts`) but NOT referenced by any shipped
  HTML. The Worker serves its own fonts and scripts. The Cloudflare Web
  Analytics beacon loads only if YOU enable it in the Cloudflare dashboard; the
  code does not inject it.

## DRM3-specific integrations

This is the exact list of what is DRM3, and how to run without each. None of
these are required, and none break a non-DRM3 clone.

### 1. Identity / SSO (the clearest coupling)

MorScan can accept single-sign-on launch tokens from an identity provider you
configure. There is no default provider; the interface is generic:
it verifies a short-lived, audience-bound, single-use token offline against
**your** app key. There is no call home; verification is local (`src/utils/sso-launch.ts`).

| Var | Default | Effect when unset |
|-----|---------|-------------------|
| `SSO_APP_KEY` (secret) | unset | The whole IdP path is disabled. |
| `SSO_LAUNCH_URL` | unset | The "Sign in with <IdP>" button is hidden. |
| `SSO_APP_ID` | `morscan` | Token audience id. |
| `SSO_HUB_URL` | `https://idp.example.com` | IdP hub; unset = local /console fallback. 302 target on a failed callback. |
| `IDP_NAME` | `DRM3` | The name on the sign-in button. |
| `REGISTER_URL` | `/about` (or `/api/playground`) | Where the signup link points. |

**To run without any IdP:** set none of these. Wallet-connect is the default and
only sign-in. **To wire your own IdP:** point `SSO_LAUNCH_URL` / `SSO_HUB_URL` at
it, set `IDP_NAME` and `SSO_APP_ID`, and put your derived `SSO_APP_KEY` in as a
secret. The token format is documented in `src/utils/sso-launch.ts`.

### 2. Provenance (npm package + your own signer)

The signer is the npm package `@drm3labs-oss/provenance` (`^0.2.0`, compiled
WASM + JS bindings, pinned in `package-lock.json`). It is generic Ed25519
receipt signing. **The keys are yours:** receipts are signed with keys derived
from `MORSCAN_MNEMONIC`, a mnemonic YOU generate. DRM3 cannot sign your
instance's receipts, and you cannot sign DRM3's. This is the integrity guarantee
against copycats (see [REPRODUCIBILITY.md](REPRODUCIBILITY.md)).

To run your own signed instance: generate a real BIP39 mnemonic and set it as
the `MORSCAN_MNEMONIC` secret. Your public keys then publish automatically at
`/.well-known/morscan-keys.json`. Leave it unset and responses are simply
unsigned; the explorer still works. To refuse the package outright, set
`PROVENANCE_ENABLED=false`: same unsigned behavior, plus `/version` reports
`provenance: "disabled"` and the WASM is never initialized, so none of its code
executes. See "What to change when you fork" below for one attestation string
worth editing.

### 3. Brand assets

The favicon and header mark are DRM3 brand PNGs
(`src/images/drm3-icon-*-consumer-128.png`, served from `src/handlers/ui/assets.ts`).
An adopter should swap these for their own icon. They are hosted by the Worker
itself (no external CDN), so they do not create a runtime dependency, only a
branding one.

### 4. Status monitor

MorScan does not depend on an external status monitor. There is no
code path that contacts it. (DRM3 monitors MorScan externally; a clone does not
need it.)

## Morpheus network constants (correct to hardcode)

These are Base mainnet contract addresses. They are properties of the Morpheus
network, not of any operator, so hardcoding them is correct. An adopter changes
them only to index a different deployment (e.g. a testnet).

| Constant | Address | Configurable via |
|----------|---------|------------------|
| Diamond (marketplace) | `0x6aBE1d282f72B474E54527D93b979A4f64d3030a` | `DIAMOND_ADDRESS` var |
| BuildersV4 proxy | `0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9` | `BUILDER_CONTRACT` var |
| MOR token | `0x7431aDa8a591C955a994a21710752EF9b882b8e3` | hardcoded |
| WETH (Base) | `0x4200000000000000000000000000000000000006` | hardcoded |
| MOR/WETH Uniswap v3 0.3% pool | `0x37ecd41f5a01b23a3d9bb3b4ddfef4ed455d6fd3` | hardcoded (`onchain-price.ts`) |
| Chainlink ETH/USD | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | hardcoded (`onchain-price.ts`) |

The price constants (pool, Chainlink, WETH, the factories used to discover them)
are centralized and documented in `src/utils/onchain-price.ts`, including how the
pool was found and verified.

## What to change when you fork

The receipt metadata in `src/utils/provenance-sign.ts` hardcodes the attestation
string `attestation: "DRM3 Labs attests ..."` (plus `vendor: "Base Mainnet"` and
`vendor_uri`) into every signed receipt's `_meta`. This is cosmetic, it is not
part of the signed hash's integrity, but a fork's receipts would read "DRM3 Labs
attests" unless you edit that string to name your own operator.

## See also

- [REPRODUCIBILITY.md](REPRODUCIBILITY.md) - proving the build and the runtime.
- [GETTING_STARTED.md](GETTING_STARTED.md) - full setup and the complete env-var
  reference.
- [architecture/sync.md](architecture/sync.md) - the RPC pool and failover.
- [architecture/provenance.md](architecture/provenance.md) - row signing, service
  attestation, and the `/.well-known/morscan-keys.json` key-discovery endpoint.
