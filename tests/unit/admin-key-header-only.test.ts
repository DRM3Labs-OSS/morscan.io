/**
 * The operator admin key travels in the X-Morscan-Key header and nowhere else.
 *
 * Contract under test (handlers/admin-alerts.ts, handlers/admin-notify.ts,
 * routes/api.ts):
 *  - any admin door that sees ?key= in the URL answers 400 before the key is
 *    validated (the habit must not silently keep working).
 *  - no header -> 401; a non-admin key -> 401; the admin row's key -> past the
 *    gate.
 *  - the two HTML shells are served without a key and never contain one.
 *  - /mor/v1/bq/status is admin-gated (403 to the serving key), like backfill.
 */

import { describe, expect, it } from "vitest";
import { handleAdminAlertsRoutes } from "../../src/handlers/admin-alerts";
import { handleAdminNotifyRoutes } from "../../src/handlers/admin-notify";
import { handleApiRoutes } from "../../src/routes/api";
import type { Env } from "../../src/types";
import { FakeD1 } from "./_fake-d1";

const ADMIN_KEY = "mor_adminadminadminadminadminadmin00";
const USER_KEY = "mor_useruseruseruseruseruseruser0000";
const DEMO_KEY = "mor_demodemodemodemodemodemodemo0000";

function makeEnv(): Env {
	const db = new FakeD1();
	db.setApiKey("admin", { key: ADMIN_KEY, daily_cap: null, monthly_cap: null });
	db.setApiKey("someone", { key: USER_KEY, daily_cap: null, monthly_cap: null });
	return { DB: db as unknown as D1Database, MORSCAN_DEMO_KEY: DEMO_KEY } as Env;
}

type Handler = (path: string, request: Request, url: URL, env: Env) => Promise<Response | null>;

async function call(
	handler: Handler,
	env: Env,
	path: string,
	init: RequestInit & { query?: string } = {},
): Promise<Response> {
	const { query = "", ...rest } = init;
	const req = new Request(`https://morscan.io${path}${query}`, {
		...rest,
		headers: { "CF-Connecting-IP": "203.0.113.9", ...(rest.headers as Record<string, string>) },
	});
	const url = new URL(req.url);
	const res = await handler(url.pathname, req, url, env);
	if (!res) throw new Error(`route not handled: ${path}`);
	return res;
}

const DOORS: Array<{ handler: Handler; path: string; method: string; html: boolean }> = [
	{ handler: handleAdminAlertsRoutes, path: "/admin/alerts", method: "GET", html: true },
	{ handler: handleAdminAlertsRoutes, path: "/api/admin/alerts", method: "GET", html: false },
	{ handler: handleAdminAlertsRoutes, path: "/api/admin/alerts/test", method: "POST", html: false },
	{ handler: handleAdminNotifyRoutes, path: "/admin/notify", method: "GET", html: true },
	{ handler: handleAdminNotifyRoutes, path: "/api/admin/notify", method: "GET", html: false },
];

describe("admin key is header-only", () => {
	for (const d of DOORS) {
		it(`${d.method} ${d.path} refuses ?key= with 400`, async () => {
			const res = await call(d.handler, makeEnv(), d.path, {
				method: d.method,
				query: `?key=${ADMIN_KEY}`,
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("not accepted in the URL");
		});
	}

	for (const d of DOORS.filter((x) => !x.html)) {
		it(`${d.method} ${d.path}: no header 401, user key 401, admin header passes`, async () => {
			const env = makeEnv();
			expect((await call(d.handler, env, d.path, { method: d.method })).status).toBe(401);
			expect(
				(
					await call(d.handler, env, d.path, {
						method: d.method,
						headers: { "X-Morscan-Key": USER_KEY },
					})
				).status,
			).toBe(401);
			const ok = await call(d.handler, env, d.path, {
				method: d.method,
				headers: { "X-Morscan-Key": ADMIN_KEY },
			});
			expect(ok.status).not.toBe(401);
			expect(ok.status).not.toBe(400);
		});
	}

	for (const d of DOORS.filter((x) => x.html)) {
		it(`GET ${d.path} is a keyless shell`, async () => {
			const res = await call(d.handler, makeEnv(), d.path);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("text/html");
			const html = await res.text();
			expect(html).not.toContain(ADMIN_KEY);
			expect(html).not.toContain("const KEY = '");
			expect(html).toContain("'X-Morscan-Key'");
			expect(html).toContain('id="key"');
		});
	}
});

describe("GET /mor/v1/bq/status", () => {
	it("is admin-gated: the serving key gets 403", async () => {
		const env = makeEnv();
		const req = new Request("https://morscan.io/mor/v1/bq/status", {
			headers: { "X-Morscan-Key": DEMO_KEY, "CF-Connecting-IP": "203.0.113.9" },
		});
		const url = new URL(req.url);
		const res = await handleApiRoutes(url.pathname, req, url, env, {
			"Content-Type": "application/json",
		});
		expect(res?.status).toBe(403);
	});
});
