/**
 * The keyless gate (src/utils/keyless-gate.ts): the crawler denylist and the
 * armed-but-off anonymous per-IP day cap.
 *
 * Contract:
 *  - isDeniedCrawler(): the specific marketing/SEO scrapers match; search
 *    engines, agent crawlers, and real browsers do NOT.
 *  - a credentialed request (key / bearer / wallet sig / payment) ALWAYS skips
 *    the gate, even with a denied-crawler UA - a key beats a user-agent.
 *  - a keyless denied crawler gets 403; /health is exempt.
 *  - the anon cap is OFF by default (no D1 touched); when armed it is a per-IP
 *    UTC-day ceiling that 429s only past the limit, and only on /mor/v1.
 */

import { describe, expect, it } from "vitest";
import {
	anonDayCap,
	hasCredentialHeader,
	isDeniedCrawler,
	keylessGate,
} from "../../src/utils/keyless-gate";
import type { Env } from "../../src/types";

function req(headers: Record<string, string> = {}): Request {
	return new Request("https://morscan.io/models", { headers });
}
function apiReq(headers: Record<string, string> = {}, path = "/mor/v1/providers"): Request {
	return new Request(`https://morscan.io${path}`, { headers });
}

// A fake D1 that models only anon_counters: the DDL/prune run() and the
// INSERT ... ON CONFLICT ... RETURNING n (per-bucket increment).
function fakeDb() {
	const counts = new Map<string, number>();
	return {
		prepare(sql: string) {
			let args: unknown[] = [];
			return {
				bind(...a: unknown[]) {
					args = a;
					return this;
				},
				async run() {
					return { success: true, meta: { changes: 0 } };
				},
				async first() {
					if (sql.includes("INSERT INTO anon_counters")) {
						const bucket = String(args[0]);
						const n = (counts.get(bucket) ?? 0) + 1;
						counts.set(bucket, n);
						return { n };
					}
					return null;
				},
			};
		},
	} as unknown as D1Database;
}

describe("isDeniedCrawler", () => {
	it("matches the zero-value marketing/SEO scrapers", () => {
		for (const ua of ["AhrefsBot/7.0", "SemrushBot/7~bl", "Bytespider", "MJ12bot", "DotBot/1.2"])
			expect(isDeniedCrawler(ua)).toBe(true);
	});
	it("does NOT match search engines, agent crawlers, or browsers", () => {
		for (const ua of [
			"Googlebot/2.1",
			"Mozilla/5.0 (compatible; bingbot/2.0)",
			"DuckDuckBot/1.1",
			"Applebot/0.1",
			"GPTBot/1.0",
			"ClaudeBot/1.0",
			"PerplexityBot/1.0",
			"Mozilla/5.0 (Macintosh) Chrome/121 Safari/537.36",
			null,
			"",
		])
			expect(isDeniedCrawler(ua)).toBe(false);
	});
});

describe("hasCredentialHeader", () => {
	it("detects every credential form and nothing else", () => {
		expect(hasCredentialHeader(req({ "X-Morscan-Key": "mor_x" }))).toBe(true);
		expect(hasCredentialHeader(req({ Authorization: "Bearer mor_x" }))).toBe(true);
		expect(hasCredentialHeader(req({ "X-Morscan-Wallet": "0xabc" }))).toBe(true);
		expect(hasCredentialHeader(req({ "X-PAYMENT": "eyJ..." }))).toBe(true);
		expect(hasCredentialHeader(req({}))).toBe(false);
		expect(hasCredentialHeader(req({ Authorization: "Basic xyz" }))).toBe(false);
	});
});

describe("anonDayCap", () => {
	it("is off by default and parses a positive integer", () => {
		expect(anonDayCap({} as Env)).toBe(0);
		expect(anonDayCap({ ANON_DAY_CAP: "0" } as unknown as Env)).toBe(0);
		expect(anonDayCap({ ANON_DAY_CAP: "250" } as unknown as Env)).toBe(250);
		expect(anonDayCap({ ANON_DAY_CAP: "junk" } as unknown as Env)).toBe(0);
	});
});

const DEMO_KEY = "mor_demodemodemodemodemodemodemo0000";

describe("keylessGate", () => {
	it("403s a keyless denied crawler", async () => {
		const res = await keylessGate({} as Env, req({ "user-agent": "AhrefsBot/7.0" }), "/models");
		expect(res?.status).toBe(403);
	});
	it("a denied crawler cannot bypass the PAGE block with a junk key header", async () => {
		// Pages carry no legitimate key; presence of a header must not defeat the block.
		const r = req({ "X-Morscan-Key": "junk", "user-agent": "AhrefsBot/7.0" });
		expect((await keylessGate({} as Env, r, "/models"))?.status).toBe(403);
	});
	it("a denied crawler with an INVALID key is still blocked on /mor/v1", async () => {
		const r = apiReq({ "X-Morscan-Key": "junk", "user-agent": "AhrefsBot/7.0" });
		expect((await keylessGate({} as Env, r, "/mor/v1/providers"))?.status).toBe(403);
	});
	it("a VALID key beats the user-agent on /mor/v1 (demo key, no D1)", async () => {
		const env = { MORSCAN_DEMO_KEY: DEMO_KEY } as unknown as Env;
		const r = apiReq({ "X-Morscan-Key": DEMO_KEY, "user-agent": "AhrefsBot/7.0" });
		expect(await keylessGate(env, r, "/mor/v1/providers")).toBeNull();
	});
	it("lets a keyless search engine through", async () => {
		expect(await keylessGate({} as Env, req({ "user-agent": "Googlebot/2.1" }), "/models")).toBeNull();
	});
	it("exempts /health from the crawler block", async () => {
		expect(
			await keylessGate({} as Env, req({ "user-agent": "AhrefsBot/7.0" }), "/health"),
		).toBeNull();
	});
	it("does nothing (no D1) when the anon cap is off", async () => {
		// env.DB is absent; if the gate touched D1 with the cap off this would throw.
		expect(await keylessGate({} as Env, apiReq({ "user-agent": "python/3" }), "/mor/v1/providers")).toBeNull();
	});
	it("caps keyless /mor/v1 per IP when armed, 429 past the limit", async () => {
		const env = { ANON_DAY_CAP: "2", DB: fakeDb() } as unknown as Env;
		const h = { "user-agent": "python-requests/2.31", "CF-Connecting-IP": "203.0.113.9" };
		expect(await keylessGate(env, apiReq(h), "/mor/v1/providers")).toBeNull(); // 1
		expect(await keylessGate(env, apiReq(h), "/mor/v1/providers")).toBeNull(); // 2
		const over = await keylessGate(env, apiReq(h), "/mor/v1/providers"); // 3 > cap
		expect(over?.status).toBe(429);
	});
	it("the armed cap does NOT apply to pages, only /mor/v1", async () => {
		const env = { ANON_DAY_CAP: "1", DB: fakeDb() } as unknown as Env;
		const h = { "user-agent": "python-requests/2.31", "CF-Connecting-IP": "203.0.113.9" };
		// Two page hits past a cap of 1 still pass (pages are not capped).
		expect(await keylessGate(env, req(h), "/models")).toBeNull();
		expect(await keylessGate(env, req(h), "/analytics/overview")).toBeNull();
	});
	it("the armed cap does NOT charge the free endpoints (price/capacity)", async () => {
		const env = { ANON_DAY_CAP: "1", DB: fakeDb() } as unknown as Env;
		const h = { "user-agent": "python-requests/2.31", "CF-Connecting-IP": "203.0.113.9" };
		// Repeated free-endpoint hits past a cap of 1 never 429 (never counted).
		for (let i = 0; i < 3; i++)
			expect(await keylessGate(env, apiReq(h, "/mor/v1/price"), "/mor/v1/price")).toBeNull();
		expect(await keylessGate(env, apiReq(h, "/mor/v1/capacity"), "/mor/v1/capacity")).toBeNull();
	});
});
