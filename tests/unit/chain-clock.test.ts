import { describe, expect, it } from "vitest";
import {
	DEFAULT_BLOCK_TIME_MS,
	blocksForSeconds,
	lagSeconds,
	measureBlockTimeMs,
	parseBlockTimeMs,
} from "../../src/sync/chain-clock";

describe("measureBlockTimeMs", () => {
	it("measures the ~200ms cadence Base moved to on 2026-11-05", () => {
		// Real readings: 1000 blocks in 200s.
		const a = { block: 55_707_825, timestamp: 1_794_331_940 };
		const h = { block: 55_708_825, timestamp: 1_794_332_140 };
		expect(measureBlockTimeMs(a, h)).toBe(200);
	});

	it("measures the old ~2s cadence", () => {
		expect(measureBlockTimeMs({ block: 100, timestamp: 0 }, { block: 160, timestamp: 120 })).toBe(
			2000,
		);
	});

	it("refuses a span too short to trust (1s timestamp resolution)", () => {
		expect(measureBlockTimeMs({ block: 100, timestamp: 0 }, { block: 150, timestamp: 10 })).toBe(
			null,
		);
	});

	it("refuses a head that did not move or went backwards", () => {
		expect(measureBlockTimeMs({ block: 100, timestamp: 0 }, { block: 100, timestamp: 90 })).toBe(
			null,
		);
		expect(measureBlockTimeMs({ block: 100, timestamp: 0 }, { block: 90, timestamp: 90 })).toBe(
			null,
		);
	});

	it("refuses an implausible cadence", () => {
		// 60s over 10M blocks = 6 microseconds per block: a bad reading.
		expect(
			measureBlockTimeMs({ block: 1, timestamp: 0 }, { block: 10_000_001, timestamp: 60 }),
		).toBe(null);
	});
});

describe("parseBlockTimeMs", () => {
	it("falls back to the default for missing or bad values", () => {
		expect(parseBlockTimeMs(null)).toBe(DEFAULT_BLOCK_TIME_MS);
		expect(parseBlockTimeMs("")).toBe(DEFAULT_BLOCK_TIME_MS);
		expect(parseBlockTimeMs("nope")).toBe(DEFAULT_BLOCK_TIME_MS);
		expect(parseBlockTimeMs("0")).toBe(DEFAULT_BLOCK_TIME_MS);
	});
	it("keeps a stored measurement", () => {
		expect(parseBlockTimeMs("2000")).toBe(2000);
	});
});

describe("blocksForSeconds / lagSeconds", () => {
	it("converts a time margin to blocks at either cadence", () => {
		expect(blocksForSeconds(10, 200)).toBe(50);
		expect(blocksForSeconds(10, 2000)).toBe(5);
		expect(blocksForSeconds(0, 200)).toBe(1);
	});
	it("converts a block gap to seconds", () => {
		expect(lagSeconds(151, 200)).toBe(30);
		expect(lagSeconds(50, 2000)).toBe(100);
		expect(lagSeconds(null, 200)).toBe(null);
		expect(lagSeconds(-3, 200)).toBe(0);
	});
});
