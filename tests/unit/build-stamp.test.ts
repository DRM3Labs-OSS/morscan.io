/**
 * Footer build stamp tests.
 *
 * Guards the composition-honesty contract of src/ui/build-stamp.ts:
 *  - Reference build (overrides: []) keeps the classic stamp BYTE-FOR-BYTE.
 *  - A composed deployment renders the core version + injected seams, read
 *    from the SAME state /version reports (src/providers/overrides-state,
 *    written only by installProviders), with the /version receipt link and
 *    the /about#open-core explainer link.
 *  - No em/en dashes anywhere in the rendered line (hard copy law).
 *
 * The test drives the state through recordOverriddenSeams directly (the
 * exact function installProviders calls) so the suite stays off the full
 * provider registry's handler import graph (WASM modules vitest cannot load).
 */

import { afterEach, describe, expect, it } from "vitest";
import { BUILD_INFO } from "../../src/build-info";
import {
	getOverriddenProviders,
	recordOverriddenSeams,
} from "../../src/providers/overrides-state";
import { buildStampHtml } from "../../src/ui/build-stamp";
import { MORSCAN_VERSION } from "../../src/version";

afterEach(() => {
	// Reset to the reference composition.
	recordOverriddenSeams([]);
});

describe("buildStampHtml", () => {
	it("reference build: today's stamp, byte-for-byte", () => {
		recordOverriddenSeams([]);
		expect(buildStampHtml()).toBe(
			`MorScan v${MORSCAN_VERSION} &middot; build ${BUILD_INFO.shortCommit} &middot; &copy; 2026`,
		);
	});

	it("composed build: core version + injected seams + receipt links", () => {
		recordOverriddenSeams(["commerce", "analytics"]);
		const stamp = buildStampHtml();
		expect(stamp).toContain(`MorScan core v${MORSCAN_VERSION}`);
		// The human-facing verify link goes to /verify (the in-browser
		// walkthrough); /version remains the machine receipt, linked from there.
		expect(stamp).toContain('href="/verify"');
		// Seams render sorted, exactly as /version reports them.
		expect(stamp).toContain("running with analytics + commerce plugs");
		expect(stamp).toContain('href="/about#open-core"');
		expect(stamp).toContain("&copy; 2026");
		// A composed build must never render the reference stamp shape.
		expect(stamp).not.toContain(`build ${BUILD_INFO.shortCommit}`);
	});

	it("stamp reads the same state /version surfaces", () => {
		recordOverriddenSeams(["commerce"]);
		expect(getOverriddenProviders()).toEqual(["commerce"]);
		expect(buildStampHtml()).toContain("running with commerce plugs");
	});

	it("never contains em or en dashes", () => {
		recordOverriddenSeams([]);
		expect(buildStampHtml()).not.toMatch(/[\u2013\u2014]/);
		recordOverriddenSeams(["commerce"]);
		expect(buildStampHtml()).not.toMatch(/[\u2013\u2014]/);
	});
});
