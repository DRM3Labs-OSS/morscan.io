import { describe, expect, it } from "vitest";
import {
	hexToString,
	padAddress,
	padUint256,
	parseArrayResult,
	parseBidResult,
	parseSessionResult,
} from "../../src/sync/parsers-abi";
import { addrWord, boolWord, bytes32, encode, uint } from "./_helpers";

describe("hex utilities", () => {
	it("padUint256 right-aligns to 64 hex chars", () => {
		expect(padUint256(0)).toBe("0".repeat(64));
		expect(padUint256(255)).toBe("ff".padStart(64, "0"));
	});

	it("padAddress strips 0x, lowercases, right-aligns", () => {
		expect(padAddress("0xAbC0000000000000000000000000000000000001")).toBe(
			"abc0000000000000000000000000000000000001".padStart(64, "0"),
		);
	});

	it("hexToString round-trips ASCII", () => {
		// "MOR" = 4d 4f 52
		expect(hexToString("4d4f52")).toBe("MOR");
	});
});

describe("parseBidResult - fixed-slot Diamond bid struct", () => {
	const provider = "0x1111111111111111111111111111111111111111";
	const modelId = "0xabcdef0000000000000000000000000000000000000000000000000000000001";

	it("decodes every field at its documented slot", () => {
		const result = encode(
			addrWord(provider),
			bytes32(modelId),
			uint(123456789n), // pricePerSecond
			uint(7), // nonce
			uint(1_700_000_000), // createdAt
			uint(0), // deletedAt (live bid)
		);
		const bid = parseBidResult(result);
		expect(bid).not.toBeNull();
		expect(bid?.provider).toBe(provider);
		expect(bid?.modelId).toBe(modelId);
		expect(bid?.pricePerSecond).toBe("123456789");
		expect(bid?.nonce).toBe(7);
		expect(bid?.createdAt).toBe(1_700_000_000);
		expect(bid?.deletedAt).toBe(0);
	});

	it("carries a large price through BigInt without precision loss", () => {
		const big = 999_999_999_999_999_999_999n; // > Number.MAX_SAFE_INTEGER
		const result = encode(
			addrWord(provider),
			bytes32(modelId),
			uint(big),
			uint(1),
			uint(1),
			uint(0),
		);
		expect(parseBidResult(result)?.pricePerSecond).toBe(big.toString());
	});

	it("returns null on empty / short input rather than throwing", () => {
		expect(parseBidResult("0x")).toBeNull();
		expect(parseBidResult(`0x${"00".repeat(50)}`)).toBeNull();
	});
});

describe("parseSessionResult - fixed-slot session struct", () => {
	const user = "0x2222222222222222222222222222222222222222";
	const bidId = "0xdeadbeef00000000000000000000000000000000000000000000000000000002";

	function session(openedAt: number, endsAt: number, closedAt: number, active: boolean) {
		return encode(
			uint(0), // word0 ignored
			addrWord(user), // word1: user (right-aligned)
			bytes32(bidId), // word2: bidId
			uint(500), // word3: stake
			uint(0), // word4: closeout receipt offset (skipped)
			uint(1), // word5: closeoutType (1 = dispute)
			uint(42), // word6: providerWithdrawn
			uint(openedAt), // word7
			uint(endsAt), // word8
			uint(closedAt), // word9
			boolWord(active), // word10: isActive (last byte)
		);
	}

	it("decodes fields and flags an early termination", () => {
		// closed before it was scheduled to end -> early termination
		const s = parseSessionResult(session(1000, 5000, 3000, false));
		expect(s).not.toBeNull();
		expect(s?.user).toBe(user);
		expect(s?.bidId).toBe(bidId);
		expect(s?.stake).toBe("500");
		expect(s?.closeoutType).toBe(1);
		expect(s?.providerWithdrawn).toBe("42");
		expect(s?.openedAt).toBe(1000);
		expect(s?.endsAt).toBe(5000);
		expect(s?.closedAt).toBe(3000);
		expect(s?.isActive).toBe(false);
		expect(s?.isEarlyTermination).toBe(true);
	});

	it("does not flag early termination when the session ran full term", () => {
		// closedAt == endsAt is NOT early
		const s = parseSessionResult(session(1000, 5000, 5000, false));
		expect(s?.isEarlyTermination).toBe(false);
	});

	it("does not flag early termination for a still-open session", () => {
		// closedAt 0 -> still open, never early
		const s = parseSessionResult(session(1000, 5000, 0, true));
		expect(s?.isActive).toBe(true);
		expect(s?.isEarlyTermination).toBe(false);
	});

	it("returns null on short input", () => {
		expect(parseSessionResult("0x")).toBeNull();
		expect(parseSessionResult(`0x${"00".repeat(100)}`)).toBeNull();
	});
});

describe("parseArrayResult - bytes32[]", () => {
	it("decodes a length-prefixed id array at its offset", () => {
		const id0 = "1".padStart(64, "0");
		const id1 = "2".padStart(64, "0");
		const result = encode(uint(32), uint(2), id0, id1);
		expect(parseArrayResult(result)).toEqual([`0x${id0}`, `0x${id1}`]);
	});

	it("returns [] for empty result", () => {
		expect(parseArrayResult("0x")).toEqual([]);
		expect(parseArrayResult(encode(uint(32), uint(0)))).toEqual([]);
	});
});
