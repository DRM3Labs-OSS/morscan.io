/**
 * Composition extensions (src/providers/extensions.ts).
 *
 * Contract under test:
 *  - the reference build registers nothing: no extra nav item, unknown
 *    /mor/v1 paths 404 before auth.
 *  - a registered plane shows in the header navigation, escaped, and is
 *    marked active by its key.
 *  - a registered /mor/v1 endpoint is known to the dispatcher but still
 *    answers 401 without a credential (the core gate runs first), and is
 *    served to a valid key.
 *  - an extension can never replace a built-in endpoint.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	describeExtensions,
	installExtensions,
} from "../../src/providers/extensions";
import { handleApiRoutes } from "../../src/routes/api";
import { renderHeader } from "../../src/ui/morscan_header";
import type { Env } from "../../src/types";
import { FakeD1 } from "./_fake-d1";

const USER_KEY = "mor_useruseruseruseruseruseruser0000";
const HEADERS = { "Content-Type": "application/json" };

function makeEnv(): Env {
	const db = new FakeD1();
	db.setApiKey("someone", { key: USER_KEY, daily_cap: null, monthly_cap: null });
	return { DB: db as unknown as D1Database } as Env;
}

async function api(env: Env, path: string, key?: string): Promise<Response> {
	const req = new Request(`https://morscan.io${path}`, {
		headers: { "CF-Connecting-IP": "203.0.113.9", ...(key ? { "X-Morscan-Key": key } : {}) },
	});
	const url = new URL(req.url);
	const res = await handleApiRoutes(url.pathname, req, url, env, HEADERS);
	if (!res) throw new Error(`route not handled: ${path}`);
	return res;
}

const header = (key: string) =>
	renderHeader({
		plane: { key, label: "X", href: "/x", subtitle: "x", subTabs: [], stats: [] },
	});

afterEach(() => installExtensions());

describe("composition extensions", () => {
	it("the reference build registers nothing", async () => {
		installExtensions();
		expect(describeExtensions()).toEqual({
			planes: [],
			publicRoutes: false,
			apiRoutes: false,
		});
		expect(header("compute")).not.toContain("/extra");
		expect((await api(makeEnv(), "/mor/v1/extra")).status).toBe(404);
	});

	it("a registered plane shows in the navigation, escaped, active by key", () => {
		installExtensions({ planes: [{ key: "extra", label: "A<b>", href: "/extra" }] });
		const idle = header("compute");
		expect(idle).toContain('<a href="/extra">A&lt;b&gt;</a>');
		expect(header("extra")).toContain(
			'<a href="/extra" class="active" aria-current="page">A&lt;b&gt;</a>',
		);
		expect(describeExtensions().planes).toEqual(["extra"]);
	});

	it("a registered endpoint sits behind the core gate", async () => {
		let calls = 0;
		installExtensions({
			apiRoutes: {
				known: (p) => p === "/mor/v1/extra",
				handle: async (_p, _r, _u, _e, headers) => {
					calls++;
					return new Response(JSON.stringify({ ok: true }), { headers });
				},
			},
		});
		const env = makeEnv();
		expect((await api(env, "/mor/v1/extra")).status).toBe(401);
		expect(calls).toBe(0);
		const ok = await api(env, "/mor/v1/extra", USER_KEY);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ ok: true });
		expect(calls).toBe(1);
		expect((await api(env, "/mor/v1/other", USER_KEY)).status).toBe(404);
	});

	it("an extension cannot replace a built-in endpoint", async () => {
		let calls = 0;
		installExtensions({
			apiRoutes: {
				known: () => true,
				handle: async () => {
					calls++;
					return new Response("hijacked");
				},
			},
		});
		const res = await api(makeEnv(), "/mor/v1/capacity", USER_KEY);
		expect(await res.text()).not.toBe("hijacked");
		expect(calls).toBe(0);
	});
});
