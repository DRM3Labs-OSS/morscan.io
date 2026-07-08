/**
 * The footer build stamp - ONE definition, rendered into both the dynamic
 * shell (layout.mustache via src/ui/shell.ts) and the static pages
 * (withBuildFooter in src/handlers/ui/shared.ts).
 *
 * It is computed from the SAME sources /version reports (MORSCAN_VERSION,
 * BUILD_INFO, getOverriddenProviders - see src/routes/public.ts), so the
 * footer can never disagree with the /version composition honesty marker.
 * There is no second copy of the composition data.
 *
 * - Reference build (overrides: []): the classic stamp, unchanged:
 *   "MorScan v<version> · build <commit> · © 2026"
 * - Composed deployment: one quiet honest line naming the core version
 *   (linked to /version, the receipt) and the injected provider plugs,
 *   linked to the open-core explainer at /about#open-core.
 */

import { BUILD_INFO } from "../build-info";
import { getOverriddenProviders } from "../providers/overrides-state";
import { MORSCAN_VERSION } from "../version";

// Inline link style so the stamp reads identically inside the mustache shell
// and inside every static page's own stylesheet (the static pages have
// per-page `a` rules; inheriting the stamp color + underline keeps the line
// quiet and the contrast identical to the surrounding text).
const LINK = 'style="color:inherit;text-decoration:underline"';

export function buildStampHtml(): string {
	const overrides = getOverriddenProviders();
	if (overrides.length === 0) {
		// Reference build: today's stamp, byte-for-byte.
		return `MorScan v${MORSCAN_VERSION} &middot; build ${BUILD_INFO.shortCommit} &middot; &copy; 2026`;
	}
	// Composed deployment: same truth /version tells, one line. The "verify"
	// link is the human-facing walkthrough at /verify (which checks the
	// signature in the reader's browser); /version stays the machine receipt
	// and is linked from that page.
	const plugs = overrides.join(" + ");
	return (
		`MorScan core v${MORSCAN_VERSION} (<a href="/verify" ${LINK}>verify</a>)` +
		` &middot; running with ${plugs} plugs` +
		` &middot; <a href="/about#open-core" ${LINK}>how this works</a>` +
		" &middot; &copy; 2026"
	);
}
