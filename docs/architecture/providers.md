# Providers (the open-core seam)

MorScan is open-core. The OSS repo defines a small set of stable provider
**interfaces** and ships bundled **reference implementations**. The reference
impls make the standalone OSS product fully functional and behaving identically
to the hosted site. Proprietary features live in **private repos** that
implement one of these interfaces and are composed at a single wiring point.

This is the same pattern Sentry and Grafana use:

- **Sentry / getsentry**: the OSS `sentry` core defines the interfaces; the
  private `getsentry` repo **imports the OSS core as a dependency** and
  composes the billing/quota/SaaS layer on top - the private repo is the
  deployment root, the OSS repo is a library it consumes. The OSS core is
  fully usable on its own reference behavior.
- **Grafana OSS + Enterprise plugins**: OSS Grafana defines plugin interfaces;
  Enterprise features are plugins that satisfy those interfaces. OSS Grafana
  runs fully without them.

MorScan follows the Sentry shape exactly: **the OSS core defines the interface
and a composition factory; a private composition repo imports the core as a
pinned dependency, injects its providers through the factory, and deploys; the
OSS build is fully functional on the bundled reference impls.**

Everything pluggable lives in ONE folder: [`src/providers/`](../../src/providers/).
Its [README](../../src/providers/README.md) is the quick plug map (seam table,
factory snippet); this document is the full story.

## The three seams

Each seam is an interface plus a bundled reference implementation. The
reference impls are thin, behavior-preserving delegations to the existing
code, so each concern still has exactly one definition (DRY); the provider
object is only the injection seam.

### 1. CommerceProvider (`src/providers/commerce/`)

The seam for offers + payments + capacity. This is the forward-looking home of a
real offer/pricing engine and x402 settlement.

| Method | Reference (OSS standalone) behavior |
|--------|-------------------------------------|
| `capsForStake(mor)` | Stake-indexed caps: free connected-wallet tier (60/min, 2,000/day, 40,000/month) rising with live MOR stake. Delegates to `utils/stake-tier`. |
| `capacity(env, auth, headers)` | The free `/mor/v1/capacity` readout (reports quota, never spends it). Delegates to `handlers/capacity`. |
| `paymentsEnabled(env)` | x402 is live only when `X402_PAY_TO` is set. |
| `paymentRequired(env, resource, error?)` | The HTTP 402 x402 envelope for a keyless metered call. |
| `verifyPayment(env, header)` | Full server-side EIP-3009 / EIP-712 verification of an `X-PAYMENT` header. |
| `settlePayment(...)` | **Verify-only** (default): verify + queue the signed authorization in D1 for batch settlement; no on-chain broadcast. Facilitator mode when `X402_FACILITATOR_URL` is set. |
| `getOffers(env)` | The LIVE access doors (free key / stake / x402 per-call), machine-readable, from the canonical definition in `src/providers/commerce/offers.ts`. Every public surface that describes access (the 402 envelope, /llms.txt, /auth.md, the MCP server card, OpenAPI descriptions) renders from that module; the per-call door is included only when x402 is actually enabled. |
| `quote(env, resource)` | **Stub**: today there is exactly one price surface, the flat x402 per-call price; returns the live x402 requirements. |
| `grantCalls(payer, calls)` | **Stub**: verify-only, no call-balance ledger; documented no-op. |

`src/providers/commerce/offers.ts` is the single source of truth for access
copy: caps delegate to `capsForStake`, the per-call price reads the live x402
config, and unbuilt doors (the designed call-balance pack; internal rate
constant only) are never rendered publicly until they work. A private
payments provider would implement purchasable offers, the call-balance
ledger, and on-chain settlement behind this same interface.

### 2. AnalyticsProvider (`src/providers/analytics/`)

The seam for analytics + warehouse reads.

| Method | Reference (OSS standalone) behavior |
|--------|-------------------------------------|
| `overview(env, headers)` | The D1-backed `/mor/v1/analytics` aggregate (gas + session-duration stats). Delegates to `handlers/analytics`. |
| `bqEnabled(env)` | Whether the optional BigQuery dual-write / archive tier is on. |
| `bqStatus(env, headers)` | `/mor/v1/bq/status`. Delegates to `handlers/bq`. |
| `bqBackfill(request, env, headers)` | `/mor/v1/bq/backfill` (admin-gated). Delegates to `handlers/bq`. |

**Standalone path is D1-only**, which is already the live default: BigQuery is
OFF unless `BIGQUERY_ENABLED=true` plus a service-account secret. A private
analytics provider would serve warehouse-backed analytics behind this
interface without changing any endpoint's response.

### 3. AdminProvider (`src/providers/admin/`)

The seam for operator / admin surfaces.

| Method | Reference (OSS standalone) behavior |
|--------|-------------------------------------|
| `isAdmin(auth, env)` | The admin identity gate: the `admin` api_keys row plus any id in `MORSCAN_ADMIN_KEY_IDS`. Delegates to `utils/auth`. |
| `handleAlerts(path, request, url, env)` | The admin alerts area (page + JSON API + test-fire). Delegates to `handlers/admin-alerts`. |
| `handleNotify(path, request, url, env)` | The admin waitlist/notify area. Delegates to `handlers/admin-notify`. |

A private admin provider would implement a richer operator console
behind this interface without changing the gate or any admin response.

## The composition factory

There is exactly one wiring point:
[`src/providers/compose.ts`](../../src/providers/compose.ts) exports
`createMorscanApp(options)`, which returns the worker's `{ fetch, scheduled }`
handler object with the provided providers merged over the reference registry
([`src/providers/index.ts`](../../src/providers/index.ts)).

`MorscanAppOptions`, all fields optional:

| Field | Meaning |
|-------|---------|
| `providers` | `Partial<Providers>` - swap any seam; missing entries keep the reference impl. |
| `adminRoutes(path, request, url, env)` | Operator routes under `/admin/*`. The dispatcher authenticates the caller against the AdminProvider gate BEFORE this is consulted, so every injected route is admin-gated by construction; non-admin requests fall through unchanged (unknown paths keep their stock 404). |
| `scheduledTick(env, ctx)` | Maintenance tick fired from the minute cron, fire-and-forget and error-isolated: it can never abort or delay the other scheduled work. |
| `composition` | Deploy identity (`name`, `commit`, `dirty`, `coreRef`) surfaced at `/version` - see the honesty contract below. |

That is the whole mechanism: dependency-injection simple, no plugin-loader
machinery. (The earlier deploy-time stub-swap slot,
`src/providers/deploy-overrides.ts` + `scripts/deploy-private.sh`, is retired;
the factory replaces it.)

## The two consumption modes

### (a) Standalone OSS

[`src/index.ts`](../../src/index.ts) is the shipped entry:

```ts
export default createMorscanApp(); // reference providers, stock behavior
```

Clone, configure `wrangler.toml`, deploy. Nothing else. The reference build
behaves byte-for-byte like the factory never existed.

### (b) A private composition repo (the Sentry / getsentry shape)

A private repo is the deployment root. It depends on this core (pinned, e.g.
a git dependency on a version tag), composes its own entry, and owns the real
wrangler config:

```ts
// the composition repo's src/index.ts
import { createMorscanApp, SyncCoordinator } from "morscan/app";
import { referenceCommerceProvider } from "morscan/providers";
import { createCommerceProvider } from "some-private-package";

export { SyncCoordinator }; // wrangler DO binding needs the class on the entry

export default createMorscanApp({
	providers: {
		commerce: createCommerceProvider({ base: referenceCommerceProvider }),
	},
	composition: { name: "my-deploy-repo", commit: "<sha>", coreRef: "v2.25.0", dirty: false },
});
```

Package surface: `morscan` (root: entry + factory re-exports), `morscan/app`
(the factory + DO class + `Env`/`Providers` types, with no default-composition
module side effect), `morscan/providers` (the registry + reference impls).
The published surface is the TypeScript source itself; a Workers consumer
bundles `src/` directly.

What a consuming repo must replicate (verified working from a dependent repo,
wrangler 4.107):

1. **Module rules.** The core imports `.html`, `.mustache`, `.txt` (Text),
   `.png`, `.ttf` (Data) and `.wasm` (CompiledWasm) assets from its `src/`.
   The consumer's `wrangler.toml` needs the same three `[[rules]]` blocks
   (globs like `**/*.html` match inside `node_modules/`), and
   `base_dir = "."` pins the module root to the repo root so those modules
   resolve with stable in-tree names.
2. **The build stamp.** `src/build-info.ts` is GENERATED here (gitignored),
   so a dependency install ships without it and the bundle fails loudly. The
   consumer's build step must write it (honest values: the pinned core
   commit; the consumer repo's dirtiness) before `wrangler deploy` - wire it
   as the consumer's `[build] command`.
3. **DO migrations.** Migration tags belong to the deployed WORKER name. A
   composition taking over an existing worker must reuse the same
   `[[migrations]]` tags so wrangler never tries to re-create the classes.
4. **Ambient asset types.** For `tsc`, include the core's declaration files
   (`node_modules/morscan/src/declarations.d.ts`,
   `node_modules/morscan/src/types/*.d.ts`) in the consumer `tsconfig.json`.

## The /version honesty contract

`/version` always reports a `composition` field (additive; all classic fields
unchanged):

```json
"composition": {
  "core":      { "version": "2.25.0", "commit": "<core sha>" },
  "overrides": []
}
```

- The **reference build** reports `overrides: []` and no `deploy` block.
- A **composed deployment** reports the seam names it injected (e.g.
  `["analytics", "commerce"]` - recorded by the factory from the actual
  options, not self-declared) and, if it passes `composition`, a `deploy`
  block with its own repo commit, dirtiness, and the pinned core ref.

So a composed deployment can never present itself as the plain reference
build, and the core commit at the top level always identifies the exact OSS
tree deployed.

Callers resolve providers through `getProviders()` and never import the concrete
impls directly:

- `src/routes/api.ts` - x402 flow, `/mor/v1/capacity`, `/mor/v1/analytics`,
  `/mor/v1/bq/*`, and the admin gate on metered endpoints.
- `src/routes/public.ts` - the `/sync/*` admin gate and `/admin/notify`.
- `src/providers/compose.ts` - the workers.dev admin gate, the admin alerts
  area, and the injected admin-route/scheduled-tick hooks.
- `src/routes/auth/wallet.ts`, `src/routes/auth/console.ts` - `capsForStake`.

## Why this shape (FSL protection)

MorScan is licensed under the **Functional Source License, Version 1.1, with
an MIT Future License (FSL-1.1-MIT)** - Sentry's Fair Source license. It
permits free use, modification, redistribution, and self-hosting; it forbids
offering the software to others as a competing hosted service for 2 years
from each release; and each release automatically becomes MIT on its second
anniversary. The open-core seam keeps the **core fully open and fully
functional on its own** while letting the commercial offer/pricing engine,
warehouse analytics, and operator console live in private repos. The public
build never depends on those private repos - the dependency arrow points the
OTHER way: the private composition repo imports the core and **redistributes
nothing**; it is a consumer of the FSL core, exactly like Sentry's getsentry
consumes the sentry core. The public build runs identically today on the
bundled reference implementations.
