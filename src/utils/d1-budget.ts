/**
 * D1 rows-read budget backstop (Cloudflare Free plan).
 *
 * The operator runs on the Free plan, whose hard ceiling is ~5,000,000 D1
 * rows-read per UTC day. If a flood pounds the heavy UNCACHED endpoints it could
 * silently blow that quota mid-day and take the whole site down at some random
 * hour. This guard tracks an APPROXIMATE running total of rows read for the
 * current UTC day and, once the day is at a configurable budget
 * (`D1_DAILY_READ_BUDGET`, default 4,000,000 to leave headroom), lets callers
 * shed load gracefully - the caller returns a 503 with `Retry-After` on the
 * expensive uncached paths instead of hard-crashing the free quota.
 *
 * ## Why approximate, not exact
 *
 * D1 returns `meta.rows_read` per query, but threading that through every handler
 * is invasive. Instead we account a CONSERVATIVE per-endpoint-class ESTIMATE
 * (`heavyUncachedEstimate`) for the heavy uncached endpoints only. The cached
 * endpoints (ui-init / all / analytics / holders / ...) already collapse the bulk
 * of reads behind KV / the CF Cache API, so they are not the risk this guard
 * covers and are intentionally neither gated nor counted here. Estimates
 * over-count rather than under-count, so the guard trips EARLY and sheds before
 * the real free quota is exhausted. Threading exact `rows_read` is a future
 * refinement; the coarse estimate is enough for a load-shed backstop.
 *
 * ## Sharing across isolates
 *
 * The day total is aggregated in KV (`MORSCAN_CACHE`, key `d1reads:<UTC-date>`).
 * Each isolate accumulates locally and flushes a coalesced delta at most once a
 * minute (or sooner once its local delta crosses a threshold), so the guard's own
 * KV writes stay modest. Reads of the shared total are cached in-isolate for
 * ~30s. The read-modify-write is not atomic across isolates, so the shared total
 * can drift slightly under concurrency - acceptable for a coarse backstop. Every
 * KV op is wrapped in try/catch: a KV failure (e.g. hitting the Free-plan KV
 * write cap during an extreme flood) is non-fatal and the guard simply rides the
 * per-isolate signal. It never throws into the request path.
 *
 * ## Reset
 *
 * The key is UTC-day scoped, so the budget resets automatically at 00:00 UTC.
 * Manual reset: delete the `d1reads:<UTC-date>` key from the `MORSCAN_CACHE` KV
 * namespace (e.g. `wrangler kv key delete --binding MORSCAN_CACHE d1reads:<date>`).
 */

import type { Env } from "../types";

const DEFAULT_BUDGET = 4_000_000; // stay under the ~5M/day Free-plan rows-read limit
const KV_REFRESH_MS = 30_000; // how long an isolate trusts its cached shared total
const KV_FLUSH_MS = 60_000; // min gap between this isolate's KV writes (coalesce)
const KV_FLUSH_ROWS = 20_000; // or flush sooner once the local delta crosses this

function utcDay(now = new Date()): string {
	const y = now.getUTCFullYear();
	const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	return `${y}-${mo}-${d}`;
}

function budgetOf(env: Env): number {
	const v = Number(env.D1_DAILY_READ_BUDGET);
	return Number.isFinite(v) && v > 0 ? v : DEFAULT_BUDGET;
}

// ─── Per-isolate day state ───
let _day = utcDay();
let _localTotal = 0; // rows this isolate has accounted today (running)
let _flushedAt = 0; // _localTotal value at the last successful KV flush
let _lastFlush = 0; // ts of the last flush attempt
let _globalTotal = 0; // last-known shared total from KV (excludes our unflushed delta)
let _globalAt = 0; // ts of the last KV read

function rollDayIfNeeded(): void {
	const d = utcDay();
	if (d !== _day) {
		_day = d;
		_localTotal = 0;
		_flushedAt = 0;
		_lastFlush = 0;
		_globalTotal = 0;
		_globalAt = 0;
	}
}

function kvKey(): string {
	return `d1reads:${_day}`;
}

async function refreshGlobal(env: Env): Promise<void> {
	const kv = env.MORSCAN_CACHE;
	if (!kv) return;
	if (Date.now() - _globalAt < KV_REFRESH_MS) return;
	try {
		const raw = await kv.get(kvKey());
		_globalTotal = raw ? Number(raw) || 0 : 0;
		_globalAt = Date.now();
	} catch {
		// non-fatal: keep the last-known value
	}
}

async function maybeFlush(env: Env): Promise<void> {
	const kv = env.MORSCAN_CACHE;
	if (!kv) return;
	const delta = _localTotal - _flushedAt;
	if (delta <= 0) return;
	const due = delta >= KV_FLUSH_ROWS || Date.now() - _lastFlush >= KV_FLUSH_MS;
	if (!due) return;
	_lastFlush = Date.now();
	try {
		const raw = await kv.get(kvKey());
		const cur = raw ? Number(raw) || 0 : 0;
		const next = cur + delta;
		// 2-day TTL so a key lingers past its day but never leaks forever.
		await kv.put(kvKey(), String(next), { expirationTtl: 172_800 });
		_flushedAt = _localTotal;
		_globalTotal = next;
		_globalAt = Date.now();
	} catch {
		// non-fatal: e.g. Free-plan KV write cap under an extreme flood. The guard
		// then rides the per-isolate signal only until the next successful flush.
	}
}

/** Best-known day total = shared KV total + this isolate's unflushed local delta. */
export function estimatedDayReads(): number {
	return _globalTotal + (_localTotal - _flushedAt);
}

/**
 * Account an estimate of rows read for the current UTC day, then schedule a
 * coalesced KV flush (off the hot path via `ctx.waitUntil` when available).
 */
export function noteRowsRead(
	env: Env,
	ctx: ExecutionContext | undefined,
	rows: number,
): void {
	rollDayIfNeeded();
	_localTotal += Math.max(0, Math.floor(rows) || 0);
	const p = maybeFlush(env);
	if (ctx?.waitUntil) ctx.waitUntil(p);
	else void p;
}

/** True when the current UTC day is at or over the configured rows-read budget. */
export async function isOverReadBudget(env: Env): Promise<boolean> {
	rollDayIfNeeded();
	await refreshGlobal(env);
	return estimatedDayReads() >= budgetOf(env);
}

/** The active budget (for logging / diagnostics). */
export function readBudget(env: Env): number {
	return budgetOf(env);
}

/** Seconds until the next UTC midnight (a sensible `Retry-After` when shedding). */
export function secondsToUtcMidnight(now = new Date()): number {
	const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Conservative per-endpoint-class rows-read estimate for the heavy UNCACHED
 * endpoints. Returns 0 for everything else (not guarded, not counted). These are
 * deliberate over-estimates so the guard trips before the real quota does; see
 * the module header for why they are approximate.
 */
export function heavyUncachedEstimate(path: string): number {
	// /mor/v1/sessions is KV-cached (30s, per query shape) in the router, so it is
	// no longer an uncached read driver and is not guarded here.
	if (path === "/mor/v1/sessions/analytics") return 200_000; // multi-scan session aggregate (uncached)
	if (path === "/mor/v1/provenance") return 20_000; // receipt/chain history scan
	if (/^\/mor\/v1\/sessions\/0x[0-9a-fA-F]{40}$/.test(path)) return 5_000; // per-wallet sessions
	if (/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}\/(transactions|gas)$/.test(path))
		return 5_000;
	return 0;
}
