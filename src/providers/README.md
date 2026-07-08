# src/providers/ - the plug map

Everything pluggable in MorScan lives in THIS folder. If a file defines or
exports a swap point, it is here; nothing else in the repo does. This README
is the quick map; the full story (consumption modes, honesty contract,
license posture) is [docs/architecture/providers.md](../../docs/architecture/providers.md).

## Folder layout

| Path | Role |
|------|------|
| `index.ts` | The registry + injection point: `Providers`, `installProviders`, `getProviders`, `getOverriddenProviders`, reference impl re-exports. |
| `compose.ts` | The composition factory: `createMorscanApp(options)` returns the `{ fetch, scheduled }` worker handlers. `src/app.ts` and `src/index.ts` are thin pointers to it. |
| `commerce/` | CommerceProvider seam + reference impl. |
| `analytics/` | AnalyticsProvider seam + reference impl. |
| `admin/` | AdminProvider seam + reference impl. |

## The three seams

| Seam | Interface | Reference impl | Scope (one line) | What a private impl swaps |
|------|-----------|----------------|------------------|---------------------------|
| Commerce | `commerce/index.ts` `CommerceProvider` | `referenceCommerceProvider` (same file) | Everything commerce: offers, stake-indexed caps, capacity readout, the x402 402 envelope, payment verify/settle, grants. | A real offer/pricing engine, immediate on-chain x402 settlement, a call-balance ledger. Optional capabilities: `purchaseOffer` (POST /mor/v1/keys/purchase - x402 pack purchase that settles on-chain, then mints an `mspk_` key with a prepaid call balance; 404 on the reference build) and `debitCallBalance` (per-call ledger debit after the burst gate; exhausted balance = 402 with the purchase menu). |
| Analytics | `analytics/index.ts` `AnalyticsProvider` | `referenceAnalyticsProvider` (same file) | Everything analytics: the D1 `/mor/v1/analytics` aggregate plus the optional BQ status/backfill tier. | Warehouse-backed analytics and raw dump pipelines behind identical endpoints. |
| Admin | `admin/index.ts` `AdminProvider` | `referenceAdminProvider` (same file) | Everything operator: the admin identity gate, alerts area, waitlist/notify area. | A richer operator console behind the same gate. |

The reference impls are thin, behavior-preserving delegations to the existing
handlers, so each concern keeps exactly one definition; the provider object is
only the seam.

## Composing an app

Standalone OSS (what `src/index.ts` ships):

```ts
export default createMorscanApp(); // reference providers, stock behavior
```

A private composition repo (imports this core as a dependency):

```ts
import { createMorscanApp, SyncCoordinator } from "morscan/app";
import { referenceCommerceProvider } from "morscan/providers";
import { createCommerceProvider } from "your-private-package";

export { SyncCoordinator }; // wrangler DO binding needs the class exported

export default createMorscanApp({
	providers: {
		commerce: createCommerceProvider({ base: referenceCommerceProvider }),
	},
	adminRoutes: async (path, request, url, env) => null, // optional, admin-gated by the core
	scheduledTick: async (env, ctx) => {}, // optional, error-isolated by the core
	composition: { name: "your-deploy-repo", commit: "...", coreRef: "vX.Y.Z", dirty: false },
});
```

Factory options (`MorscanAppOptions` in `compose.ts`):

- `providers` - `Partial<Providers>`; entries not listed keep the reference impl.
- `adminRoutes` - operator routes under `/admin/*`; the core authenticates the
  caller against the AdminProvider gate BEFORE the handler is consulted.
- `scheduledTick` - maintenance tick off the minute cron; fire-and-forget and
  error-isolated so it can never delay other scheduled work.
- `composition` - deploy identity surfaced at `/version` (honesty marker).

`/version` always reports `composition.overrides` (the seam names a
composition injected; `[]` for the reference build), so a composed deployment
never presents itself as the plain reference build.

One composition per worker bundle: the registry is a module singleton because
provider lookups happen deep in the call tree; the last `createMorscanApp`
call wins.

## The license boundary, plainly

Writing your own providers and composing your own MorScan instance, for
yourself or your company, is exactly what the license covers: fork it, plug
it, run it. It is the same seam morscan.io itself runs through: the operator
composes the public core with private providers and `/version` reports the
composition honestly.

What the license does not cover is offering your composition as a hosted
service to others. If that is what you want, or you want commercial embedding
or MIT rights ahead of the two-year date, commercial licenses are available:
morscan@drm3.io.
