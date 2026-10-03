/**
 * The SSO launch token names its audience and issuer, and its subject is checked
 * against the hub's revocation feed (routes/auth/sso.ts, utils/sso-launch.ts,
 * utils/sso-revocation.ts, vendor/drm3-sdk-sso.ts).
 *
 * 1. A token whose `aud` names another app, names no app, or whose `iss` is not
 *    the hub gets no session, even when its signature and `app` claim are good.
 * 2. A subject on the revocation feed gets no session at /sso/callback, and an
 *    IdP session already issued to it stops reading as signed in.
 * 3. Every feed read proves this app (X-DRM3-App + a Bearer signed with the app
 *    key, addressed to the feed). The feed failing to answer revokes nobody.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAuthRoutes } from "../../src/routes/auth";
import { handlePublicRoutes } from "../../src/routes/public";
import { signJwt } from "../../src/utils/jwt";
import { sessionPayload } from "../../src/utils/auth/session";
import type { Env } from "../../src/types";
import { resetRevocationGate } from "../../src/utils/sso-revocation";
import {
	mintSsoToken,
	REVOCATION_PROOF_AUD,
	verifySsoToken,
} from "../../src/vendor/drm3-sdk-sso";

const JWT_SECRET = "test-secret-not-live";
const APP_KEY = "test-sso-app-key-not-live";
const HUB = "https://idp.example.com";
const ISS = "idp.example.com";

/** A D1 that admits every jti once (the sso_jti_seen batch). */
class JtiD1 {
	readonly seen = new Set<string>();
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
			run: async () => ({ success: true, meta: { changes: 1 } }),
		};
		return stmt;
	}
	async batch(stmts: { sql: string; args: () => unknown[] }[]) {
		return stmts.map((s) => {
			if (!s.sql.startsWith("INSERT OR IGNORE INTO sso_jti_seen"))
				return { success: true, meta: { changes: 0 } };
			const jti = String(s.args()[0]);
			if (this.seen.has(jti)) return { success: true, meta: { changes: 0 } };
			this.seen.add(jti);
			return { success: true, meta: { changes: 1 } };
		});
	}
}

function makeEnv(): Env {
	return {
		DB: new JtiD1() as unknown as D1Database,
		MORSCAN_JWT_SECRET: JWT_SECRET,
		SSO_APP_KEY: APP_KEY,
		SSO_APP_ID: "morscan",
		SSO_HUB_URL: HUB,
	} as Env;
}

let n = 0;
async function launch(over: Record<string, unknown> = {}, sub = "u_alice"): Promise<string> {
	const claims = { sub, app: "morscan", aud: "morscan", iss: ISS, jti: `jti-${++n}`, ...over };
	for (const k of Object.keys(claims))
		if ((claims as Record<string, unknown>)[k] === undefined)
			delete (claims as Record<string, unknown>)[k];
	return mintSsoToken(APP_KEY, claims as Parameters<typeof mintSsoToken>[1], 60);
}

async function callback(env: Env, token: string) {
	const req = new Request(`https://morscan.io/sso/callback?token=${token}`);
	const url = new URL(req.url);
	const res = await handleAuthRoutes(url.pathname, "GET", url, req, env);
	if (!res) throw new Error("route not handled");
	return { status: res.status, cookie: res.headers.get("Set-Cookie") || "" };
}

type FeedCall = { url: string; headers: Record<string, string> };
let feedCalls: FeedCall[] = [];
function serveFeed(revoked: string[] | "down") {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		feedCalls.push({
			url: String(input),
			headers: (init?.headers || {}) as Record<string, string>,
		});
		if (revoked === "down") throw new Error("connect ECONNREFUSED");
		return Response.json({ revoked, asOf: 0 });
	});
}

beforeEach(() => {
	resetRevocationGate();
	feedCalls = [];
	serveFeed([]);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("launch token audience and issuer", () => {
	it("admits a token addressed to this app by the hub", async () => {
		const r = await callback(makeEnv(), await launch());
		expect(r.status).toBe(302);
		expect(r.cookie).toContain("morscan_session=");
	});

	it("refuses a token whose aud names another app", async () => {
		const r = await callback(makeEnv(), await launch({ aud: "lounge" }));
		expect(r.cookie).toBe("");
		const list = await callback(makeEnv(), await launch({ aud: ["lounge", "support"] }));
		expect(list.cookie).toBe("");
	});

	it("refuses a token that names no audience", async () => {
		const r = await callback(makeEnv(), await launch({ aud: undefined }));
		expect(r.cookie).toBe("");
	});

	it("refuses a token from another issuer, or none", async () => {
		expect((await callback(makeEnv(), await launch({ iss: "evil.example" }))).cookie).toBe(
			"",
		);
		expect((await callback(makeEnv(), await launch({ iss: undefined }))).cookie).toBe("");
	});

	it("refuses a token whose app claim and aud disagree", async () => {
		const r = await callback(makeEnv(), await launch({ app: "lounge" }));
		expect(r.cookie).toBe("");
	});
});

describe("revocation feed", () => {
	it("refuses a revoked subject at the callback", async () => {
		serveFeed(["u_banned"]);
		const r = await callback(makeEnv(), await launch({}, "u_banned"));
		expect(r.status).toBe(302);
		expect(r.cookie).toBe("");
		const ok = await callback(makeEnv(), await launch({}, "u_alice"));
		expect(ok.cookie).toContain("morscan_session=");
	});

	it("ends an IdP session already issued to a revoked subject", async () => {
		const env = makeEnv();
		const cookie = await signJwt({ keyId: "user:u_banned", name: "B" }, JWT_SECRET);
		const req = () =>
			new Request("https://morscan.io/api/me", {
				headers: { Cookie: `morscan_session=${cookie}` },
			});
		expect(await sessionPayload(req(), env)).not.toBeNull();
		resetRevocationGate();
		serveFeed(["u_banned"]);
		expect(await sessionPayload(req(), env)).toBeNull();
		const url = new URL("https://morscan.io/api/me");
		const res = await handlePublicRoutes(url.pathname, "GET", req(), url, env, {});
		expect(await res?.json()).toEqual({ signedIn: false });
	});

	it("leaves wallet sessions alone", async () => {
		serveFeed(["0xabc"]);
		const cookie = await signJwt({ keyId: "wallet:0xabc", name: "w" }, JWT_SECRET);
		const req = new Request("https://morscan.io/console", {
			headers: { Cookie: `morscan_session=${cookie}` },
		});
		expect(await sessionPayload(req, makeEnv())).not.toBeNull();
		expect(feedCalls.length).toBe(0);
	});

	it("proves this app on every feed read", async () => {
		await callback(makeEnv(), await launch());
		expect(feedCalls.length).toBe(1);
		const { url, headers } = feedCalls[0];
		expect(url).toBe(`${HUB}/api/sso/revocations`);
		expect(headers["X-DRM3-App"]).toBe("morscan");
		const proof = String(headers.Authorization).replace(/^Bearer /, "");
		const claims = await verifySsoToken(APP_KEY, proof, {
			aud: REVOCATION_PROOF_AUD,
			iss: "morscan",
		});
		expect(claims?.sub).toBe("app:morscan");
	});

	it("fails open when the feed is unreachable", async () => {
		serveFeed("down");
		const r = await callback(makeEnv(), await launch({}, "u_banned"));
		expect(r.cookie).toContain("morscan_session=");
	});
});
