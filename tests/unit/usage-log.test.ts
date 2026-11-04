/**
 * The first-party usage instrument (src/utils/usage-track.ts, src/db/usage-log.ts).
 *
 * Contract under test:
 *  - trackable(): pages + API are logged; static assets, health probes, OG and
 *    the image proxy are not.
 *  - credentialClass(): the serving key reads 'demo'; a minted key reduces to a
 *    'key:<hash-prefix>' tag and NEVER returns the raw key; x402 and anonymous
 *    are classified from headers with no DB read.
 *  - sampleWeight(): divisor 1 logs everything; under a divisor only the
 *    human-ish classes (serving key, anonymous browser) are thinned, and a kept
 *    row carries the divisor as its weight so SUM(weight) recovers volume;
 *    machine, keyed, x402 and crawler rows are always logged.
 *  - logUsage(): binds a class tag (not the raw key), no IP, and clamps path+ua.
 */

import { describe, expect, it } from "vitest";
import {
	credentialClass,
	sampleDivisor,
	sampleWeight,
	trackable,
} from "../../src/utils/usage-track";
import { logUsage } from "../../src/db/usage-log";
import type { Env } from "../../src/types";

const DEMO_KEY = "mor_demodemodemodemodemodemodemo0000";
const USER_KEY = "mor_useruseruseruseruseruseruser0000";

function env(extra: Partial<Env> = {}): Env {
	return { MORSCAN_DEMO_KEY: DEMO_KEY, ...extra } as unknown as Env;
}
function req(headers: Record<string, string> = {}): Request {
	return new Request("https://morscan.io/mor/v1/providers", { headers });
}

describe("trackable", () => {
	it("logs pages and API, skips assets/probes/proxies", () => {
		for (const p of ["/", "/analytics/overview", "/mor/v1/providers", "/models/x"])
			expect(trackable(p)).toBe(true);
		for (const p of [
			"/style.css",
			"/app.js",
			"/logo.svg",
			"/favicon.ico",
			"/robots.txt",
			"/sitemap.xml",
			"/.well-known/drm3-contracts.json",
			"/health",
			"/healthz",
			"/version",
			"/og.png",
			"/img?u=https://x/y.png",
		])
			expect(trackable(p)).toBe(false);
	});
});

describe("credentialClass", () => {
	it("reads the serving key as 'demo'", async () => {
		expect(await credentialClass(req({ "X-Morscan-Key": DEMO_KEY }), env())).toBe("demo");
	});
	it("reduces a minted key to a non-reversible tag, never the raw key", async () => {
		const c = await credentialClass(req({ "X-Morscan-Key": USER_KEY }), env());
		expect(c).toMatch(/^key:[0-9a-f]{12}$/);
		expect(c).not.toContain(USER_KEY);
	});
	it("accepts the Authorization: Bearer form", async () => {
		const c = await credentialClass(req({ Authorization: `Bearer ${USER_KEY}` }), env());
		expect(c).toMatch(/^key:[0-9a-f]{12}$/);
	});
	it("classifies wallet-signature SDK callers (not anonymous)", async () => {
		expect(await credentialClass(req({ "X-Morscan-Wallet": "0xabc" }), env())).toBe("wallet");
	});
	it("classifies x402 and anonymous from headers alone", async () => {
		expect(await credentialClass(req({ "X-PAYMENT": "eyJ..." }), env())).toBe("x402");
		expect(await credentialClass(req({}), env())).toBeNull();
	});
	it("a key beats an x402 header", async () => {
		const c = await credentialClass(req({ "X-Morscan-Key": USER_KEY, "X-PAYMENT": "x" }), env());
		expect(c).toMatch(/^key:/);
	});
});

describe("sampling", () => {
	const browser =
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
	const bot = "AhrefsBot/7.0; +http://ahrefs.com/robot/";
	const lib = "python-requests/2.31.0";

	it("divisor 1 logs every request at weight 1", () => {
		expect(sampleWeight("demo", browser, 1, 0.999)).toBe(1);
		expect(sampleWeight(null, bot, 1, 0.999)).toBe(1);
	});
	it("thins the serving key and anonymous browsers under a divisor", () => {
		expect(sampleWeight("demo", browser, 10, 0.5)).toBe(0); // dropped
		expect(sampleWeight("demo", browser, 10, 0.05)).toBe(10); // kept, weighted
		expect(sampleWeight(null, browser, 10, 0.5)).toBe(0);
		expect(sampleWeight(null, browser, 10, 0.05)).toBe(10);
	});
	it("always logs machine, keyed, x402 and crawler rows whatever the divisor", () => {
		expect(sampleWeight("key:abc123def456", browser, 100, 0.99)).toBe(1);
		expect(sampleWeight("x402", null, 100, 0.99)).toBe(1);
		expect(sampleWeight(null, bot, 100, 0.99)).toBe(1); // crawler UA
		expect(sampleWeight(null, lib, 100, 0.99)).toBe(1); // library UA
		expect(sampleWeight(null, null, 100, 0.99)).toBe(1); // no UA at all
	});
	it("reads the divisor from env, defaulting to 1", () => {
		expect(sampleDivisor(env())).toBe(1);
		expect(sampleDivisor(env({ USAGE_LOG_SAMPLE: "20" } as Partial<Env>))).toBe(20);
		expect(sampleDivisor(env({ USAGE_LOG_SAMPLE: "0" } as Partial<Env>))).toBe(1);
		expect(sampleDivisor(env({ USAGE_LOG_SAMPLE: "junk" } as Partial<Env>))).toBe(1);
	});
});

describe("logUsage binds no secret and clamps", () => {
	it("stores the class tag, no raw key, no IP, and clamps path+ua", async () => {
		const bound: unknown[][] = [];
		const fake = {
			prepare(sql: string) {
				return {
					bind(...a: unknown[]) {
						bound.push([sql, ...a]);
						return this;
					},
					run: async () => ({ meta: { changes: 0 } }),
				};
			},
			batch: async () => [{}, {}],
		} as unknown as D1Database;

		await logUsage(fake, {
			path: `/mor/v1/${"x".repeat(400)}`,
			method: "GET",
			credential: "key:0123456789ab",
			country: "US",
			colo: "MIA",
			ua: "a".repeat(400),
			weight: 1,
		});

		const insert = bound.find((b) => String(b[0]).includes("INSERT INTO usage_log"));
		expect(insert).toBeTruthy();
		const args = (insert as unknown[]).slice(1) as (string | number)[];
		// path (<=200), method, credential, country, colo, ua (<=180), weight
		expect((args[0] as string).length).toBeLessThanOrEqual(200);
		expect(args[2]).toBe("key:0123456789ab");
		expect((args[5] as string).length).toBeLessThanOrEqual(180);
		expect(args[6]).toBe(1);
		// nothing bound looks like a full mor_ key or an IP address
		for (const a of args) {
			expect(String(a)).not.toMatch(/mor_[a-z0-9]{20,}/);
			expect(String(a)).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
		}
	});
});
