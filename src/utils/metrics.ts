/**
 * Canonical network metrics - the ONE definition of each headline number.
 *
 * Every surface (/teaser, /health, the analytics header, console + landing
 * widgets) must read these from here so identical labels always return
 * identical numbers. This is the metric-consistency law made concrete.
 *
 * Definitions (deliberate, honest):
 *   providers      - every registered provider row.
 *   bids           - live (non-retracted) bids only: deleted_at is 0/NULL.
 *   activeSessions - sessions that are BOTH flagged active AND not past their
 *                    on-chain end time. A session whose ends_at has passed is
 *                    no longer "active" even if the is_active flag lags.
 *   totalSessions  - every session ever seen (cumulative).
 *   morStaked      - MOR currently locked in active sessions, plus stake that
 *                    is claimable (expired but not yet closed out).
 */

import {
	countActiveSessions,
	countAllSessions,
	countLiveBids,
	countProviders,
	sumActiveSessionStake,
	sumClaimableSessionStake,
} from "../db/ops";
import type { Env } from "../types";

export interface NetworkMetrics {
	providers: number;
	bids: number;
	activeSessions: number;
	totalSessions: number;
	morStaked: number;
}

// Canonical metrics are read on the hottest paths (/health on every monitor +
// sync-bar poll, /teaser on every landing, and every server-rendered UI page
// header via getStatBarData). Computing them means a full COUNT(*) scan of the
// ~113k-row sessions table each time (4 session scans + providers + bids),
// which is the single largest driver of D1 rows-read.
//
// PRECOMPUTE MODEL: the big scans now run in EXACTLY one place - the per-minute
// cron (refreshNetworkMetrics, called from src/index.ts scheduled handler) - and
// store the result in a small KV summary. The request path (getNetworkMetrics)
// only READS that summary (one tiny KV get, zero D1 rows). This kills the
// per-request sessions scan and the cache-miss stampede where every colo's
// concurrent readers each recomputed when the old 20s TTL lapsed.
//
// A few seconds/minute of staleness is fine and expected. The numbers stay
// canonical (computeNetworkMetrics is unchanged) - this only changes how often
// the same query runs. On a cold summary (fresh deploy before the first cron
// tick, or a multi-minute cron outage) the request path computes ONCE and
// repopulates so the next reader is served from the summary again.
const METRICS_CACHE_KEY = "metrics:network";
// How stale a summary the request path will still serve before falling back to
// a live compute. The cron refreshes every 60s, so 5 min absorbs a few missed
// ticks and still never scans sessions on the request path in steady state.
const METRICS_MAX_AGE_MS = 5 * 60_000;

interface MetricsCacheEntry {
	cachedAt: number;
	metrics: NetworkMetrics;
}

/**
 * HOT PATH read. Returns the precomputed canonical metrics from the KV summary
 * without touching D1. Only if the summary is missing or older than
 * METRICS_MAX_AGE_MS (cold start / cron outage) does it compute once and
 * repopulate - steady state is a pure summary read.
 */
export async function getNetworkMetrics(env: Env): Promise<NetworkMetrics> {
	const kv = env.MORSCAN_CACHE;
	if (kv) {
		try {
			const raw = await kv.get(METRICS_CACHE_KEY);
			if (raw !== null) {
				const entry: MetricsCacheEntry = JSON.parse(raw);
				if (Date.now() - entry.cachedAt < METRICS_MAX_AGE_MS) return entry.metrics;
			}
		} catch (_e) {
			// Corrupted/missing entry - fall through to a fresh compute.
		}
	}

	// Cold start / stale summary: compute once and repopulate so subsequent
	// readers hit the summary. Steady-state refresh is owned by the cron.
	return refreshNetworkMetrics(env);
}

/**
 * CRON PATH write. Runs the expensive session scans, computes the canonical
 * metrics, and stores them in the shared KV summary. This is the ONLY place the
 * big scans run in steady state. Called once per minute from the scheduled
 * handler; also used as the request-path cold-start fallback above.
 */
export async function refreshNetworkMetrics(env: Env): Promise<NetworkMetrics> {
	const metrics = await computeNetworkMetrics(env);

	const kv = env.MORSCAN_CACHE;
	if (kv) {
		try {
			const entry: MetricsCacheEntry = { cachedAt: Date.now(), metrics };
			// Keep the entry well beyond METRICS_MAX_AGE_MS so a brief cron outage
			// still serves a (slightly stale) summary rather than forcing the request
			// path to scan. If the cron is dead longer than this, KV expires and the
			// request path recomputes once + repopulates - self-healing.
			await kv.put(METRICS_CACHE_KEY, JSON.stringify(entry), { expirationTtl: 600 });
		} catch (_e) {
			// KV write failures are non-fatal.
		}
	}

	return metrics;
}

async function computeNetworkMetrics(env: Env): Promise<NetworkMetrics> {
	const nowTs = Math.floor(Date.now() / 1000);
	const [providers, bids, activeSessions, totalSessions, activeStake, claimableStake] =
		await Promise.all([
			countProviders(env.DB),
			countLiveBids(env.DB),
			countActiveSessions(env.DB, nowTs),
			countAllSessions(env.DB),
			sumActiveSessionStake(env.DB, nowTs),
			sumClaimableSessionStake(env.DB, nowTs),
		]);
	return {
		providers: providers?.cnt || 0,
		bids: bids?.cnt || 0,
		activeSessions: activeSessions?.cnt || 0,
		totalSessions: totalSessions?.cnt || 0,
		morStaked: Math.floor((activeStake?.total || 0) + (claimableStake?.total || 0)),
	};
}
