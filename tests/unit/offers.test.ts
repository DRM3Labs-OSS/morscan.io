/**
 * Canonical access-doors tests.
 *
 * Guards the Phase 1 commerce contract:
 *  - getOffers()/liveAccessDoors returns the LIVE doors in the agreed shape.
 *  - The 402 envelope keeps the spec x402 fields BYTE-IDENTICAL (golden test
 *    mirroring the pre-change production envelope) and only ADDS offers+hint.
 *  - Honesty: no public surface mentions the unbuilt call-pack door, and the
 *    per-call door disappears entirely when the operator has not enabled x402.
 *  - Drift: the static /console and /stake tier tables and the /stake markdown
 *    must match capsForStake exactly (the canonical mapping).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleAuthMd, handleMcpServerCard } from "../../src/handlers/agent-ready";
import { handleLlmsTxt } from "../../src/handlers/llms";
import { referenceCommerceProvider } from "../../src/providers/commerce";
import {
	accessHint,
	freeCapsPhrase,
	INTERNAL_CALL_PACK_USD_PER_CALL,
	liveAccessDoors,
} from "../../src/providers/commerce/offers";
import type { Env } from "../../src/types";
import { capsForStake, CONNECTED_CAPS } from "../../src/utils/stake-tier";
import { x402Requirements, x402Response } from "../../src/utils/x402";

const PAY_TO = "0x757D53D5FBAA99B1ea76c7B7e6B55D0063D0A7F6";
const envWithX402 = { X402_PAY_TO: PAY_TO } as Env;
const envNoX402 = {} as Env;
const RESOURCE = "https://morscan.example.com/mor/v1/providers";

describe("liveAccessDoors / getOffers", () => {
	it("returns the three live doors (free, stake, per-call) when x402 is enabled", async () => {
		const doors = await referenceCommerceProvider.getOffers(envWithX402);
		expect(doors.map((d) => d.kind)).toEqual(["free", "stake", "per-call"]);
		expect(doors.map((d) => d.id)).toEqual(["free-key", "stake-mor", "x402-per-call"]);
		for (const d of doors) {
			expect(d.how.length).toBeGreaterThan(20);
			expect(d.url).toMatch(/^https:\/\//);
		}
	});

	it("free door carries the connected-wallet caps (delegated to capsForStake)", () => {
		const free = liveAccessDoors(envWithX402).find((d) => d.kind === "free");
		expect(free?.caps).toEqual(capsForStake(0));
		expect(free?.caps).toEqual(CONNECTED_CAPS);
	});

	it("stake door examples are computed from capsForStake, never duplicated", () => {
		const stake = liveAccessDoors(envWithX402).find((d) => d.kind === "stake");
		expect(stake?.capsByStakeMor).toEqual({
			"100": capsForStake(100),
			"500": capsForStake(500),
			"2500": capsForStake(2500),
		});
	});

	it("per-call door price comes from the x402 config (default 0.01 USDC)", () => {
		const perCall = liveAccessDoors(envWithX402).find((d) => d.kind === "per-call");
		expect(perCall?.price).toEqual({
			amount: "0.01",
			currency: "USDC",
			network: "base",
			asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			per: "call",
		});
		const priced = liveAccessDoors({
			X402_PAY_TO: PAY_TO,
			X402_PRICE_USDC: "0.05",
		} as Env).find((d) => d.kind === "per-call");
		expect(priced?.price?.amount).toBe("0.05");
	});

	it("HONEST: the per-call door disappears when x402 is not enabled", () => {
		const doors = liveAccessDoors(envNoX402);
		expect(doors.map((d) => d.kind)).toEqual(["free", "stake"]);
		expect(accessHint(envNoX402)).not.toMatch(/pay per call/i);
	});
});

describe("402 envelope", () => {
	it("keeps the spec x402 fields byte-identical to the pre-offers envelope", async () => {
		const res = await x402Response(envWithX402, RESOURCE);
		expect(res.status).toBe(402);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.x402Version).toBe(1);
		// Golden accepts entry: this is EXACTLY what production served before the
		// offers field existed (modulo the resource URL). Additive fields only.
		const golden = {
			scheme: "exact",
			network: "base",
			maxAmountRequired: "10000",
			resource: RESOURCE,
			description:
				"MorScan metered API call (0.01 USDC). Alternative: mint a free API key (60 req/min) with one wallet signature - see /auth.md",
			mimeType: "application/json",
			payTo: PAY_TO,
			maxTimeoutSeconds: 60,
			asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			extra: { name: "USD Coin", version: "2" },
		};
		expect(JSON.stringify(body.accepts)).toBe(JSON.stringify([golden]));
		expect(JSON.stringify(body.accepts)).toBe(
			JSON.stringify([x402Requirements(envWithX402, RESOURCE)]),
		);
	});

	it("adds the offers menu and an agent hint alongside accepts", async () => {
		const body = (await (await x402Response(envWithX402, RESOURCE)).json()) as {
			offers: Array<{ kind: string }>;
			hint: string;
		};
		expect(body.offers.map((o) => o.kind)).toEqual(["free", "stake", "per-call"]);
		expect(JSON.stringify(body.offers)).toBe(
			JSON.stringify(liveAccessDoors(envWithX402)),
		);
		expect(body.hint).toContain("/console");
		expect(body.hint).toContain("/stake");
		expect(body.hint).toContain("X-PAYMENT");
		expect(body.hint).toContain(freeCapsPhrase());
	});

	it("carries the error field on a rejected payment, offers intact", async () => {
		const body = (await (
			await x402Response(envWithX402, RESOURCE, "nonce already used")
		).json()) as {
			error: string;
			offers: unknown[];
			accepts: unknown[];
		};
		expect(body.error).toBe("nonce already used");
		expect(body.offers).toHaveLength(3);
		expect(body.accepts).toHaveLength(1);
	});
});

describe("honesty: the REFERENCE build never renders the pack door", () => {
	it("defines the pack rate but keeps it off every reference surface", async () => {
		expect(INTERNAL_CALL_PACK_USD_PER_CALL).toBe(0.0001);
		const surfaces = [
			await (await handleLlmsTxt(envWithX402)).text(),
			await (await handleAuthMd(envWithX402)).text(),
			await handleMcpServerCard(envWithX402).text(),
			await (await x402Response(envWithX402, RESOURCE)).text(),
			JSON.stringify(liveAccessDoors(envWithX402)),
			accessHint(envWithX402),
		];
		for (const text of surfaces) {
			expect(text).not.toMatch(/call[- ]?pack/i);
			expect(text).not.toMatch(/0\.0001/);
			expect(text).not.toMatch(/call balance/i);
			expect(text).not.toMatch(/buy credits|credit balance/i);
		}
	});
});

describe("copy drift: static pages match capsForStake", () => {
	const root = join(__dirname, "..", "..");
	const rowsOf = (html: string): number[][] =>
		[...html.matchAll(/<tr[^>]*>(?:<td>.*?<\/td>)+<\/tr>/g)]
			.map((m) =>
				[...m[0].matchAll(/<td>([\d,]+)<\/td>/g)].map((c) =>
					Number(c[1].replace(/,/g, "")),
				),
			)
			.filter((r) => r.length === 3);

	it("console tier table matches capsForStake(0/100/500/2500)", () => {
		const html = readFileSync(
			join(root, "src/ui/partials/console-body.html"),
			"utf8",
		);
		const rows = rowsOf(html);
		const expected = [0, 100, 500, 2500].map((m) => {
			const c = capsForStake(m);
			return [c.burst, c.daily, c.monthly];
		});
		expect(rows).toEqual(expected);
	});

	it("/stake page tier table matches capsForStake(0/100/500)", () => {
		const html = readFileSync(join(root, "src/ui/pages/stake.html"), "utf8");
		const rows = rowsOf(html);
		const expected = [0, 100, 500].map((m) => {
			const c = capsForStake(m);
			return [c.burst, c.daily, c.monthly];
		});
		expect(rows).toEqual(expected);
	});

	it("/stake markdown tier table matches capsForStake(0/100/500)", () => {
		// Read the source (importing the handler drags in worker-only HTML
		// modules vitest cannot parse); the table lives in stakeMd()'s literal.
		const text = readFileSync(
			join(root, "src/handlers/markdown-pages.ts"),
			"utf8",
		);
		const rows = [...text.matchAll(/^\|[^|]+\| ([\d,]+) \| ([\d,]+) \| ([\d,]+) \|$/gm)].map(
			(m) => m.slice(1, 4).map((n) => Number(n.replace(/,/g, ""))),
		);
		const expected = [0, 100, 500].map((m) => {
			const c = capsForStake(m);
			return [c.burst, c.daily, c.monthly];
		});
		expect(rows).toEqual(expected);
	});
});
