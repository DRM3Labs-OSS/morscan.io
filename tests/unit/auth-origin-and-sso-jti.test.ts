/**
 * Two auth-plane gates.
 *
 * 1. Cookie-authenticated POSTs (/console/*, /login) must come from this
 *    origin (routes/auth.ts + routes/auth/helpers.ts isSameOriginPost). The
 *    session cookie is SameSite=Lax, which lets a sibling *.morscan.io host
 *    ride it; the gate refuses Sec-Fetch-Site other than same-origin, and an
 *    Origin other than this origin, before the key is rotated or deleted. A
 *    caller with neither header (curl, an agent) is not a browser holding a
 *    victim's cookie and passes.
 * 2. An SSO launch token is single use (routes/auth/sso.ts + db/auth.ts
 *    claimSsoJti): the jti is claimed with INSERT OR IGNORE in D1, so a replay
 *    or a concurrent race gets no session, and a D1 failure gets none either
 *    (fail closed). NONCE_CACHE plays no part.
 */

import { describe, expect, it } from "vitest";
import { handleAuthRoutes } from "../../src/routes/auth";
import { signJwt } from "../../src/utils/jwt";
import type { Env } from "../../src/types";

const JWT_SECRET = "test-secret-not-live";
const APP_KEY = "test-sso-app-key-not-live";

/** A D1 that records DELETE FROM api_keys and models the sso_jti_seen batch. */
class RecordingD1 {
	readonly deleted: string[] = [];
	readonly jtis = new Map<string, number>();
	failBatch = false;
	prepare(sql: string) {
		let args: unknown[] = [];
		const stmt = {
			sql,
			bind: (...a: unknown[]) => {
				args = a;
				return stmt;
			},
			args: () => args,
			first: async () => null,
			all: async () => ({ results: [] }),
			run: async () => {
				if (sql.includes("DELETE FROM api_keys")) this.deleted.push(String(args[0]));
				return { success: true, meta: { changes: 1 } };
			},
		};
		return stmt;
	}
	async batch(stmts: { sql: string; args: () => unknown[] }[]) {
		// One await before any write, so concurrent callers interleave here the
		// way two isolates would; the writes below are then serialized like D1.
		await Promise.resolve();
		if (this.failBatch) throw new Error("D1_ERROR: simulated outage");
		return stmts.map((s) => {
			const a = s.args();
			if (s.sql.startsWith("DELETE FROM sso_jti_seen")) {
				for (const [k, exp] of this.jtis) if (exp < Number(a[0])) this.jtis.delete(k);
				return { success: true, meta: { changes: 0 } };
			}
			if (s.sql.startsWith("INSERT OR IGNORE INTO sso_jti_seen")) {
				const jti = String(a[0]);
				if (this.jtis.has(jti)) return { success: true, meta: { changes: 0 } };
				this.jtis.set(jti, Number(a[1]));
				return { success: true, meta: { changes: 1 } };
			}
			return { success: true, meta: { changes: 0 } };
		});
	}
}

function makeEnv(db = new RecordingD1()): Env {
	return {
		DB: db as unknown as D1Database,
		MORSCAN_JWT_SECRET: JWT_SECRET,
		SSO_APP_KEY: APP_KEY,
		SSO_APP_ID: "morscan",
		SSO_HUB_URL: "https://idp.example.com",
	} as Env;
}

async function post(env: Env, path: string, headers: Record<string, string>) {
	const session = await signJwt({ keyId: "wallet:0xabc", name: "w" }, JWT_SECRET);
	const req = new Request(`https://morscan.io${path}`, {
		method: "POST",
		headers: { Cookie: `morscan_session=${session}`, ...headers },
	});
	const url = new URL(req.url);
	const res = await handleAuthRoutes(url.pathname, "POST", url, req, env);
	if (!res) throw new Error("route not handled");
	return res;
}

describe("cookie-authenticated POSTs need this origin", () => {
	it("refuses a sibling host (Sec-Fetch-Site: same-site) and deletes nothing", async () => {
		const db = new RecordingD1();
		const res = await post(makeEnv(db), "/console/key/revoke", { "Sec-Fetch-Site": "same-site" });
		expect(res.status).toBe(403);
		expect(db.deleted).toEqual([]);
	});

	it("refuses cross-site and a foreign Origin", async () => {
		const db = new RecordingD1();
		const env = makeEnv(db);
		expect((await post(env, "/console/key", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
		expect(
			(await post(env, "/console/key/revoke", { Origin: "https://evil.morscan.io" })).status,
		).toBe(403);
		expect((await post(env, "/login", { Origin: "https://evil.example" })).status).toBe(403);
		expect(db.deleted).toEqual([]);
	});

	it("Sec-Fetch-Site wins over a matching Origin", async () => {
		const res = await post(makeEnv(), "/console/key/revoke", {
			"Sec-Fetch-Site": "same-site",
			Origin: "https://morscan.io",
		});
		expect(res.status).toBe(403);
	});

	it("lets the console page (same-origin) revoke", async () => {
		const db = new RecordingD1();
		const res = await post(makeEnv(db), "/console/key/revoke", {
			"Sec-Fetch-Site": "same-origin",
			Origin: "https://morscan.io",
		});
		expect(res.status).toBe(200);
		expect(db.deleted).toEqual(["wallet:0xabc"]);
	});

	it("lets a same-origin Origin through when Sec-Fetch-Site is absent", async () => {
		const db = new RecordingD1();
		const res = await post(makeEnv(db), "/console/key/revoke", { Origin: "https://morscan.io" });
		expect(res.status).toBe(200);
		expect(db.deleted).toEqual(["wallet:0xabc"]);
	});

	it("lets a non-browser caller (no Origin, no Sec-Fetch-Site) through", async () => {
		const db = new RecordingD1();
		const res = await post(makeEnv(db), "/console/key/revoke", {});
		expect(res.status).toBe(200);
	});
});

// ─── SSO launch token ───

function b64url(bytes: Uint8Array | string): string {
	const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	let s = "";
	for (const c of b) s += String.fromCharCode(c);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function launchToken(jti: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = b64url(
		JSON.stringify({ sub: "u_test", app: "morscan", jti, iat: now, exp: now + 60 }),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(APP_KEY),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`));
	return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

async function callback(env: Env, token: string) {
	const req = new Request(`https://morscan.io/sso/callback?token=${token}`);
	const url = new URL(req.url);
	const res = await handleAuthRoutes(url.pathname, "GET", url, req, env);
	if (!res) throw new Error("route not handled");
	return { status: res.status, cookie: res.headers.get("Set-Cookie") || "" };
}

describe("SSO launch token is single use", () => {
	it("first use signs in; a replay gets no session", async () => {
		const env = makeEnv();
		const token = await launchToken("jti-replay");
		const first = await callback(env, token);
		expect(first.status).toBe(302);
		expect(first.cookie).toContain("morscan_session=");
		const again = await callback(env, token);
		expect(again.status).toBe(302);
		expect(again.cookie).toBe("");
	});

	it("a concurrent race yields exactly one session", async () => {
		const env = makeEnv();
		const token = await launchToken("jti-race");
		const results = await Promise.all([1, 2, 3, 4].map(() => callback(env, token)));
		expect(results.filter((r) => r.cookie.includes("morscan_session=")).length).toBe(1);
	});

	it("fails closed when D1 cannot record the claim", async () => {
		const db = new RecordingD1();
		db.failBatch = true;
		const res = await callback(makeEnv(db), await launchToken("jti-outage"));
		expect(res.status).toBe(302);
		expect(res.cookie).toBe("");
	});
});
