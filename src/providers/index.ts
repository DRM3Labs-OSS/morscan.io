/**
 * Provider registry - the OPEN-CORE INJECTION POINT.
 *
 * MorScan is open-core: the OSS repo defines stable provider INTERFACES and
 * ships bundled REFERENCE implementations that make the standalone product
 * fully functional and behave IDENTICALLY to today. Proprietary features
 * (a real offer/pricing engine + on-chain settlement, warehouse analytics, a
 * richer operator console) live in PRIVATE repos that implement one of these
 * interfaces and are injected through `createMorscanApp` (src/app.ts).
 *
 * Precedent: Sentry (OSS core + getsentry), Grafana (OSS + Enterprise plugins).
 * The OSS core defines the interface; a private composition repo implements it
 * and composes its own worker entry; the OSS build is fully usable on the
 * reference impls. See docs/architecture/providers.md.
 *
 * The registry is a module-level singleton because provider lookups happen
 * deep in the call tree via getProviders(). `createMorscanApp` installs the
 * composed set (reference impls with any injected entries swapped in) and the
 * overridden seam names are recorded for the /version honesty marker.
 */

import { referenceAdminProvider, type AdminProvider } from "./admin";
import { referenceAnalyticsProvider, type AnalyticsProvider } from "./analytics";
import { referenceCommerceProvider, type CommerceProvider } from "./commerce";
import { recordOverriddenSeams } from "./overrides-state";

// The overridden-seams record lives in ./overrides-state (a tiny module the
// footer build stamp can import without the registry's handler graph); it is
// re-exported here so /version keeps its canonical `../providers` import.
export { getOverriddenProviders } from "./overrides-state";

export type { AdminProvider } from "./admin";
export type { AnalyticsProvider } from "./analytics";
export type { CommerceProvider, Offer, GrantResult } from "./commerce";

// The bundled reference implementations, exported so a composition repo can
// delegate to them (private providers wrap the reference behavior, keeping
// each concern's single definition in this repo - DRY).
export { referenceAdminProvider } from "./admin";
export { referenceAnalyticsProvider } from "./analytics";
export { referenceCommerceProvider } from "./commerce";

/** The full set of providers the worker resolves each request/tick. */
export interface Providers {
	commerce: CommerceProvider;
	analytics: AnalyticsProvider;
	admin: AdminProvider;
}

/** The bundled reference registry - the standalone OSS product. */
const REFERENCE_PROVIDERS: Providers = {
	commerce: referenceCommerceProvider,
	analytics: referenceAnalyticsProvider,
	admin: referenceAdminProvider,
};

// The active registry. Installed by createMorscanApp; defaults to the pure
// reference registry so provider resolution works even before (or without) a
// factory call - e.g. in tests that import a handler directly. The overridden
// seam names live in ./overrides-state (written below, read by /version and
// the footer build stamp).
let activeProviders: Providers = { ...REFERENCE_PROVIDERS };

/**
 * Install the composed provider set (called by createMorscanApp). Entries
 * not provided keep the reference impl. Records the overridden seam names
 * for the /version composition marker. Last call wins - one composition per
 * worker bundle (see src/app.ts).
 */
export function installProviders(partial?: Partial<Providers>): void {
	const injected = Object.entries(partial ?? {}).filter(([, v]) => v != null);
	activeProviders = {
		...REFERENCE_PROVIDERS,
		...Object.fromEntries(injected),
	} as Providers;
	recordOverriddenSeams(injected.map(([k]) => k));
}

/**
 * Resolve the active providers. Default = the bundled reference impls, so the
 * OSS standalone build behaves identically to today. A composition swaps
 * entries via `createMorscanApp({ providers })`.
 */
export function getProviders(): Providers {
	return activeProviders;
}
