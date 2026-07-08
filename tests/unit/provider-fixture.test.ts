/**
 * Real-data test for parseProviderResult against a frozen Base mainnet response.
 *
 * The v2.20.0 suite only covered the malformed-input guard for the dynamic
 * getProvider decoder, because a hand-encoded fixture risks testing the encoder
 * against itself. This closes that gap with a REAL eth_call response captured
 * from the Morpheus Diamond on Base (see tests/unit/fixtures/morpheus-eth-call.json):
 * provider 0x63da1c6b..., a real (now deleted) provider whose endpoint, stake,
 * and createdAt are genuine on-chain values.
 *
 *   - result_deleted: the verbatim on-chain bytes (isDeleted = 1) -> null.
 *   - result_active : the same bytes with only the isDeleted flag cleared ->
 *     the real endpoint/stake/createdAt decode correctly (offset math, BigInt
 *     stake as string, unix createdAt, and the dynamic endpoint string).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProviderResult } from "../../src/sync/parsers-abi.ts";

const fixture = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("./fixtures/morpheus-eth-call.json", import.meta.url)),
		"utf8",
	),
) as {
	provider_addr: string;
	result_deleted: string;
	result_active: string;
	decoded_active_expected: { endpoint: string; stake: string; createdAt: number };
};

describe("parseProviderResult (real Base data)", () => {
	it("returns null for a real DELETED provider (isDeleted guard, real bytes)", () => {
		expect(parseProviderResult(fixture.result_deleted, fixture.provider_addr)).toBeNull();
	});

	it("decodes endpoint/stake/createdAt from real active-provider bytes", () => {
		const r = parseProviderResult(fixture.result_active, fixture.provider_addr);
		expect(r).not.toBeNull();
		expect(r).toEqual(fixture.decoded_active_expected);
		// Spell out the invariants: dynamic string decode, stake stays a string
		// (BigInt-safe), createdAt is a plausible recent unix timestamp.
		expect(r?.endpoint).toBe("morpheus.lmn.lumerin.io:3333");
		expect(typeof r?.stake).toBe("string");
		expect(r?.createdAt).toBeGreaterThan(1_700_000_000);
	});
});
