/**
 * GET /mor/v1/capacity - the caller's REMAINING rate-limit capacity.
 *
 * FREE introspection: this endpoint is IP-rate-limited, NOT key-metered (see the
 * carve-out in routes/api.ts). Checking your remaining capacity must never cost
 * capacity, so this handler only READS the authoritative counters - it never
 * increments them and never 429s the key. Real data endpoints draw day/month
 * down (flat 1 tick/call); this readout reflects that drawdown accurately.
 *
 * Reset windows are UTC. Per-minute burst is enforced by the rate-limit bindings
 * (no readable used-count), so perMin here reports the limit only.
 */

import type { Env } from "../types";
import type { AuthResult } from "../utils/auth";
import { FREE_VOLUME, stakeMorFor } from "../utils/stake-tier";
import { getKeyCapsWithUsage, listUsageCounters } from "../db/auth";
import {
	perMinResetSeconds,
	remaining,
	resetTimestamps,
	utcBuckets,
} from "./capacity-math";

// ─── Very short per-key cache for the D1-derived numbers ───
// /mor/v1/capacity is FREE and a distributed-flood target ("someone could call
// capacity a billion times"). Per-IP volume is already bounded by the in-worker
// 60/min cap and the Cloudflare edge rate-limit rule (50/10s per IP). This cache
// shields the remaining exposure - many distinct IPs asking for the SAME key -
// by collapsing repeated lookups to at most one D1 read per key per TTL per
// isolate. TTL is tiny so the readout stays essentially live; only the D1-backed
// numbers are cached (caps/usage/stake), while the time-derived reset fields are
// recomputed fresh on every call.
interface CapNumbers {
	perMinLimit: number;
	dailyLimit: number;
	monthlyLimit: number;
	dayUsed: number;
	monthUsed: number;
	stakeMor: number;
	wallet: string | null;
}
const CAP_TTL_MS = 5000;
const capCache = new Map<string, { at: number; v: CapNumbers }>();

function capCacheGet(k: string): CapNumbers | null {
	const e = capCache.get(k);
	if (!e) return null;
	if (Date.now() - e.at > CAP_TTL_MS) {
		capCache.delete(k);
		return null;
	}
	return e.v;
}
function capCacheSet(k: string, v: CapNumbers): void {
	// Bound memory against a flood of distinct keys; a rare full clear is cheap.
	if (capCache.size > 5000) capCache.clear();
	capCache.set(k, { at: Date.now(), v });
}

async function loadCapNumbers(
	env: Env,
	auth: AuthResult,
	keyId: string,
	day: string,
	month: string,
): Promise<CapNumbers> {
	const perMinLimit = auth.rateLimit ?? 10;
	const wallet = keyId.startsWith("wallet:") ? keyId.slice("wallet:".length) : null;

	// One D1 query covers caps + both usage buckets for a real api_keys row.
	const row = await getKeyCapsWithUsage(env.DB, keyId, day, month).catch(() => null);

	let dailyLimit: number;
	let monthlyLimit: number;
	let dayUsed: number;
	let monthUsed: number;
	if (row) {
		dailyLimit = row.daily_cap ?? FREE_VOLUME.daily;
		monthlyLimit = row.monthly_cap ?? FREE_VOLUME.monthly;
		dayUsed = row.day_count ?? 0;
		monthUsed = row.month_count ?? 0;
	} else {
		// No api_keys row (serving/demo key): free caps, but still surface any
		// usage_counters that exist for this id.
		dailyLimit = FREE_VOLUME.daily;
		monthlyLimit = FREE_VOLUME.monthly;
		const counts = await listUsageCounters(env.DB, keyId, day, month).catch(() => null);
		dayUsed = 0;
		monthUsed = 0;
		for (const c of counts || []) {
			if (c.bucket === day) dayUsed = c.count;
			else if (c.bucket === month) monthUsed = c.count;
		}
	}

	// Live stake only for wallet identities (api_keys id is `wallet:<addr>`).
	const stakeMor = wallet ? await stakeMorFor(env, wallet) : 0;

	return { perMinLimit, dailyLimit, monthlyLimit, dayUsed, monthUsed, stakeMor, wallet };
}

export async function handleCapacity(
	env: Env,
	auth: AuthResult,
	HEADERS: Record<string, string>,
): Promise<Response> {
	const keyId = auth.keyId || "";
	const now = new Date();
	const { day, month } = utcBuckets(now);
	const resetInSeconds = perMinResetSeconds(now);

	// The D1-backed numbers (caps/usage/stake), served from the short per-key
	// cache when warm; only a cold key touches D1. The bucket ids are part of the
	// cache key so a UTC rollover never serves the previous window's counters.
	const cacheKey = `${keyId}|${day}|${month}`;
	let nums = capCacheGet(cacheKey);
	if (!nums) {
		nums = await loadCapNumbers(env, auth, keyId, day, month);
		capCacheSet(cacheKey, nums);
	}

	// Reset timestamps (UTC): next midnight (day), first of next month (month).
	const { dayResetsAt, monthResetsAt } = resetTimestamps(now);

	const body = {
		perMin: {
			limit: nums.perMinLimit,
			// Free introspection does not consume the per-minute burst budget.
			used: 0,
			remaining: nums.perMinLimit,
			resetInSeconds,
		},
		today: {
			limit: nums.dailyLimit,
			used: nums.dayUsed,
			remaining: remaining(nums.dailyLimit, nums.dayUsed),
			resetsAt: dayResetsAt,
		},
		month: {
			limit: nums.monthlyLimit,
			used: nums.monthUsed,
			remaining: remaining(nums.monthlyLimit, nums.monthUsed),
			resetsAt: monthResetsAt,
		},
		stakeMor: nums.stakeMor,
		wallet: nums.wallet,
	};

	return new Response(JSON.stringify(body), { headers: HEADERS });
}
