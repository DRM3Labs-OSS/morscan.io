/**
 * The wallet front door (GET /console/wallet/challenge + POST
 * /console/wallet/verify) signs an EIP-4361 (Sign-In with Ethereum) message
 * bound to the host and the wallet.
 *
 * Contract under test (routes/auth/wallet.ts + routes/auth/helpers.ts):
 *  - a challenge needs ?wallet=; without it the door says so (400) and no
 *    nonce is minted.
 *  - the returned message names the host, the URI, the chain, the wallet
 *    (EIP-55), the nonce and an expiry, in EIP-4361 order.
 *  - verify rebuilds that exact message: the real signer of the real message
 *    gets in (200, session cookie, a fresh key); a signature over any other
 *    text (the pre-2.50.9 two-line message) is refused; a nonce minted for
 *    wallet A cannot be presented with wallet B; a nonce minted on one host
 *    is refused on another; a nonce is single use.
 */

import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { handleWalletRoutes } from "../../src/routes/auth/wallet";
import { walletChallengeMessage } from "../../src/routes/auth/helpers";
import {
	bytesToHex,
	ecrecover,
	eip191Digest,
	hexToBytes,
	keccak256,
	toChecksumAddress,
} from "../../src/utils/crypto";
import type { Env } from "../../src/types";

// A throwaway test key (never funded, never used anywhere else).
const PRIV = hexToBytes("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318");
const PUB = secp256k1.getPublicKey(PRIV, false).slice(1);
const ADDR = `0x${bytesToHex(keccak256(PUB).slice(12))}`;
const OTHER = "0x000000000000000000000000000000000000dead";

function personalSign(message: string, priv: Uint8Array = PRIV): string {
	const digest = eip191Digest(message);
	const rec = secp256k1.sign(digest, priv, { prehash: false, format: "recovered" });
	const out = new Uint8Array(65);
	out.set(rec.slice(1, 65), 0);
	out[64] = rec[0] + 27;
	return `0x${bytesToHex(out)}`;
}

class FakeKV {
	readonly store = new Map<string, string>();
	async get(k: string): Promise<string | null> {
		return this.store.get(k) ?? null;
	}
	async put(k: string, v: string): Promise<void> {
		this.store.set(k, v);
	}
	async delete(k: string): Promise<void> {
		this.store.delete(k);
	}
}

/** A D1 that has no rows and accepts every write: a first-time wallet. */
class EmptyD1 {
	prepare(_sql: string) {
		const stmt = {
			bind: () => stmt,
			first: async () => null,
			run: async () => ({ success: true }),
			all: async () => ({ results: [] }),
		};
		return stmt;
	}
}

function makeEnv(kv = new FakeKV()): Env {
	return {
		DB: new EmptyD1() as unknown as D1Database,
		NONCE_CACHE: kv as unknown as KVNamespace,
		MORSCAN_JWT_SECRET: "test-secret-not-live",
	} as Env;
}

async function challenge(env: Env, wallet: string | null, host = "morscan.io") {
	const q = wallet === null ? "" : `?wallet=${wallet}`;
	const req = new Request(`https://${host}/console/wallet/challenge${q}`, {
		headers: { "CF-Connecting-IP": "203.0.113.7" },
	});
	const url = new URL(req.url);
	const res = await handleWalletRoutes(url.pathname, "GET", url, req, env);
	if (!res) throw new Error("route not handled");
	return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function verify(
	env: Env,
	body: { wallet: string; signature: string; nonce: string },
	host = "morscan.io",
) {
	const req = new Request(`https://${host}/console/wallet/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
		body: JSON.stringify(body),
	});
	const url = new URL(req.url);
	const res = await handleWalletRoutes(url.pathname, "POST", url, req, env);
	if (!res) throw new Error("route not handled");
	return {
		status: res.status,
		cookie: res.headers.get("Set-Cookie") || "",
		body: (await res.json()) as Record<string, unknown>,
	};
}

describe("wallet sign-in message", () => {
	it("the test key recovers to its own address (fixture sanity)", () => {
		const sig = personalSign("hello");
		expect(ecrecover(eip191Digest("hello"), sig)).toBe(ADDR);
	});

	it("is EIP-4361 shaped and names host, URI, chain, wallet, nonce, expiry", () => {
		const msg = walletChallengeMessage({
			domain: "morscan.io",
			uri: "https://morscan.io/console",
			address: ADDR,
			nonce: "0123456789abcdef0123456789abcdef",
			issuedAt: "2026-09-30T12:00:00.000Z",
		});
		const lines = msg.split("\n");
		expect(lines[0]).toBe("morscan.io wants you to sign in with your Ethereum account:");
		expect(lines[1]).toBe(toChecksumAddress(ADDR));
		expect(lines[1]).not.toBe(ADDR); // EIP-55 mixed case, not the lowercase form
		expect(msg).toContain("\nURI: https://morscan.io/console\n");
		expect(msg).toContain("\nVersion: 1\n");
		expect(msg).toContain("\nChain ID: 8453\n");
		expect(msg).toContain("\nNonce: 0123456789abcdef0123456789abcdef\n");
		expect(msg).toContain("\nIssued At: 2026-09-30T12:00:00.000Z\n");
		expect(msg.endsWith("Expiration Time: 2026-09-30T12:05:00.000Z")).toBe(true);
	});

	it("EIP-55 checksum matches the reference vector", () => {
		expect(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(
			"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
		);
	});
});

describe("GET /console/wallet/challenge", () => {
	it("requires ?wallet= and mints nothing without it", async () => {
		const kv = new FakeKV();
		const env = makeEnv(kv);
		const r = await challenge(env, null);
		expect(r.status).toBe(400);
		expect(r.body.error).toContain("?wallet=");
		expect(kv.store.size).toBe(0);
	});

	it("binds the minted nonce to the host and the wallet", async () => {
		const kv = new FakeKV();
		const env = makeEnv(kv);
		const r = await challenge(env, ADDR);
		expect(r.status).toBe(200);
		expect(r.body.wallet).toBe(ADDR);
		expect(r.body.domain).toBe("morscan.io");
		expect(r.body.message.startsWith("morscan.io wants you to sign in")).toBe(true);
		expect(r.body.message).toContain(toChecksumAddress(ADDR));
		const stored = JSON.parse(kv.store.get(`wchal:${r.body.nonce}`) || "{}");
		expect(stored).toMatchObject({ w: ADDR, d: "morscan.io", u: "https://morscan.io/console" });
	});
});

describe("POST /console/wallet/verify", () => {
	it("lets the real signer of the real message in, once", async () => {
		const env = makeEnv();
		const c = await challenge(env, ADDR);
		const v = await verify(env, {
			wallet: ADDR,
			signature: personalSign(c.body.message),
			nonce: c.body.nonce,
		});
		expect(v.status).toBe(200);
		expect(v.body.ok).toBe(true);
		expect(v.body.wallet).toBe(ADDR);
		expect(String(v.body.key)).toMatch(/^mor_[0-9a-f]{32}$/);
		expect(v.cookie).toContain("morscan_session=");
		// single use
		const again = await verify(env, {
			wallet: ADDR,
			signature: personalSign(c.body.message),
			nonce: c.body.nonce,
		});
		expect(again.status).toBe(400);
	});

	it("refuses a signature over the old unbound two-line message", async () => {
		const env = makeEnv();
		const c = await challenge(env, ADDR);
		const legacy = `MorScan wallet verification\nnonce: ${c.body.nonce}`;
		const v = await verify(env, {
			wallet: ADDR,
			signature: personalSign(legacy),
			nonce: c.body.nonce,
		});
		expect(v.status).toBe(401);
		expect(v.cookie).toBe("");
	});

	it("refuses a nonce minted for another wallet", async () => {
		const env = makeEnv();
		const c = await challenge(env, OTHER);
		const v = await verify(env, {
			wallet: ADDR,
			signature: personalSign(c.body.message),
			nonce: c.body.nonce,
		});
		expect(v.status).toBe(401);
		expect(String(v.body.error)).toContain("different wallet");
	});

	it("refuses a nonce minted on another host", async () => {
		const env = makeEnv();
		const c = await challenge(env, ADDR, "evil.example");
		const v = await verify(
			env,
			{ wallet: ADDR, signature: personalSign(c.body.message), nonce: c.body.nonce },
			"morscan.io",
		);
		expect(v.status).toBe(401);
		expect(String(v.body.error)).toContain("different host");
	});

	it("treats a pre-2.50.9 KV row as expired", async () => {
		const kv = new FakeKV();
		const env = makeEnv(kv);
		const nonce = "0123456789abcdef0123456789abcdef";
		kv.store.set(`wchal:${nonce}`, "1");
		const v = await verify(env, { wallet: ADDR, signature: personalSign("x"), nonce });
		expect(v.status).toBe(400);
	});
});
