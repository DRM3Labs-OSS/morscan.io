/**
 * SDK wallet-auth (EIP-712) nonce dedup against Workers KV.
 *
 * Contract under test (utils/auth/wallet-validation.ts):
 *  - the dedup write uses a TTL of at least 60 seconds. Workers KV refuses
 *    any smaller expirationTtl with a 400 (the 2.50.9 draft put 10 and KV
 *    rejected every write), so the FakeKV here mirrors that refusal.
 *  - the write is awaited but non-fatal: when the put rejects for any reason
 *    the signed request still gets its normal result instead of a 500.
 *  - a nonce already on record is refused ("Nonce already used").
 *
 * The request is a real EIP-712 signature over the request struct, built with
 * the same buildEIP712Message the server verifies against, sent to a
 * localhost URL so the local-dev bypass stands in for a signer attestation.
 */

import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { validateWalletAuth } from "../../src/utils/auth/wallet-validation";
import { buildEIP712Message } from "../../src/utils/wallet-auth";
import { bytesToHex, hexToBytes, keccak256 } from "../../src/utils/crypto";
import type { Env } from "../../src/types";

// A throwaway test key (never funded, never used anywhere else).
const PRIV = hexToBytes("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318");
const PUB = secp256k1.getPublicKey(PRIV, false).slice(1);
const ADDR = `0x${bytesToHex(keccak256(PUB).slice(12))}`;
const STAKING = "0x00000000000000000000000000000000000000aa";
const PATH = "/mor/v1/builder/0x00000000000000000000000000000000000000aa";

const KV_MIN_TTL = 60;

/** Mirrors Workers KV: a put with expirationTtl below 60 is a 400. */
class StrictKV {
	readonly store = new Map<string, string>();
	readonly ttls: number[] = [];
	async get(k: string): Promise<string | null> {
		return this.store.get(k) ?? null;
	}
	async put(k: string, v: string, opts?: { expirationTtl?: number }): Promise<void> {
		const ttl = opts?.expirationTtl;
		if (ttl !== undefined) {
			this.ttls.push(ttl);
			if (ttl < KV_MIN_TTL) {
				throw new Error(
					`KV PUT failed: 400 Invalid expiration_ttl of ${ttl}. Expiration TTL must be at least 60.`,
				);
			}
		}
		this.store.set(k, v);
	}
	async delete(k: string): Promise<void> {
		this.store.delete(k);
	}
}

/** A KV whose every put fails (an outage). */
class DownKV extends StrictKV {
	async put(): Promise<void> {
		throw new Error("KV PUT failed: 500 internal error");
	}
}

/** A D1 with no rows: no attestation, no CI wallet. */
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

function makeEnv(kv: StrictKV): Env {
	return {
		DB: new EmptyD1() as unknown as D1Database,
		NONCE_CACHE: kv as unknown as KVNamespace,
	} as Env;
}

function randomNonce(): Uint8Array {
	const n = new Uint8Array(32);
	crypto.getRandomValues(n);
	return n;
}

/** Build a GET request signed the way the SDK signs it. */
function signedRequest(nonce: Uint8Array = randomNonce()): Request {
	const ts = Math.floor(Date.now() / 1000);
	const version = "test-1.0.0";
	const bodyHash = keccak256(new Uint8Array(0));
	const digest = buildEIP712Message(ts, "GET", PATH, version, nonce, bodyHash);
	const rec = secp256k1.sign(digest, PRIV, { prehash: false, format: "recovered" });
	const sig = new Uint8Array(65);
	sig.set(rec.slice(1, 65), 0);
	sig[64] = rec[0] + 27;
	return new Request(`http://localhost${PATH}`, {
		method: "GET",
		headers: {
			"X-Morscan-Wallet": ADDR,
			"X-Morscan-Ts": String(ts),
			"X-Morscan-Sig": `0x${bytesToHex(sig)}`,
			"X-Morscan-Nonce": `0x${bytesToHex(nonce)}`,
			"X-Morscan-Version": version,
			"X-Morscan-Staking-Wallet": STAKING,
		},
	});
}

describe("wallet-auth nonce dedup (Workers KV)", () => {
	it("the signed request passes and the dedup write uses a TTL of at least 60s", async () => {
		const kv = new StrictKV();
		const result = await validateWalletAuth(signedRequest(), makeEnv(kv));
		expect(result.valid).toBe(true);
		expect(result.walletAuth).toBe(true);
		expect(result.stakingWallet).toBe(STAKING);
		expect(result.derivedAddress).toBe(ADDR.toLowerCase());
		expect(kv.ttls).toHaveLength(1);
		expect(kv.ttls[0]).toBeGreaterThanOrEqual(KV_MIN_TTL);
		expect(kv.store.size).toBe(1);
	});

	it("a nonce already on record is refused", async () => {
		const kv = new StrictKV();
		const nonce = randomNonce();
		const first = await validateWalletAuth(signedRequest(nonce), makeEnv(kv));
		expect(first.valid).toBe(true);
		const replay = await validateWalletAuth(signedRequest(nonce), makeEnv(kv));
		expect(replay.valid).toBe(false);
		expect(replay.error).toBe("Nonce already used");
	});

	it("a failing KV put is logged and the request still gets its normal result", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await validateWalletAuth(signedRequest(), makeEnv(new DownKV()));
			expect(result.valid).toBe(true);
			expect(result.walletAuth).toBe(true);
			expect(result.stakingWallet).toBe(STAKING);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(String(spy.mock.calls[0][0])).toContain("nonce dedup put failed");
		} finally {
			spy.mockRestore();
		}
	});

	it("a wrong signature is still refused (the dedup change did not loosen the gate)", async () => {
		const req = signedRequest();
		const headers = new Headers(req.headers);
		headers.set("X-Morscan-Wallet", "0x000000000000000000000000000000000000dead");
		const tampered = new Request(req.url, { method: "GET", headers });
		const result = await validateWalletAuth(tampered, makeEnv(new StrictKV()));
		expect(result.valid).toBe(false);
	});
});
