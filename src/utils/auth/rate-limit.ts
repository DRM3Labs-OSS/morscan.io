/**
 * Rate limiting - minute burst + day/month volume caps.
 *
 * Minute layer (burst protection):
 * - Durable Workers rate-limiting bindings when configured ([[ratelimits]]);
 *   per-isolate in-memory Map as the unconfigured fallback.
 * - Dual: per-IP (100/min) + per-key (api_keys.rate_limit).
 *
 * Volume layer (the anchored good - see src/utils/stake-tier.ts):
 * - usage_counters rows per key per bucket ('d:YYYY-MM-DD' / 'm:YYYY-MM', UTC).
 * - Caps come from the key's api_keys row (daily_cap/monthly_cap; NULL means
 *   the free defaults 2,000/day + 40,000/month).
 * - Reads are cached per isolate for 60s so the steady-state cost is the two
 *   counter UPSERTs per request and ~zero extra D1 reads. Consequence: caps
 *   are enforced within a minute or two of the counter crossing the line,
 *   not on the exact request.
 * - Exemptions: the `admin` key id entirely; keys with no api_keys row (the
 *   env-configured demo key) have nothing to hang a cap on and are skipped.
 */

import type { Env } from "../../types";
import { baseUrl } from "../../config";
import { getKeyCapsWithUsage, incrementUsageCounters } from "../../db/auth";
import { FREE_VOLUME } from "../stake-tier";
import { isAdminAuth, type AuthResult } from "./key-validation";

const HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

const rateCounts = new Map<string, { count: number; minute: number }>();

function incrementCounter(key: string, minute: number): number {
	const entry = rateCounts.get(key);
	if (entry && entry.minute === minute) {
		entry.count++;
		return entry.count;
	}
	// New minute window - reset. Also prune stale entries periodically.
	if (rateCounts.size > 10000) {
		for (const [k, v] of rateCounts) {
			if (v.minute < minute) rateCounts.delete(k);
		}
	}
	rateCounts.set(key, { count: 1, minute });
	return 1;
}

function getCount(key: string, minute: number): number {
	const entry = rateCounts.get(key);
	return entry && entry.minute === minute ? entry.count : 0;
}

// ─── Day/month volume caps ───

interface VolumeEntry {
	hasRow: boolean;
	dailyCap: number;
	monthlyCap: number;
	dayCount: number;
	monthCount: number;
	dayBucket: string;
	monthBucket: string;
	fetchedAt: number;
}

// Per-isolate cache of {caps, counts} per key, refreshed every 60s. Counts are
// advanced locally between refreshes, so steady-state adds ~zero D1 reads and
// enforcement lands within a minute or two across isolates.
const volumeCache = new Map<string, VolumeEntry>();
const VOLUME_TTL_MS = 60_000;

function utcBuckets(now: Date): { day: string; month: string } {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	return { day: `d:${y}-${m}-${d}`, month: `m:${y}-${m}` };
}

function secondsUntilUtcMidnight(now: Date): number {
	const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function secondsUntilNextUtcMonth(now: Date): number {
	const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
	return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

interface VolumeUsage {
	limit: number;
	remaining: number;
}

/**
 * Enforce-then-count for the day/month volume caps. Returns `{ deny }` set when
 * the request must be rejected (else deny=null), plus the precise day/month
 * limit+remaining pulled from the SAME volumeCache entry the check already reads
 * (no extra D1 read) so callers can emit X-RateLimit-*-Day/Month headers.
 * Fails open on D1 errors - a broken meter must not take the API down.
 */
async function checkVolumeCaps(
	env: Env,
	keyId: string,
): Promise<{
	deny: { retryAfter: number; reason: string } | null;
	day?: VolumeUsage;
	month?: VolumeUsage;
}> {
	if (keyId === "admin") return { deny: null }; // operator key: exempt, no counting

	const now = new Date();
	const { day, month } = utcBuckets(now);

	try {
		let entry = volumeCache.get(keyId);
		if (
			!entry ||
			now.getTime() - entry.fetchedAt > VOLUME_TTL_MS ||
			entry.dayBucket !== day ||
			entry.monthBucket !== month
		) {
			// One read: the key's caps + both counters in a single joined query.
			const row = await getKeyCapsWithUsage(env.DB, keyId, day, month);
			entry = {
				hasRow: !!row,
				dailyCap: row?.daily_cap ?? FREE_VOLUME.daily,
				monthlyCap: row?.monthly_cap ?? FREE_VOLUME.monthly,
				dayCount: row?.day_count ?? 0,
				monthCount: row?.month_count ?? 0,
				dayBucket: day,
				monthBucket: month,
				fetchedAt: now.getTime(),
			};
			volumeCache.set(keyId, entry);
			if (volumeCache.size > 10000) {
				for (const [k, v] of volumeCache) {
					if (now.getTime() - v.fetchedAt > VOLUME_TTL_MS) volumeCache.delete(k);
				}
			}
		}

		// No api_keys row (env-configured demo key): nothing to cap, nothing to count.
		if (!entry.hasRow) return { deny: null };

		// Same object reference as `entry`, so it reflects the ++ increments below.
		const e = entry;
		const usage = (): { day: VolumeUsage; month: VolumeUsage } => ({
			day: { limit: e.dailyCap, remaining: Math.max(0, e.dailyCap - e.dayCount) },
			month: { limit: e.monthlyCap, remaining: Math.max(0, e.monthlyCap - e.monthCount) },
		});

		// Enforce BEFORE counting - a capped request must not consume quota.
		if (entry.dayCount >= entry.dailyCap) {
			return {
				deny: {
					retryAfter: secondsUntilUtcMidnight(now),
					reason: `Daily cap reached (${entry.dailyCap}/day). Resets at 00:00 UTC.`,
				},
				...usage(),
			};
		}
		if (entry.monthCount >= entry.monthlyCap) {
			return {
				deny: {
					retryAfter: secondsUntilNextUtcMonth(now),
					reason: `Monthly cap reached (${entry.monthlyCap}/month). Stake more MOR to raise it - see /stake.`,
				},
				...usage(),
			};
		}

		// Count: one batched UPSERT for both buckets.
		await incrementUsageCounters(env.DB, keyId, day, month);
		entry.dayCount++;
		entry.monthCount++;
		return { deny: null, ...usage() };
	} catch (e) {
		console.error("[volume-caps] check failed, allowing request:", e);
		return { deny: null };
	}
}

export interface RateLimitInfo {
	perMinLimit: number;
	// Best-effort: exact per-minute remaining is only known on the in-memory
	// fallback path (the CF rate-limit binding does not expose a remaining count),
	// so it is omitted on the binding path. Limit + Reset are always known; the
	// day/month remaining values are the precise, client-actionable ones.
	perMinRemaining?: number;
	resetSeconds: number;
	day?: VolumeUsage;
	month?: VolumeUsage;
}

function buildLimits(
	auth: AuthResult | undefined,
	cap: { day?: VolumeUsage; month?: VolumeUsage },
	perMinRemaining?: number,
): RateLimitInfo {
	const info: RateLimitInfo = {
		perMinLimit: auth?.rateLimit || 100,
		resetSeconds: 60 - (Math.floor(Date.now() / 1000) % 60),
	};
	if (perMinRemaining !== undefined) info.perMinRemaining = perMinRemaining;
	if (cap.day) info.day = cap.day;
	if (cap.month) info.month = cap.month;
	return info;
}

/**
 * Serialize a RateLimitInfo into standard X-RateLimit-* headers. Shared by the
 * metered-success merge (api.ts) and the 429 response so both stay in sync.
 */
export function rateLimitHeaders(limits: RateLimitInfo): Record<string, string> {
	const h: Record<string, string> = {
		"X-RateLimit-Limit": String(limits.perMinLimit),
		"X-RateLimit-Reset": String(limits.resetSeconds),
	};
	if (limits.perMinRemaining !== undefined)
		h["X-RateLimit-Remaining"] = String(limits.perMinRemaining);
	if (limits.day) {
		h["X-RateLimit-Limit-Day"] = String(limits.day.limit);
		h["X-RateLimit-Remaining-Day"] = String(limits.day.remaining);
	}
	if (limits.month) {
		h["X-RateLimit-Limit-Month"] = String(limits.month.limit);
		h["X-RateLimit-Remaining-Month"] = String(limits.month.remaining);
	}
	return h;
}

export async function checkRateLimit(
	request: Request,
	env: Env,
	auth?: AuthResult,
	ipLimit = 100,
): Promise<{
	allowed: boolean;
	retryAfter?: number;
	reason?: string;
	limits?: RateLimitInfo;
}> {
	// Durable enforcement via Workers rate-limiting bindings when configured
	// ([[ratelimits]] in wrangler.toml, wrangler >= 4.36). The in-memory path
	// below is per-isolate best-effort and remains as the unconfigured fallback.
	// Only true admin identities skip the per-IP layer. The UI serving key
	// (keyId 'demo') keeps its huge per-key aggregate - the whole site's page
	// scripts share it - but each client IP still rides the standard per-IP
	// budget, so scraping window.MORSCAN_API_KEY buys nothing beyond what a
	// browser session already gets.
	const isAdmin = auth ? isAdminAuth(auth, env) : false;
	// Keys whose per-key limit can't be expressed by the fixed binding pools
	// (serving key at 1M/min) skip the per-key *binding* check only - the
	// per-IP layer still applies unless the key is a true admin key.
	const highLimit = !!auth?.rateLimit && auth.rateLimit >= 10000;
	if (env.RL_STANDARD) {
		const ip = request.headers.get("CF-Connecting-IP") || "unknown";
		if (!isAdmin) {
			const ipRes = await env.RL_STANDARD.limit({ key: `ip:${ip}` });
			if (!ipRes.success)
				return {
					allowed: false,
					retryAfter: 60,
					reason: `IP rate limit exceeded (${ipLimit}/min)`,
				};
		}
		if (auth?.keyId && !isAdmin && !highLimit) {
			const keyLimit = auth.rateLimit || 100;
			// Pool by tier: 10/min (legacy throttled keys), 30/min (low keys),
			// 60/min (connected wallet, unstaked), else the standard 100/min pool.
			const binding =
				keyLimit <= 10 && env.RL_LOW
					? env.RL_LOW
					: keyLimit <= 30 && env.RL_STRICT
						? env.RL_STRICT
						: keyLimit <= 60 && env.RL_MED
							? env.RL_MED
							: env.RL_STANDARD;
			const keyRes = await binding.limit({ key: `key:${auth.keyId}` });
			if (!keyRes.success)
				return {
					allowed: false,
					retryAfter: 60,
					reason: `Key rate limit exceeded (${keyLimit}/min)`,
				};
		}
		// Minute burst allowed - now the day/month volume caps (all keyed
		// consumers including playground, personal, and staked keys; `admin`
		// and row-less env keys are exempt inside).
		if (auth?.keyId) {
			const capCheck = await checkVolumeCaps(env, auth.keyId);
			// The CF rate-limit binding enforces the per-minute burst but does not
			// expose a remaining count. So a client (and the API playground) can still
			// watch its budget tick down, keep a best-effort per-isolate minute counter
			// alongside the binding purely for the X-RateLimit-Remaining header. It is
			// per-isolate (not global) and advisory only - the binding above is the
			// real gate - but for a single caller it decrements 10 -> 9 -> 8 as expected.
			const minute = Math.floor(Date.now() / 60000);
			const keyLimit = auth.rateLimit || 100;
			const used = highLimit ? 0 : incrementCounter(`key:${auth.keyId}`, minute);
			const perMinRemaining = highLimit ? undefined : Math.max(0, keyLimit - used);
			const limits = buildLimits(auth, capCheck, perMinRemaining);
			if (capCheck.deny)
				return {
					allowed: false,
					retryAfter: capCheck.deny.retryAfter,
					reason: capCheck.deny.reason,
					limits,
				};
			return { allowed: true, limits };
		}
		return { allowed: true };
	}

	const ip = request.headers.get("CF-Connecting-IP") || "unknown";
	const minute = Math.floor(Date.now() / 60000);

	// Layer 1: Per-IP (100/min) - only true admin keys skip it
	if (!isAdmin) {
		if (getCount(`ip:${ip}`, minute) >= ipLimit) {
			const secondsUntilReset = 60 - (Math.floor(Date.now() / 1000) % 60);
			return {
				allowed: false,
				retryAfter: secondsUntilReset,
				reason: `IP rate limit exceeded (${ipLimit}/min)`,
			};
		}
	}

	// Layer 2: Per-key (if auth provided). This fallback path DOES know the exact
	// per-minute count, so it can supply X-RateLimit-Remaining precisely.
	let perMinRemaining: number | undefined;
	if (auth?.keyId) {
		const keyLimit = auth.rateLimit || 100;
		const cur = getCount(`key:${auth.keyId}`, minute);
		if (cur >= keyLimit) {
			const secondsUntilReset = 60 - (Math.floor(Date.now() / 1000) % 60);
			return {
				allowed: false,
				retryAfter: secondsUntilReset,
				reason: `Key rate limit exceeded (${keyLimit}/min)`,
				limits: buildLimits(auth, {}, 0),
			};
		}
		incrementCounter(`key:${auth.keyId}`, minute);
		perMinRemaining = Math.max(0, keyLimit - (cur + 1));
	}

	// Increment per-IP counter (only admin keys are exempt)
	if (!isAdmin) {
		incrementCounter(`ip:${ip}`, minute);
	}

	// Layer 3: day/month volume caps (same rules as the binding path above).
	if (auth?.keyId) {
		const capCheck = await checkVolumeCaps(env, auth.keyId);
		const limits = buildLimits(auth, capCheck, perMinRemaining);
		if (capCheck.deny)
			return {
				allowed: false,
				retryAfter: capCheck.deny.retryAfter,
				reason: capCheck.deny.reason,
				limits,
			};
		return { allowed: true, limits };
	}

	return { allowed: true };
}

/**
 * Per-IP-only rate limit for FREE introspection endpoints (capacity/price/health).
 * Checking your remaining capacity must never cost capacity, so these are NOT
 * key-metered: no per-key binding, no day/month usage_counters. A generous per-IP
 * budget (default 60/min) still fences off abuse. Reuses the same per-IP layer as
 * the metered path (durable RL_STANDARD binding, in-memory fallback). Admin keys
 * skip it entirely.
 */
export async function checkIpRateLimit(
	request: Request,
	env: Env,
	auth?: AuthResult,
	ipLimit = 60,
): Promise<{ allowed: boolean; retryAfter?: number; reason?: string }> {
	if (auth && isAdminAuth(auth, env)) return { allowed: true };
	const ip = request.headers.get("CF-Connecting-IP") || "unknown";
	if (env.RL_STANDARD) {
		const ipRes = await env.RL_STANDARD.limit({ key: `ip:${ip}` });
		if (!ipRes.success)
			return {
				allowed: false,
				retryAfter: 60,
				reason: `IP rate limit exceeded (${ipLimit}/min)`,
			};
		return { allowed: true };
	}
	const minute = Math.floor(Date.now() / 60000);
	if (getCount(`ip:${ip}`, minute) >= ipLimit) {
		const secondsUntilReset = 60 - (Math.floor(Date.now() / 1000) % 60);
		return {
			allowed: false,
			retryAfter: secondsUntilReset,
			reason: `IP rate limit exceeded (${ipLimit}/min)`,
		};
	}
	incrementCounter(`ip:${ip}`, minute);
	return { allowed: true };
}

/**
 * Return 429 Too Many Requests response
 */
export function rateLimitResponse(
	retryAfter: number,
	reason?: string,
	limits?: RateLimitInfo,
): Response {
	return new Response(
		JSON.stringify({
			error: reason || "Rate limit exceeded",
			retryAfter,
			retry_after: retryAfter,
			docs_url: `${baseUrl()}/stake`,
		}),
		{
			status: 429,
			headers: {
				...HEADERS,
				"Retry-After": String(retryAfter),
				...(limits ? rateLimitHeaders(limits) : {}),
			},
		},
	);
}
