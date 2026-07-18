/**
 * The version lives in two places: package.json (npm/pin surface) and
 * src/version.ts (the deployed MORSCAN_VERSION shown at /version and in the
 * footer). A release was once tagged with the two disagreeing, so the tag
 * shipped bytes that reported the previous version. This test runs in
 * predeploy and CI, so a skewed pair can no longer reach a tag or a deploy.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MORSCAN_VERSION } from "../../src/version";

describe("version consistency", () => {
	it("package.json version matches MORSCAN_VERSION", () => {
		const pkg = JSON.parse(
			readFileSync(join(__dirname, "../../package.json"), "utf8"),
		) as { version: string };
		expect(pkg.version).toBe(MORSCAN_VERSION);
	});

	it("MORSCAN_VERSION is a plain semver", () => {
		expect(MORSCAN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
