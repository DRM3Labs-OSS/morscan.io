/**
 * /verify page tests.
 *
 * The page's in-browser verification core (script id="verifier-logic" in
 * src/ui/pages/verify.html) is a port of scripts/verify-receipt.mjs. These
 * tests hold the two implementations byte-for-byte equal against a REAL
 * receipt captured from the live API (tests/unit/fixtures/
 * price-receipt-live.json, GET https://morscan.io/mor/v1/price on 2026-07-08),
 * and prove the ported path verifies that live signature:
 *
 *  1. canonical-bytes equality: the page's receiptPayload() output equals what
 *     verify-receipt.mjs's canonicalize() computes for the same fixture.
 *  2. the fixture's real Ed25519 signature verifies over the PAGE-computed
 *     payload, via the page's own verifySignature() (WebCrypto, the exact code
 *     a browser runs) and independently via @noble/curves (the CLI's library).
 *  3. tampering one byte makes the same check fail.
 *  4. key matching against the live-captured /.well-known/morscan-keys.json.
 *
 * Both sources are read from disk and evaluated, so the assertions run the
 * SHIPPED code, not a copy that could drift.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

const pageHtml = readFileSync(root("src/ui/pages/verify.html"), "utf8");
const cliSource = readFileSync(root("scripts/verify-receipt.mjs"), "utf8");
const fixture = JSON.parse(
	readFileSync(root("tests/unit/fixtures/price-receipt-live.json"), "utf8"),
);
const keysFixture = JSON.parse(
	readFileSync(root("tests/unit/fixtures/morscan-keys-live.json"), "utf8"),
);

// ── Evaluate the page's shipped verifier core ──────────────────────────────

type Receipt = Record<string, unknown> & {
	id: string;
	timestamp: string;
	signature: string;
	public_key: string;
};
interface VerifierApi {
	canonicalize(v: unknown): string;
	receiptPayload(r: Receipt): string;
	hexBytes(s: string): Uint8Array;
	extractReceipt(body: unknown): Receipt | null;
	matchPublishedKey(keys: unknown, r: Receipt): Record<string, string> | null;
	ed25519Supported(): Promise<boolean>;
	verifySignature(r: Receipt): Promise<boolean>;
}

function loadPageVerifier(): VerifierApi {
	const m = pageHtml.match(
		/<script id="verifier-logic">([\s\S]*?)<\/script>/,
	);
	if (!m) throw new Error("verifier-logic script not found in verify.html");
	// The block assigns globalThis.MorscanVerify; run it and read the result.
	new Function(m[1])();
	const api = (globalThis as Record<string, unknown>).MorscanVerify;
	if (!api) throw new Error("verifier-logic did not export MorscanVerify");
	return api as VerifierApi;
}

// Extract the CLI verifier's canonicalize() from its shipped source (it is a
// top-level script with a top-level await, so it cannot be imported).
function loadCliCanonicalize(): (v: unknown) => string {
	const m = cliSource.match(/function canonicalize\(v\) \{[\s\S]*?\n\}/);
	if (!m) throw new Error("canonicalize not found in verify-receipt.mjs");
	return new Function(`${m[0]}; return canonicalize;`)() as (v: unknown) => string;
}

const page = loadPageVerifier();
const cliCanonicalize = loadCliCanonicalize();
const receipt = fixture._provenance_aggregate as Receipt;

// The exact payload construction verify-receipt.mjs signs over (its step 2).
function cliPayload(r: Receipt): string {
	return cliCanonicalize({
		id: r.id,
		action: r.action,
		timestamp: r.timestamp,
		input_hash: r.input_hash,
		output_hash: r.output_hash,
		cost: r.cost ?? null,
		duration_ms: r.duration_ms ?? null,
		parent_id: r.parent_id ?? null,
		metadata: r.metadata ?? null,
		public_key: r.public_key,
	});
}

describe("verify page: canonicalization port (live fixture)", () => {
	it("page payload bytes match verify-receipt.mjs byte for byte", () => {
		const pagePayload = page.receiptPayload(receipt);
		expect(pagePayload).toBe(cliPayload(receipt));
		// And the raw canonicalize functions agree on arbitrary shapes.
		const shapes = [
			null,
			42,
			"x",
			[3, { b: 2, a: [null, "y"] }],
			{ z: 1, a: { d: null, c: [1, 2] }, m: "s" },
			receipt,
			fixture,
		];
		for (const s of shapes) expect(page.canonicalize(s)).toBe(cliCanonicalize(s));
	});

	it("the live signature verifies over the page-computed payload (noble, the CLI's library)", () => {
		const payload = page.receiptPayload(receipt);
		const sig = page.hexBytes(receipt.signature);
		const pub = page.hexBytes(receipt.public_key);
		expect(ed25519.verify(sig, new TextEncoder().encode(payload), pub)).toBe(true);
	});

	it("the page's own WebCrypto path verifies the live receipt", async () => {
		// Node >= 20 ships Ed25519 WebCrypto, the same surface browsers run.
		expect(await page.ed25519Supported()).toBe(true);
		expect(await page.verifySignature(receipt)).toBe(true);
	});

	it("one changed byte fails the page's check", async () => {
		const tampered = { ...receipt, output_hash: `${receipt.output_hash}`.replace(/.$/, (c) => (c === "0" ? "1" : "0")) };
		expect(await page.verifySignature(tampered as Receipt)).toBe(false);
	});

	it("receipt extraction handles data responses, /version, and bare receipts", () => {
		expect(page.extractReceipt(fixture)).toBe(receipt);
		expect(page.extractReceipt({ receipt })).toBe(receipt);
		expect(page.extractReceipt(receipt)).toBe(receipt);
		expect(page.extractReceipt({ usd: 1 })).toBeNull();
		expect(page.extractReceipt(null)).toBeNull();
	});

	it("key matching finds the live key within its validity window", () => {
		const match = page.matchPublishedKey(keysFixture, receipt);
		expect(match).not.toBeNull();
		expect(match?.path).toBe("morscan/cache");
		expect(match?.key).toBe(receipt.public_key);
		// An unpublished key does not match.
		expect(
			page.matchPublishedKey(keysFixture, {
				...receipt,
				public_key: "ed25519:00000000000000000000000000000000000000000000000000000000000000ff",
			}),
		).toBeNull();
		// A timestamp outside every window does not match.
		expect(
			page.matchPublishedKey(keysFixture, { ...receipt, timestamp: "2020-01-01T00:00:00Z" }),
		).toBeNull();
	});
});

describe("verify page: markup + route", () => {
	it("page carries the verdict + walkthrough markup", () => {
		expect(pageHtml).toContain('id="verdict"');
		expect(pageHtml).toContain('id="verdict-word"');
		for (const n of [1, 2, 3, 4, 5]) expect(pageHtml).toContain(`id="step-${n}"`);
		expect(pageHtml).toContain("Your browser is checking the math right now");
		expect(pageHtml).toContain('id="raw-json"');
		expect(pageHtml).toContain("/.well-known/morscan-keys.json");
		expect(pageHtml).toContain("https://drm3.io/signers");
		// Self-hosted IBM Plex Mono, per the console convention.
		expect(pageHtml).toContain("/fonts/ibm-plex-mono-400.woff2");
		// Graceful message for browsers without Ed25519 WebCrypto.
		expect(pageHtml).toContain("Ed25519 WebCrypto");
	});

	it("no em or en dashes anywhere in the page", () => {
		// \u escapes so this file itself stays clean under the dash sweep.
		expect(pageHtml).not.toMatch(/[\u2013\u2014\u2212]/);
	});

	it("GET /verify routes to the page handler with HTML headers (200)", async () => {
		const { handleVerifyPage } = await import("../../src/handlers/ui/pages");
		const resp = handleVerifyPage();
		expect(resp.status).toBe(200);
		expect(resp.headers.get("Content-Type")).toContain("text/html");
		// The route itself is registered in src/routes/ui.ts.
		const uiRoutes = readFileSync(root("src/routes/ui.ts"), "utf8");
		expect(uiRoutes).toContain('path === "/verify"');
		expect(uiRoutes).toContain("handleVerifyPage");
	});
});
