/**
 * Capacity math - the PURE metering arithmetic behind GET /mor/v1/capacity.
 *
 * Extracted from capacity.ts so the drawdown math and the UTC bucketing can be
 * unit-tested directly. These are the exact seams where the phantom-usage and
 * counter-drift bugs lived: a fresh key must read zero, remaining must clamp at
 * zero, and the day/month bucket ids must roll over on the correct UTC boundary
 * (never serving a previous window's counters).
 */

/** UTC day/month bucket ids for a moment in time. Keys into usage_counters. */
export function utcBuckets(now: Date): { day: string; month: string } {
	const y = now.getUTCFullYear();
	const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	return { day: `d:${y}-${mo}-${d}`, month: `m:${y}-${mo}` };
}

/** UTC reset instants: next midnight (day) and first of next month (month). */
export function resetTimestamps(now: Date): {
	dayResetsAt: string;
	monthResetsAt: string;
} {
	const dayResetsAt = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	).toISOString();
	const monthResetsAt = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
	).toISOString();
	return { dayResetsAt, monthResetsAt };
}

/** Remaining capacity in a window, never negative. */
export function remaining(limit: number, used: number): number {
	return Math.max(0, limit - used);
}

/** Seconds until the current UTC minute rolls over (per-minute burst reset). */
export function perMinResetSeconds(now: Date): number {
	return 60 - now.getUTCSeconds();
}
