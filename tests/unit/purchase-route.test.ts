/**
 * The purchasable-offer door (POST /mor/v1/keys/purchase) + the prepaid
 * call-balance debit hook - the two OPTIONAL CommerceProvider capabilities.
 *
 * Contract under test (routes/api.ts + providers/commerce/index.ts):
 *  - REFERENCE build: the route 404s (door absent), identical to any unknown
 *    path, and no debit hook ever runs.
 *  - A composed provider implementing purchaseOffer gets the request delegated
 *    verbatim (keyless, pre-auth); non-POST methods get 405.
 *  - The 402 envelope's offers menu renders from the ACTIVE provider's
 *    getOffers, so a composed pack door appears in every 402 (and in the
 *    canonical docs markdown) without touching the spec accepts fields.
 *  - debitCallBalance runs after the burst gate for keyed requests; a denial
 *    Response is returned as-is, null lets the request proceed.
 *  - mspk_ keys (the pack namespace) validate like mor_ keys.
 */

import { afterEach, describe, expect, it } from "vitest";
import { handleApiRoutes } from "../../src/routes/api";
import {
	installProviders,
	referenceCommerceProvider,
	type CommerceProvider,
} from "../../src/providers";
import { accessDoorsMarkdown, type Offer } from "../../src/providers/commerce/offers";
import { validateApiKey } from "../../src/utils/auth";
import { x402Response } from "../../src/utils/x402";
import type { Env } from "../../src/types";
import { FakeD1 } from "./_fake-d1";

const HEADERS = { "Content-Type": "application/json" };
const PAY_TO = "0x757D53D5FBAA99B1ea76c7B7e6B55D0063D0A7F6";

function makeEnv(db?: FakeD1): Env {
	return { DB: (db ?? new FakeD1()) as unknown as D1Database, X402_PAY_TO: PAY_TO } as Env;
}

function purchaseReq(method = "POST", ip = "203.0.113.9"): Request {
	return new Request("https://morscan.io/mor/v1/keys/purchase", {
		method,
		headers: { "CF-Connecting-IP": ip },
	});
}

async function callRoute(req: Request, env: Env): Promise<Response | null> {
	const url = new URL(req.url);
	return handleApiRoutes(url.pathname, req, url, env, HEADERS);
}

const PACK_DOOR: Offer = {
	id: "call-pack",
	kind: "pack",
	how: "Buy a call pack with x402: POST /mor/v1/keys/purchase (no payment header) returns 402 with the pack prices; retry with a signed X-PAYMENT for a pack price and the response includes an API key with that prepaid call balance.",
	packs: [
		{
			id: "pack-10k",
			calls: 10000,
			price: {
				amount: "1",
				currency: "USDC",
				network: "base",
				asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			},
		},
	],
	url: "https://morscan.io/auth.md",
};

afterEach(() => {
	installProviders(); // restore the pure reference registry after every test
});

describe("POST /mor/v1/keys/purchase", () => {
	it("404s on the REFERENCE build - the door is absent, like any unknown path", async () => {
		const res = await callRoute(purchaseReq(), makeEnv());
		expect(res?.status).toBe(404);
		expect(await res?.json()).toEqual({ error: "Not found" });
	});

	it("delegates to a provider that implements purchaseOffer (keyless, pre-auth)", async () => {
		let sawRequest: Request | null = null;
		const commerce: CommerceProvider = {
			...referenceCommerceProvider,
			async purchaseOffer(_env, request) {
				sawRequest = request;
				return new Response(JSON.stringify({ ok: true, door: "pack" }), {
					status: 200,
					headers: HEADERS,
				});
			},
		};
		installProviders({ commerce });
		const res = await callRoute(purchaseReq("POST", "203.0.113.10"), makeEnv());
		expect(res?.status).toBe(200);
		expect(await res?.json()).toEqual({ ok: true, door: "pack" });
		expect(sawRequest).not.toBeNull();
	});

	it("405s non-POST methods when the door exists", async () => {
		installProviders({
			commerce: {
				...referenceCommerceProvider,
				async purchaseOffer() {
					return new Response("never", { status: 200 });
				},
			},
		});
		const res = await callRoute(purchaseReq("GET", "203.0.113.11"), makeEnv());
		expect(res?.status).toBe(405);
		expect(res?.headers.get("Allow")).toContain("POST");
	});
});

describe("402 offers menu renders from the ACTIVE provider's getOffers", () => {
	it("a composed pack door appears in the 402 envelope; reference stays 3 doors", async () => {
		const env = makeEnv();
		const before = (await (await x402Response(env, "https://morscan.io/r")).json()) as {
			offers: Offer[];
		};
		expect(before.offers.map((o) => o.kind)).toEqual(["free", "stake", "per-call"]);

		installProviders({
			commerce: {
				...referenceCommerceProvider,
				async getOffers(e) {
					return [...(await referenceCommerceProvider.getOffers(e)), PACK_DOOR];
				},
			},
		});
		const after = (await (await x402Response(env, "https://morscan.io/r")).json()) as {
			offers: Offer[];
			accepts: unknown[];
		};
		expect(after.offers.map((o) => o.kind)).toEqual(["free", "stake", "per-call", "pack"]);
		expect(after.accepts).toHaveLength(1); // spec accepts untouched: per-call only
	});

	it("the canonical docs markdown gains the pack line from the same signal", async () => {
		const env = makeEnv();
		expect(await accessDoorsMarkdown(env)).not.toMatch(/call pack/i);
		installProviders({
			commerce: {
				...referenceCommerceProvider,
				async getOffers(e) {
					return [...(await referenceCommerceProvider.getOffers(e)), PACK_DOOR];
				},
			},
		});
		const md = await accessDoorsMarkdown(env);
		expect(md).toContain("Buy a call pack with x402");
		expect(md).toContain("POST /mor/v1/keys/purchase");
	});
});

describe("prepaid call-balance debit hook", () => {
	const KEY_ID = "pack:0x00000000000000000000000000000000000000b2";
	const SECRET = "mspk_0123456789abcdef0123456789abcdef01234567";

	function keyedEnv(): { env: Env; db: FakeD1 } {
		const db = new FakeD1();
		db.setApiKey(KEY_ID, {
			daily_cap: 1_000_000_000,
			monthly_cap: 1_000_000_000,
			key: SECRET,
			name: "call pack (x402)",
			rate_limit: 100,
		});
		return { env: makeEnv(db), db };
	}

	function dataReq(ip: string): Request {
		return new Request("https://morscan.io/mor/v1/models", {
			headers: { "X-Morscan-Key": SECRET, "CF-Connecting-IP": ip },
		});
	}

	it("mspk_ keys validate like mor_ keys (same api_keys row contract)", async () => {
		const { env } = keyedEnv();
		const auth = await validateApiKey(dataReq("203.0.113.20"), env);
		expect(auth.valid).toBe(true);
		expect(auth.keyId).toBe(KEY_ID);
	});

	it("a denial Response from debitCallBalance is returned as-is (402, not 429)", async () => {
		const debited: string[] = [];
		installProviders({
			commerce: {
				...referenceCommerceProvider,
				async debitCallBalance(_env, keyId) {
					debited.push(keyId);
					return new Response(JSON.stringify({ error: "call balance exhausted" }), {
						status: 402,
						headers: HEADERS,
					});
				},
			},
		});
		const { env } = keyedEnv();
		const res = await callRoute(dataReq("203.0.113.21"), env);
		expect(res?.status).toBe(402);
		expect(debited).toEqual([KEY_ID]);
	});

	it("null from debitCallBalance lets the request proceed to the data dispatch", async () => {
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
		const { env } = keyedEnv();
		// FakeD1 has no data tables, so REACHING the dispatch throws its
		// unsupported-SQL error - which proves the debit hook allowed the call.
		await expect(callRoute(dataReq("203.0.113.22"), env)).rejects.toThrow(
			/unsupported SQL/,
		);
		expect(debited).toEqual([KEY_ID]);
	});

	it("REFERENCE build has no hook: request reaches dispatch with no debit", async () => {
		const { env } = keyedEnv();
		await expect(callRoute(dataReq("203.0.113.23"), env)).rejects.toThrow(
			/unsupported SQL/,
		);
	});
});
