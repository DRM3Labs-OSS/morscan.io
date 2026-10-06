/**
 * The /health audience split, on the REAL public-health.allow at the repo root.
 *
 * Contract under test (handlers/health-audience.ts, the gate vendored in
 * src/vendor/public-health.ts):
 *  - no key, a wrong key of the right length, a short key: only the listed
 *    fields come back; the build fingerprint and the indexer cursor never do.
 *  - this door's own key: the whole body, untouched.
 *  - an unset or empty door key reveals to nobody, whatever is presented.
 *  - a field added to the handler tomorrow is private until it is listed.
 *  - a field with no reason above it is not served, even when named.
 *  - the explorer's own freshness (blocksBehind and its neighbours) is public,
 *    so the site's sync bar and the about page keep every number they print.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audienceBody } from "../../src/handlers/health-audience";
import { parseAllow } from "../../src/vendor/public-health";

const allowText = readFileSync(join(__dirname, "../../public-health.allow"), "utf8");
const KEY = "a".repeat(64);
const env = { OPS_READ_KEY: KEY };

const full: Record<string, unknown> = {
	service: "morscan",
	currentBlock: 42_500_100,
	syncedBlock: 42_500_095,
	startBlock: 42_400_000,
	blocksBehind: 5,
	lastSyncTs: "2026-01-01T00:00:00.000Z",
	timestamp: "2026-01-01T00:00:01.000Z",
	morscanVersion: "9.9.9",
	lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
	lastSyncAgeSeconds: 4,
	syncStale: false,
	bids: 12,
	economicsUpdatedAt: "2026-01-01T00:00:00.000Z",
	claimable_list_consistent: true,
	accounting_signal: "consistent",
	coverage: {
		indexing: true,
		blocksPerSec: 40,
		etaSeconds: 3600,
		eta: "1h",
		pct: 61.5,
		datasets: {
			builder: { fromBlock: 1, scannedTo: 2, pct: 100, complete: true },
			sessions: { fromBlock: 3, scannedTo: 4, pct: 90, complete: false },
			holders: { fromBlock: 5, scannedTo: 6, pct: 61.5, complete: false },
		},
	},
	backfillIndexing: true,
	status: "degraded",
	sku: "morscan",
	product: "MorScan",
	version: "9.9.9",
	providers: 7,
	activeSessions: 3,
	stakingFactor: 1.5,
	a_field_added_tomorrow: "private until it is listed",
	extended: {
		syncedBlock: 42_500_095,
		blocksBehind: 5,
		providers: 7,
		activeSessions: 3,
		stakingFactor: 1.5,
		currentBlock: 42_500_100,
		lastSyncTs: "2026-01-01T00:00:00.000Z",
		lastSyncAgeSeconds: 4,
		syncStale: false,
		bids: 12,
		economicsUpdatedAt: "2026-01-01T00:00:00.000Z",
		contracts: {
			diamond: {
				address: "0xdiamond",
				deployBlock: 1,
				syncedBlock: 42_500_095,
				blocksBehind: 5,
				purpose: "Session staking",
				upgrades: {
					totalSeen: 2,
					last: { block: 10, txHash: "0xtx", facetCount: 7, timestamp: 1700000000 },
				},
			},
			builder: {
				address: "0xbuilder",
				deployBlock: 3,
				syncedBlock: 42_500_000,
				blocksBehind: 100,
				status: "degraded",
				purpose: "Builder staking",
			},
			mor_token: {
				address: "0xmor",
				deployBlock: 5,
				syncedBlock: 42_500_095,
				blocksBehind: 5,
				purpose: "MOR token transfers",
			},
		},
		eventCursorBlock: 42_499_000,
		eventCursorAgeSeconds: 4,
		cursorBlocksBehind: 1100,
		eventCursorStuck: false,
		claimable_list_consistent: true,
		build: { commit: "abc1234", builtAt: "2026-01-01", dirty: false, provenance: "1.0.0" },
	},
};

const req = (key?: string) =>
	new Request(
		"https://morscan.io/health",
		key === undefined ? undefined : { headers: { "X-DRM3-Ops-Key": key } },
	);

const PUBLIC_TOP_LEVEL = [
	"accounting_signal",
	"activeSessions",
	"backfillIndexing",
	"bids",
	"blocksBehind",
	"claimable_list_consistent",
	"coverage",
	"currentBlock",
	"economicsUpdatedAt",
	"extended",
	"lastSyncAgeSeconds",
	"lastSyncTimestamp",
	"product",
	"providers",
	"sku",
	"stakingFactor",
	"status",
	"syncStale",
	"syncedBlock",
	"timestamp",
	"version",
];

describe("public-health.allow", () => {
	it("parses with no violation and a reason on every field", () => {
		const parsed = parseAllow(allowText);
		expect(parsed.violations).toEqual([]);
		expect(parsed.fields.length).toBeGreaterThan(0);
		for (const f of parsed.fields) expect(f.reason.length).toBeGreaterThan(0);
	});

	it("names the door", () => {
		expect(allowText).toContain("# door: https://morscan.io/health");
	});
});

describe("/health audience", () => {
	const pub = audienceBody(req(), env, full, allowText);

	it("no key: only the listed top-level fields", () => {
		expect(Object.keys(pub).sort()).toEqual(PUBLIC_TOP_LEVEL);
	});

	it("no key: the explorer's own freshness is public", () => {
		expect(pub.blocksBehind).toBe(5);
		expect(pub.currentBlock).toBe(42_500_100);
		expect(pub.syncedBlock).toBe(42_500_095);
		expect(pub.lastSyncTimestamp).toBe("2026-01-01T00:00:00.000Z");
		expect(pub.lastSyncAgeSeconds).toBe(4);
		expect(pub.syncStale).toBe(false);
		expect(pub.coverage).toEqual(full.coverage);
		const ext = pub.extended as Record<string, Record<string, Record<string, unknown>>>;
		expect(ext.contracts.builder.syncedBlock).toBe(42_500_000);
		expect(ext.contracts.builder.blocksBehind).toBe(100);
		expect(ext.contracts.diamond.upgrades).toEqual(
			(full.extended as Record<string, Record<string, Record<string, unknown>>>).contracts
				.diamond.upgrades,
		);
	});

	it("no key: the status word still says degraded", () => {
		expect(pub.status).toBe("degraded");
	});

	it("no key: the build fingerprint and the indexer internals are gone", () => {
		const ext = pub.extended as Record<string, unknown>;
		expect(ext).not.toHaveProperty("build");
		expect(ext).not.toHaveProperty("eventCursorBlock");
		expect(ext).not.toHaveProperty("eventCursorAgeSeconds");
		expect(ext).not.toHaveProperty("cursorBlocksBehind");
		expect(ext).not.toHaveProperty("eventCursorStuck");
		expect(JSON.stringify(pub)).not.toMatch(/"build"|commit|eventCursor|abc1234/);
	});

	it("no key: the duplicates and the index setting are gone", () => {
		expect(pub).not.toHaveProperty("service");
		expect(pub).not.toHaveProperty("morscanVersion");
		expect(pub).not.toHaveProperty("startBlock");
		expect(pub).not.toHaveProperty("lastSyncTs");
		const ext = pub.extended as Record<string, unknown>;
		expect(Object.keys(ext)).toEqual(["contracts"]);
	});

	it("no key: a field added tomorrow is private", () => {
		expect(pub).not.toHaveProperty("a_field_added_tomorrow");
	});

	it("no key: the full body was not mutated", () => {
		expect(full).toHaveProperty("service");
		expect((full.extended as Record<string, unknown>).build).toBeTruthy();
	});

	it("this door's key: the whole body", () => {
		expect(audienceBody(req(KEY), env, full, allowText)).toEqual(full);
	});

	it("a wrong key of the right length: the public body", () => {
		expect(audienceBody(req("b".repeat(64)), env, full, allowText)).toEqual(pub);
	});

	it("a short key: the public body", () => {
		expect(audienceBody(req("a"), env, full, allowText)).toEqual(pub);
	});

	it("an unset door key reveals to nobody, even with a key presented", () => {
		expect(audienceBody(req(KEY), {}, full, allowText)).toEqual(pub);
	});

	it("an empty door key reveals to nobody, even to an empty header", () => {
		expect(audienceBody(req(""), { OPS_READ_KEY: "" }, full, allowText)).toEqual(pub);
	});

	it("an empty allow file serves nothing", () => {
		expect(audienceBody(req(), env, full, "")).toEqual({});
	});

	it("a field with no reason is not served", () => {
		const body = audienceBody(req(), env, full, "service\n# why\nstatus\n");
		expect(body).toEqual({ status: "degraded" });
	});
});
