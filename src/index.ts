/**
 * MorScan - Morpheus Blockchain Explorer
 *
 * One cache. Full state. Sub-400ms responses.
 * Real-time sync via Durable Object (5-second intervals).
 *
 * This entry is the STANDALONE OSS COMPOSITION: `createMorscanApp()` with no
 * options, i.e. the bundled reference providers - byte-for-byte the stock
 * behavior. All app logic lives in src/app.ts (the composition factory); a
 * private composition repo imports that factory as a dependency and composes
 * its own entry instead (the Sentry sentry/getsentry shape - see
 * docs/architecture/providers.md).
 *
 * ALL pluggable surface lives under src/providers/ (seam interfaces,
 * reference impls, the registry, the factory) - src/providers/README.md is
 * the plug map. Nothing outside that folder defines a swap point.
 */

// Durable Object class must export from the wrangler entry module.
export { SyncCoordinator } from "./durable/SyncCoordinator";

// Public factory surface, for consumers that import the package root.
export {
	createMorscanApp,
	getCompositionDeploy,
	HEADERS,
	safeRedirect,
	type CompositionDeployInfo,
	type Env,
	type MorscanApp,
	type MorscanAppOptions,
	type Providers,
} from "./providers/compose";

import { createMorscanApp } from "./providers/compose";

// The reference composition: the bundled reference providers, no overrides.
// A private deployment composes its own entry in its own repo instead (the
// retired deploy-overrides stub-swap is gone; createMorscanApp is the only
// injection mechanism).
export default createMorscanApp();
