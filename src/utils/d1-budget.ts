/**
 * D1 rows-read budget backstop, by caller class.
 *
 * On the Free plan the hard ceiling is ~5,000,000 D1 rows-read per UTC day; on
 * any plan the one database is shared by the sync and every page. If a flood
 * pounds the heavy UNCACHED endpoints it could blow that quota or saturate the
 * database mid-day. This guard tracks an estimated running total of rows read for the
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
 * ## By caller class (src/utils/caller-class.ts)
 *
 * Each class has its OWN day budget: `free` (the public serving key, wallet
 * signatures, bottom-tier keys) gets `D1_FREE_READ_BUDGET` (default half of
 * the daily budget), `paid` (packs, x402, staked keys) gets
 * `D1_DAILY_READ_BUDGET`. Free traffic can only exhaust the free budget, so
 * it can never shed a paying caller. Admin is never counted or shed. The
 * caller (routes/api.ts) takes the budget BEFORE a pack debit or an x402
 * settlement, so a shed call is never charged.
 *
 * ## Counting
 *
 * With the CallMeter object bound (src/durable/CallMeter.ts) each class's day
 * total is one exact counter: a take that does not fit is refused and not
 * counted. Without it, or when it does not answer, the per-class KV estimate
 * below is used.
 *
 * ## Sharing across isolates (the KV fallback)
 *
 * The day total is aggregated in KV (`MORSCAN_CACHE`, key
 * `d1reads:<class>:<UTC-date>`).
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
 * With the KV fallback, a manual reset is deleting the `d1reads:<class>:<UTC-date>`
 * key from the `MORSCAN_CACHE` KV namespace.
 */

import type { Env } from "../types";
import { meterTake } from "./call-meter";

export type BudgetClass = "free" | "paid";

const DEFAULT_BUDGET = 4_000_000;
const KV_REFRESH_MS = 30_000; // how long an isolate trusts its cached shared total
const KV_FLUSH_MS = 60_000; // min gap between this isolate's KV writes (coalesce)
const KV_FLUSH_ROWS = 20_000; // or flush sooner once the local delta crosses this

function utcDay(now = new Date()): string {
	const y = now.getUTCFullYear();
	const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	return `${y}-${mo}-${d}`;
}

function positive(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function budgetOf(env: Env, cls: BudgetClass): number {
	const total = positive(env.D1_DAILY_READ_BUDGET) ?? DEFAULT_BUDGET;
	if (cls === "paid") return total;
	return positive(env.D1_FREE_READ_BUDGET) ?? Math.floor(total / 2);
}

// ─── Per-isolate day state for the KV fallback, one per class ───
interface DayState {
	day: string;
	localTotal: number; // rows this isolate has accounted today (running)
	flushedAt: number; // localTotal value at the last successful KV flush
	lastFlush: number; // ts of the last flush attempt
	globalTotal: number; // last-known shared total from KV (excludes our unflushed delta)
	globalAt: number; // ts of the last KV read
}

const states = new Map<BudgetClass, DayState>();

function stateOf(cls: BudgetClass): DayState {
	const d = utcDay();
	let st = states.get(cls);
	if (!st || st.day !== d) {
		st = {
			day: d,
			localTotal: 0,
			flushedAt: 0,
			lastFlush: 0,
			globalTotal: 0,
			globalAt: 0,
		};
		states.set(cls, st);
	}
	return st;
}

function kvKey(cls: BudgetClass, st: DayState): string {
	return `d1reads:${cls}:${st.day}`;
}

async function refreshGlobal(env: Env, cls: BudgetClass, st: DayState): Promise<void> {
	const kv = env.MORSCAN_CACHE;
	if (!kv) return;
	if (Date.now() - st.globalAt < KV_REFRESH_MS) return;
	try {
		const raw = await kv.get(kvKey(cls, st));
		st.globalTotal = raw ? Number(raw) || 0 : 0;
		st.globalAt = Date.now();
	} catch {
		// non-fatal: keep the last-known value
	}
}

async function maybeFlush(env: Env, cls: BudgetClass, st: DayState): Promise<void> {
	const kv = env.MORSCAN_CACHE;
	if (!kv) return;
	const delta = st.localTotal - st.flushedAt;
	if (delta <= 0) return;
	const due = delta >= KV_FLUSH_ROWS || Date.now() - st.lastFlush >= KV_FLUSH_MS;
	if (!due) return;
	st.lastFlush = Date.now();
	try {
		const raw = await kv.get(kvKey(cls, st));
		const cur = raw ? Number(raw) || 0 : 0;
		const next = cur + delta;
		// 2-day TTL so a key lingers past its day but never leaks forever.
		await kv.put(kvKey(cls, st), String(next), { expirationTtl: 172_800 });
		st.flushedAt = st.localTotal;
		st.globalTotal = next;
		st.globalAt = Date.now();
	} catch {
		// non-fatal: the guard rides the per-isolate signal until the next flush.
	}
}

/** KV fallback: best-known day total = shared KV total + this isolate's unflushed delta. */
export function estimatedDayReads(cls: BudgetClass = "free"): number {
	const st = stateOf(cls);
	return st.globalTotal + (st.localTotal - st.flushedAt);
}

/** KV fallback: account an estimate of rows read for the class's UTC day. */
export function noteRowsRead(
	env: Env,
	ctx: ExecutionContext | undefined,
	rows: number,
	cls: BudgetClass = "free",
): void {
	const st = stateOf(cls);
	st.localTotal += Math.max(0, Math.floor(rows) || 0);
	const p = maybeFlush(env, cls, st);
	if (ctx?.waitUntil) ctx.waitUntil(p);
	else void p;
}

/** KV fallback: true when the class's UTC day is at or over its budget. */
export async function isOverReadBudget(
	env: Env,
	cls: BudgetClass = "free",
): Promise<boolean> {
	const st = stateOf(cls);
	await refreshGlobal(env, cls, st);
	return estimatedDayReads(cls) >= budgetOf(env, cls);
}

/**
 * Take `rows` from the class's day budget before a guarded read. True: go
 * ahead (the rows are counted). False: shed. Exact with the CallMeter bound;
 * the KV estimate otherwise. Fails OPEN either way.
 */
export async function takeReadBudget(
	env: Env,
	ctx: ExecutionContext | undefined,
	cls: BudgetClass,
	rows: number,
): Promise<boolean> {
	const n = Math.max(1, Math.floor(rows) || 1);
	const v = await meterTake(env, `d1reads:${cls}`, [[budgetOf(env, cls), 86400]], { n });
	if (v) return v.ok;
	if (await isOverReadBudget(env, cls)) return false;
	noteRowsRead(env, ctx, n, cls);
	return true;
}

/** The active budget of a class (for logging / diagnostics). */
export function readBudget(env: Env, cls: BudgetClass = "free"): number {
	return budgetOf(env, cls);
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
	// /mor/v1/sessions (30s, per parsed page shape) and /mor/v1/sessions/analytics
	// (300s, one global key over the small precomputed wallet_stats table) are
	// KV-cached in the router, so they are not uncached read drivers and are not
	// guarded here.
	if (path === "/mor/v1/provenance") return 20_000; // receipt/chain history scan
	if (/^\/mor\/v1\/sessions\/0x[0-9a-fA-F]{40}$/.test(path)) return 5_000; // per-wallet sessions
	if (/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}\/(transactions|gas)$/.test(path))
		return 5_000;
	return 0;
}
