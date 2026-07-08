import { describe, expect, it } from "vitest";
import {
	getKeyCapsWithUsage,
	incrementUsageCounters,
	listUsageCounters,
} from "../../src/db/auth";
import {
	perMinResetSeconds,
	remaining,
	resetTimestamps,
	utcBuckets,
} from "../../src/handlers/capacity-math";
import { FakeD1 } from "./_fake-d1";

// D1Database structural stand-in for the real functions under test.
// biome-ignore lint/suspicious/noExplicitAny: FakeD1 satisfies the used surface
const asDb = (d: FakeD1) => d as any;

describe("capacity math", () => {
	it("remaining never goes negative (over-limit key clamps to 0)", () => {
		expect(remaining(2000, 0)).toBe(2000);
		expect(remaining(2000, 500)).toBe(1500);
		expect(remaining(2000, 2000)).toBe(0);
		expect(remaining(2000, 2500)).toBe(0); // over-drawn -> clamped
	});

	it("utcBuckets ids are UTC and zero-padded", () => {
		expect(utcBuckets(new Date("2026-07-07T12:00:00Z"))).toEqual({
			day: "d:2026-07-07",
			month: "m:2026-07",
		});
		expect(utcBuckets(new Date("2026-01-05T00:00:00Z"))).toEqual({
			day: "d:2026-01-05",
			month: "m:2026-01",
		});
	});

	it("day bucket rolls over exactly at UTC midnight, not local time", () => {
		const before = utcBuckets(new Date("2026-07-07T23:59:59Z"));
		const after = utcBuckets(new Date("2026-07-08T00:00:00Z"));
		expect(before.day).toBe("d:2026-07-07");
		expect(after.day).toBe("d:2026-07-08");
		expect(before.month).toBe(after.month); // same month across the day boundary
	});

	it("month bucket rolls over on the last->first day boundary", () => {
		const lastDay = utcBuckets(new Date("2026-07-31T23:59:59Z"));
		const firstDay = utcBuckets(new Date("2026-08-01T00:00:00Z"));
		expect(lastDay.month).toBe("m:2026-07");
		expect(firstDay.month).toBe("m:2026-08");
	});

	it("reset timestamps point to next UTC midnight and first of next month", () => {
		const { dayResetsAt, monthResetsAt } = resetTimestamps(
			new Date("2026-07-07T09:30:00Z"),
		);
		expect(dayResetsAt).toBe("2026-07-08T00:00:00.000Z");
		expect(monthResetsAt).toBe("2026-08-01T00:00:00.000Z");
	});

	it("month reset wraps the year on December", () => {
		const { monthResetsAt } = resetTimestamps(new Date("2026-12-15T00:00:00Z"));
		expect(monthResetsAt).toBe("2027-01-01T00:00:00.000Z");
	});

	it("perMinResetSeconds counts down to the next UTC minute", () => {
		expect(perMinResetSeconds(new Date("2026-07-07T09:30:15Z"))).toBe(45);
		expect(perMinResetSeconds(new Date("2026-07-07T09:30:00Z"))).toBe(60);
	});
});

describe("usage counters against a fake D1 (the phantom-usage / drift path)", () => {
	const KEY = "wallet:0xabc";
	const day = "d:2026-07-07";
	const month = "m:2026-07";

	it("a FRESH key reads zero used (no phantom usage)", async () => {
		const db = new FakeD1();
		db.setApiKey(KEY, { daily_cap: 2000, monthly_cap: 40000 });
		const row = await getKeyCapsWithUsage(asDb(db), KEY, day, month);
		expect(row).not.toBeNull();
		// no counters written yet -> both counts are null, which the handler reads as 0
		expect(row?.day_count ?? 0).toBe(0);
		expect(row?.month_count ?? 0).toBe(0);
		expect(await listUsageCounters(asDb(db), KEY, day, month)).toEqual([]);
	});

	it("one increment moves BOTH day and month by exactly one", async () => {
		const db = new FakeD1();
		db.setApiKey(KEY, { daily_cap: 2000, monthly_cap: 40000 });
		await incrementUsageCounters(asDb(db), KEY, day, month);
		const row = await getKeyCapsWithUsage(asDb(db), KEY, day, month);
		expect(row?.day_count).toBe(1);
		expect(row?.month_count).toBe(1);
	});

	it("N increments keep day and month in lockstep (no drift)", async () => {
		const db = new FakeD1();
		db.setApiKey(KEY, { daily_cap: 2000, monthly_cap: 40000 });
		for (let i = 0; i < 7; i++) {
			await incrementUsageCounters(asDb(db), KEY, day, month);
		}
		const row = await getKeyCapsWithUsage(asDb(db), KEY, day, month);
		expect(row?.day_count).toBe(7);
		expect(row?.month_count).toBe(7);
		// remaining reflects the drawdown, clamped at zero
		expect(remaining(row?.daily_cap ?? 0, row?.day_count ?? 0)).toBe(2000 - 7);
	});

	it("a new UTC day resets the day counter while the month keeps accruing", async () => {
		const db = new FakeD1();
		db.setApiKey(KEY, { daily_cap: 2000, monthly_cap: 40000 });
		// day 7: three calls
		for (let i = 0; i < 3; i++) {
			await incrementUsageCounters(asDb(db), KEY, "d:2026-07-07", month);
		}
		// day 8: one call (new day bucket, same month bucket)
		await incrementUsageCounters(asDb(db), KEY, "d:2026-07-08", month);
		const day8 = await getKeyCapsWithUsage(asDb(db), KEY, "d:2026-07-08", month);
		expect(day8?.day_count).toBe(1); // fresh day bucket
		expect(day8?.month_count).toBe(4); // month kept accruing across the boundary
	});

	it("returns null for a key with no api_keys row (serving/demo key path)", async () => {
		const db = new FakeD1();
		// no setApiKey -> getKeyCapsWithUsage must return null so the caller
		// falls back to free caps + listUsageCounters
		expect(await getKeyCapsWithUsage(asDb(db), "demo", day, month)).toBeNull();
	});
});
