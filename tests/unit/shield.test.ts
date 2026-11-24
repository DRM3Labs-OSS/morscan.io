/**
 * The shared-database shield: the doors a stranger could make expensive.
 *
 *  - share cards: the cache key never carries a stranger's string (an unknown
 *    slug is the default card's key; the subnet card's ?id= is not in the key);
 *  - /chart.svg rides one fixed cache key and keeps its SVG type;
 *  - a detail page's render is gated on a cache MISS only, and a mixed-case
 *    address answers 301 to its one lowercase page;
 *  - the render budget: per-IP first shed, then the exact global ceiling,
 *    both failing open;
 *  - /mor/v1/sessions paging is parsed to integers before it keys a cache;
 *  - the caller classes the database guards budget by;
 *  - the D1 read budget is per class and is taken BEFORE a pack debit;
 *  - a tighter per-IP door has its own pool and key;
 *  - the usage log: a 404 is "(404)", junk keys are one tag, the global
 *    ceiling drops rows (closed), an address past its rate is thinned;
 *  - /notify only on a coming-soon host, with a day ceiling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOgCard } from "../../src/handlers/og-image";
import { handlePublicRoutes } from "../../src/routes/public";
import { cachedPage, handleUiRoutes } from "../../src/routes/ui";
import { renderRefusal } from "../../src/utils/render-budget";
import { FREE_SESSIONS_MAX_PAGE, sessionsPaging } from "../../src/handlers/sessions";
import { callerClass } from "../../src/utils/caller-class";
import { heavyUncachedEstimate, takeReadBudget } from "../../src/utils/d1-budget";
import { handleApiRoutes } from "../../src/routes/api";
import { installProviders, referenceCommerceProvider } from "../../src/providers";
import { checkRateLimit, ipPool } from "../../src/utils/auth/rate-limit";
import { credentialClass, loggedPath, logRequest } from "../../src/utils/usage-track";
import type { Env, RateLimitBinding } from "../../src/types";
import type { AuthResult } from "../../src/utils/auth/key-validation";
import { FakeD1 } from "./_fake-d1";
import { fakeMeter } from "./_fake-meter";

const HEADERS = { "Content-Type": "application/json" };

/** A Cache API stand-in that records every key and serves `hit` when given. */
function stubCache(hit?: () => Response) {
	const matched: string[] = [];
	const put: Array<{ url: string; resp: Response }> = [];
	vi.stubGlobal("caches", {
		default: {
			match: async (req: Request) => {
				matched.push(req.url);
				return hit ? hit() : undefined;
			},
			put: async (req: Request, resp: Response) => {
				put.push({ url: req.url, resp });
			},
			delete: async () => true,
		},
	});
	return { matched, put };
}

function ctx(): ExecutionContext {
	return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function limiter(allow: boolean): RateLimitBinding & { keys: string[] } {
	const keys: string[] = [];
	return {
		keys,
		limit: async ({ key }) => {
			keys.push(key);
			return { success: allow };
		},
	};
}

// Mid-minute, mid-day, so no counting window rolls over inside a test.
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 24, 12, 0, 30));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	installProviders();
});

describe("share cards: the cache key is the card, never the URL", () => {
	const png = () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } });

	it("an unknown slug reads the default card's key; a known slug keeps its own", async () => {
		const { matched } = stubCache(png);
		const env = {} as Env;
		await handleOgCard(env, "auditprobe-4f2a", new URL("https://morscan.io/og/auditprobe-4f2a"), ctx());
		await handleOgCard(env, "zzz-other", new URL("https://morscan.io/og/zzz-other.png"), ctx());
		await handleOgCard(env, "about", new URL("https://morscan.io/og/about.png"), ctx());
		expect(matched[0]).toMatch(/\/v2\/default\/\d+$/);
		expect(matched[1]).toBe(matched[0]);
		expect(matched[2]).toMatch(/\/v2\/about\/\d+$/);
	});

	it("the subnet card's ?id= never reaches the key; a chart's bad ?tf= is the default", async () => {
		const { matched } = stubCache(png);
		const env = {} as Env;
		await handleOgCard(env, "subnet", new URL("https://morscan.io/og/subnet?id=rand1"), ctx());
		await handleOgCard(env, "subnet", new URL("https://morscan.io/og/subnet?id=rand2"), ctx());
		await handleOgCard(env, "analytics", new URL("https://morscan.io/og/analytics?tf=junk"), ctx());
		expect(matched[0]).toMatch(/\/v2\/subnet\/\d+$/);
		expect(matched[1]).toBe(matched[0]);
		expect(matched[2]).toMatch(/\/v2\/analytics:tf-def\/\d+$/);
	});
});

describe("/chart.svg", () => {
	it("one fixed cache key whatever the query string; a hit never renders", async () => {
		const { matched } = stubCache(
			() => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
		);
		const env = {} as Env; // no DB: a render would throw
		for (const q of ["", "?a=1", "?cb=987"]) {
			const url = new URL(`https://morscan.io/chart.svg${q}`);
			const r = await handlePublicRoutes("/chart.svg", "GET", new Request(url), url, env, HEADERS);
			expect(r?.headers.get("Content-Type")).toBe("image/svg+xml");
			expect(r?.headers.get("X-Cache")).toBe("HIT");
		}
		expect(new Set(matched)).toEqual(new Set(["https://morscan-cache.internal/chart:svg:v1"]));
	});
});

describe("detail pages", () => {
	it("the gate runs on a miss only, and its answer is returned and never cached", async () => {
		const miss = stubCache();
		let rendered = 0;
		const refused = new Response("busy", { status: 429 });
		const url = new URL("https://morscan.io/compute/providers/0x" + "a".repeat(40));
		const r = await cachedPage(url, ctx(), {} as Env, async () => {
			rendered++;
			return new Response("page");
		}, 30, async () => refused);
		expect(r.status).toBe(429);
		expect(rendered).toBe(0);
		expect(miss.put).toHaveLength(0);

		vi.unstubAllGlobals();
		stubCache(() => new Response("cached"));
		let gated = 0;
		const hit = await cachedPage(url, ctx(), {} as Env, async () => new Response("x"), 30, async () => {
			gated++;
			return refused;
		});
		expect(await hit.text()).toBe("cached");
		expect(gated).toBe(0);
	});

	it("a mixed-case address answers 301 to its lowercase page", async () => {
		const addr = "0xAbCdEf0123456789aBcDeF0123456789ABCDEF01";
		for (const base of ["/compute/consumers/wallet/", "/compute/providers/"]) {
			const path = `${base}${addr}`;
			const url = new URL(`https://morscan.io${path}?x=1`);
			const r = await handleUiRoutes(path, new Request(url), url, {} as Env, ctx());
			expect(r?.status).toBe(301);
			expect(r?.headers.get("Location")).toBe(`${base}${addr.toLowerCase()}?x=1`);
		}
	});
});

describe("the render budget", () => {
	const req = (h: Record<string, string> = { "CF-Connecting-IP": "198.51.100.7" }) =>
		new Request("https://morscan.io/compute/providers/0x" + "b".repeat(40), { headers: h });

	it("a request that never crossed the public edge is not counted", async () => {
		const rl = limiter(false);
		expect(await renderRefusal(req({}), { RL_STANDARD: rl } as unknown as Env)).toBeNull();
		expect(rl.keys).toHaveLength(0);
	});

	it("the per-IP first shed answers 429 with Retry-After", async () => {
		const rl = limiter(false);
		const r = await renderRefusal(req(), { RL_STANDARD: rl } as unknown as Env);
		expect(r?.status).toBe(429);
		expect(r?.headers.get("Retry-After")).toBe("60");
		expect(rl.keys).toEqual(["render:198.51.100.7"]);
		expect(await r?.text()).not.toMatch(/D1|Cloudflare|Worker|BigQuery/);
	});

	it("the global ceiling refuses past its count; a broken meter fails open", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0); // one shard
		const { ns } = fakeMeter();
		const env = { RL_STANDARD: limiter(true), CALL_METER: ns } as unknown as Env;
		let ok = 0;
		let refused = 0;
		for (let i = 0; i < 80; i++) {
			const r = await renderRefusal(req(), env);
			if (r) refused++;
			else ok++;
		}
		expect(ok).toBe(75); // 300 a minute over 4 shards
		expect(refused).toBe(5);
		const broken = { RL_STANDARD: limiter(true), CALL_METER: fakeMeter({ fail: true }).ns };
		expect(await renderRefusal(req(), broken as unknown as Env)).toBeNull();
	});
});

describe("/mor/v1/sessions paging", () => {
	const p = (q: string, max?: number) => sessionsPaging(new URL(`https://m.io/mor/v1/sessions${q}`), max);

	it("parses to integers, so spellings and unused params are one shape", () => {
		expect(p("?page=01&limit=100")).toEqual({ page: 1, limit: 100 });
		expect(p("?page=1x&limit=100&status=zz")).toEqual({ page: 1, limit: 100 });
		expect(p("?page=junk")).toEqual({ page: 1, limit: 100 });
		expect(p("?limit=500")).toEqual({ page: 1, limit: 100 });
	});

	it("clamps the depth: 1000 for keyed callers, FREE_SESSIONS_MAX_PAGE for free ones", () => {
		expect(p("?page=5000").page).toBe(1000);
		expect(p("?page=5000", FREE_SESSIONS_MAX_PAGE).page).toBe(50);
	});
});

describe("caller classes", () => {
	const env = {} as Env;
	const a = (x: Partial<AuthResult>) => ({ valid: true, ...x }) as AuthResult;
	it("names who pays", () => {
		expect(callerClass(a({ keyId: "admin" }), env)).toBe("admin");
		expect(callerClass(a({ keyId: "pack:0xabc", rateLimit: 100 }), env)).toBe("paid");
		expect(callerClass(a({ keyId: "x402:0xabc", rateLimit: 60 }), env)).toBe("paid");
		expect(callerClass(a({ keyId: "wallet:0xabc", rateLimit: 300 }), env)).toBe("paid");
		expect(callerClass(a({ keyId: "demo", rateLimit: 1_000_000 }), env)).toBe("free");
		expect(callerClass(a({ keyId: "wallet:0xabc", rateLimit: 200, walletAuth: true }), env)).toBe(
			"free",
		);
		expect(callerClass(a({ keyId: "wallet:0xdef", rateLimit: 60 }), env)).toBe("free");
	});
});

describe("the D1 read budget, by class", () => {
	it("free traffic spends only the free budget; paid keeps its own", async () => {
		const { ns } = fakeMeter();
		const env = { CALL_METER: ns, D1_DAILY_READ_BUDGET: "100000" } as unknown as Env;
		expect(await takeReadBudget(env, undefined, "free", 30_000)).toBe(true);
		expect(await takeReadBudget(env, undefined, "free", 30_000)).toBe(false); // 50k free budget
		expect(await takeReadBudget(env, undefined, "paid", 90_000)).toBe(true);
	});

	it("without a meter the per-class estimate still keeps the classes apart", async () => {
		const env = { D1_DAILY_READ_BUDGET: "1000", D1_FREE_READ_BUDGET: "100" } as unknown as Env;
		expect(await takeReadBudget(env, undefined, "free", 100)).toBe(true);
		expect(await takeReadBudget(env, undefined, "free", 1)).toBe(false);
		expect(await takeReadBudget(env, undefined, "paid", 500)).toBe(true);
	});

	it("the cached sessions aggregate is not a guarded read any more", () => {
		expect(heavyUncachedEstimate("/mor/v1/sessions/analytics")).toBe(0);
		expect(heavyUncachedEstimate("/mor/v1/provenance")).toBeGreaterThan(0);
	});

	it("a shed call is refused BEFORE the pack debit, so it is never charged", async () => {
		const KEY_ID = "pack:0x00000000000000000000000000000000000000c3";
		const SECRET = "mspk_0123456789abcdef0123456789abcdef0123cccc";
		const db = new FakeD1();
		db.setApiKey(KEY_ID, {
			daily_cap: 1_000_000_000,
			monthly_cap: 1_000_000_000,
			key: SECRET,
			name: "call pack (x402)",
			rate_limit: 100,
		});
		const debited: string[] = [];
		installProviders({
			commerce: {
				...referenceCommerceProvider,
				async debitCallBalance(_env, keyId) {
					debited.push(keyId);
					return null;
				},
			},
		});
		const { ns } = fakeMeter();
		// A budget smaller than one guarded read: the paid class is at budget.
		const env = {
			DB: db as unknown as D1Database,
			CALL_METER: ns,
			D1_DAILY_READ_BUDGET: "10",
		} as unknown as Env;
		const req = new Request("https://morscan.io/mor/v1/provenance", {
			headers: { "X-Morscan-Key": SECRET, "CF-Connecting-IP": "203.0.113.40" },
		});
		const url = new URL(req.url);
		const r = await handleApiRoutes(url.pathname, req, url, env, HEADERS);
		expect(r?.status).toBe(503);
		expect(r?.headers.get("Retry-After")).toBeTruthy();
		expect(debited).toEqual([]);
	});
});

describe("per-IP pools", () => {
	it("a tighter door gets the pool that holds it, under its own key", () => {
		const env = {
			RL_STANDARD: limiter(true),
			RL_LOW: limiter(true),
			RL_STRICT: limiter(true),
			RL_MED: limiter(true),
		} as unknown as Env;
		const ip = "192.0.2.1";
		expect(ipPool(env, 100, "/mor/v1/x", ip)).toMatchObject({ key: "ip:192.0.2.1", limit: 100 });
		expect(ipPool(env, 10, "/notify", ip)).toMatchObject({
			binding: env.RL_LOW,
			key: "ip:/notify:192.0.2.1",
			limit: 10,
		});
		expect(ipPool(env, 30, "/teaser", ip)).toMatchObject({ binding: env.RL_STRICT, limit: 30 });
		expect(ipPool(env, 60, "/mor/v1/capacity", ip)).toMatchObject({ binding: env.RL_MED, limit: 60 });
	});

	it("checkRateLimit uses the door's own pool and reports its real limit", async () => {
		const low = limiter(false);
		const std = limiter(true);
		const env = { RL_STANDARD: std, RL_LOW: low } as unknown as Env;
		const req = new Request("https://morscan.io/login", {
			method: "POST",
			headers: { "CF-Connecting-IP": "192.0.2.9" },
		});
		const r = await checkRateLimit(req, env, undefined, 10);
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("10/min");
		expect(low.keys).toEqual(["ip:/login:192.0.2.9"]);
		expect(std.keys).toEqual([]);
	});
});

describe("the usage log", () => {
	function fakeDb() {
		const inserted: unknown[][] = [];
		const db = {
			prepare(sql: string) {
				return {
					bind(...a: unknown[]) {
						if (sql.startsWith("INSERT INTO usage_log")) inserted.push(a);
						return this;
					},
					run: async () => ({ meta: { changes: 0 } }),
				};
			},
			batch: async () => [{}, {}],
		} as unknown as D1Database;
		return { db, inserted };
	}
	const bot = "AhrefsBot/7.0";
	const req = (path: string, h: Record<string, string> = {}) =>
		new Request(`https://morscan.io${path}`, { headers: { "user-agent": bot, ...h } });

	it("a 404 is recorded as (404), never as the stranger's path", async () => {
		expect(loggedPath("/wp-admin/x9f2", 404)).toBe("(404)");
		expect(loggedPath("/about", 200)).toBe("/about");
		const { db, inserted } = fakeDb();
		await logRequest({ DB: db } as Env, req("/rand-a8d1"), "/rand-a8d1", 404);
		expect(inserted[0][0]).toBe("(404)");
	});

	it("a string that cannot be a key is one tag", async () => {
		const env = {} as Env;
		expect(await credentialClass(req("/", { "X-Morscan-Key": "junk1" }), env)).toBe("key:malformed");
		expect(await credentialClass(req("/", { "X-Morscan-Key": "junk2" }), env)).toBe("key:malformed");
	});

	it("rows past the global ceiling are not written; a broken meter drops the row", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const { db, inserted } = fakeDb();
		const env = { DB: db, CALL_METER: fakeMeter().ns } as unknown as Env;
		for (let i = 0; i < 160; i++) await logRequest(env, req("/about"), "/about", 200);
		expect(inserted).toHaveLength(150); // 600 a minute over 4 shards
		const broken = fakeDb();
		const benv = { DB: broken.db, CALL_METER: fakeMeter({ fail: true }).ns } as unknown as Env;
		await logRequest(benv, req("/about"), "/about", 200);
		expect(broken.inserted).toHaveLength(0);
	});

	it("an address past its rate is thinned, and a kept row carries the weight", async () => {
		const { db, inserted } = fakeDb();
		const env = { DB: db, RL_STANDARD: limiter(false) } as unknown as Env;
		vi.spyOn(Math, "random").mockReturnValue(0.5); // dropped (keeps 1 in 20)
		await logRequest(env, req("/about", { "CF-Connecting-IP": "198.51.100.3" }), "/about", 200);
		expect(inserted).toHaveLength(0);
		vi.spyOn(Math, "random").mockReturnValue(0.01); // kept
		await logRequest(env, req("/about", { "CF-Connecting-IP": "198.51.100.3" }), "/about", 200);
		expect(inserted).toHaveLength(1);
		expect(inserted[0].at(-1)).toBe(20);
	});
});

describe("/notify", () => {
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
	});
	const post = (host: string, ip = "203.0.113.77") => {
		const url = new URL(`https://${host}/notify`);
		const req = new Request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
			body: JSON.stringify({ email: `a${Math.random()}@example.com` }),
		});
		return { url, req };
	};
	function notifyDb() {
		const rows: unknown[][] = [];
		return {
			rows,
			db: {
				prepare(sql: string) {
					return {
						bind(...a: unknown[]) {
							if (/notify_list/i.test(sql)) rows.push(a);
							return this;
						},
						run: async () => ({ meta: { changes: 1 } }),
					};
				},
			} as unknown as D1Database,
		};
	}

	it("is not answered on a host that does not serve the coming-soon page", async () => {
		const { db, rows } = notifyDb();
		const { url, req } = post("morscan.io");
		const env = { DB: db, COMING_SOON_HOSTS: "" } as unknown as Env;
		expect(await handlePublicRoutes("/notify", "POST", req, url, env, HEADERS)).toBeNull();
		expect(rows).toHaveLength(0);
	});

	it("on a coming-soon host it takes signups up to the day's ceiling, then 429", async () => {
		const { db, rows } = notifyDb();
		const env = {
			DB: db,
			COMING_SOON_HOSTS: "soon.example.com",
			CALL_METER: fakeMeter().ns,
		} as unknown as Env;
		let ok = 0;
		let last: Response | null = null;
		for (let i = 0; i < 202; i++) {
			const { url, req } = post("soon.example.com", `203.0.113.${i % 250}`);
			last = await handlePublicRoutes("/notify", "POST", req, url, env, HEADERS);
			if (last?.status === 200) ok++;
		}
		expect(ok).toBe(200);
		expect(rows).toHaveLength(200);
		expect(last?.status).toBe(429);
		expect(last?.headers.get("Retry-After")).toBeTruthy();
	});
});
