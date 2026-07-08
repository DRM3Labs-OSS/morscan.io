import { describe, expect, it } from "vitest";
import {
	CONFIRMATION_BUFFER,
	MAX_LOG_RANGE,
	hasSessionErrors,
	isStall,
	planSyncRange,
	shouldAdvanceCursor,
} from "../../src/sync/plan";

describe("planSyncRange - confirmation buffer + range cap", () => {
	it("resumes at lastEventBlock+1 and stops at head minus the confirmation buffer", () => {
		const r = planSyncRange(1000, 1050);
		expect(r.fromBlock).toBe(1001);
		expect(r.toBlock).toBe(1050 - CONFIRMATION_BUFFER);
		expect(r.gap).toBe(r.toBlock - r.fromBlock + 1);
		expect(r.upToDate).toBe(false);
	});

	it("cold start (no cursor) begins CONFIRMATION_BUFFER blocks back from head", () => {
		const r = planSyncRange(0, 5000);
		expect(r.fromBlock).toBe(5000 - CONFIRMATION_BUFFER);
		expect(r.toBlock).toBe(5000 - CONFIRMATION_BUFFER);
		expect(r.gap).toBe(1);
	});

	it("caps a huge backlog at MAX_LOG_RANGE blocks per tick", () => {
		const r = planSyncRange(0 + 1, 10_000_000); // from=2, head far away
		expect(r.fromBlock).toBe(2);
		expect(r.toBlock).toBe(2 + MAX_LOG_RANGE - 1);
		expect(r.gap).toBe(MAX_LOG_RANGE);
	});

	it("reports upToDate (gap 0) once the cursor is within the buffer of head", () => {
		// lastEventBlock already at safeHead: fromBlock would be past safeHead
		const r = planSyncRange(100, 103); // safeHead = 98, from = 101 > 98
		expect(r.upToDate).toBe(true);
		expect(r.gap).toBe(0);
	});

	it("never plans a range that crosses safeHead", () => {
		const r = planSyncRange(90, 100); // safeHead = 95
		expect(r.toBlock).toBeLessThanOrEqual(100 - CONFIRMATION_BUFFER);
	});
});

describe("shouldAdvanceCursor - THE gap-proof invariant", () => {
	it("advances only when neither the fetch nor session processing failed", () => {
		expect(shouldAdvanceCursor(false, false)).toBe(true);
	});

	it("HOLDS the cursor when a getLogs fetch threw (empty logs are an RPC error, not a quiet range)", () => {
		expect(shouldAdvanceCursor(true, false)).toBe(false);
	});

	it("HOLDS the cursor when a session processor reported an error", () => {
		expect(shouldAdvanceCursor(false, true)).toBe(false);
	});

	it("HOLDS on both failures", () => {
		expect(shouldAdvanceCursor(true, true)).toBe(false);
	});
});

describe("hasSessionErrors", () => {
	it("matches SessionOpened / SessionClosed error strings", () => {
		expect(hasSessionErrors(["eth_getLogs Diamond: SessionOpened write failed"])).toBe(
			true,
		);
		expect(hasSessionErrors(["boom SessionClosed boom"])).toBe(true);
	});

	it("ignores unrelated errors", () => {
		expect(hasSessionErrors([])).toBe(false);
		expect(hasSessionErrors(["eth_getLogs MOR: timeout"])).toBe(false);
	});
});

describe("isStall - detection heuristic", () => {
	it("flags a tick that processed no blocks", () => {
		expect(isStall(0, 0, 0, 0)).toBe(true);
	});

	it("flags a wide gap that returned zero Diamond AND zero MOR events", () => {
		expect(isStall(500, 0, 0, 500)).toBe(true);
	});

	it("does NOT flag a wide but genuinely productive gap", () => {
		expect(isStall(500, 3, 0, 500)).toBe(false);
		expect(isStall(500, 0, 12, 500)).toBe(false);
	});

	it("does NOT flag a small quiet gap (normal near head)", () => {
		expect(isStall(20, 0, 0, 20)).toBe(false);
	});
});
