/**
 * Warehouse raw-dump: the Morpheus "sense organ" feed.
 *
 * Ships the SAME precomputed summaries the minute tick already builds (network
 * metrics KV, market-tape KV, fatboy modelDemand blob) to the raw dump table
 * (raw_morscan.rows) through the AnalyticsProvider seam - so the data lake can
 * distill day-grain Morpheus intelligence without ever touching this app's D1.
 *
 * Zero new D1 scans: everything here is a KV get or the one cached fatboy row.
 * Cadence is stamped in KV: a `network` snapshot at most every 15 minutes, one
 * `model` batch per UTC day. In the OSS standalone the reference provider has
 * no dump methods and this whole module is a no-op.
 */

import type { Env } from "../types";
import { getProviders } from "../providers";
import type { AnalyticsDumpInput } from "../providers/analytics";
import { getNetworkMetrics } from "../utils/metrics";
import { getTickerData } from "../ui/ticker";
import { selectFatboyCache } from "../db/explorer-core";

const NETWORK_STAMP_KEY = "whdump:network";
const MODELS_STAMP_KEY = "whdump:models";
const NETWORK_INTERVAL_MS = 15 * 60_000;

interface ModelDemandRow {
	modelId?: string;
	name?: string | null;
	totalSessions?: number;
	activeSessions?: number;
	sessions24h?: number;
	sessions7d?: number;
	uniqueUsers?: number;
}

/** Read-and-advance a KV stamp; returns true when due. Fail-open=false so a
 * KV hiccup skips a tick instead of double-writing forever. */
async function due(env: Env, key: string, minAgeMs: number): Promise<boolean> {
	const kv = env.MORSCAN_CACHE;
	if (!kv) return false;
	try {
		const raw = await kv.get(key);
		if (raw && Date.now() - Number(raw) < minAgeMs) return false;
		await kv.put(key, String(Date.now()), { expirationTtl: 7 * 86400 });
		return true;
	} catch {
		return false;
	}
}

/** Called from the minute tick (providers/compose.ts). Never throws. */
export async function dumpWarehousePulse(env: Env): Promise<void> {
	const analytics = getProviders().analytics;
	if (!analytics.dumpSafe || !analytics.dumpEnabled?.(env)) return;

	const inputs: AnalyticsDumpInput[] = [];
	const now = new Date();

	if (await due(env, NETWORK_STAMP_KEY, NETWORK_INTERVAL_MS)) {
		const [metrics, tape] = await Promise.all([
			getNetworkMetrics(env),
			getTickerData(env),
		]);
		inputs.push({
			kind: "network",
			id: "network",
			eventAt: now,
			payload: {
				providers: metrics.providers,
				bids: metrics.bids,
				active_sessions: metrics.activeSessions,
				total_sessions: metrics.totalSessions,
				mor_staked: metrics.morStaked,
				price_usd: tape.price?.usd ?? null,
				price_change_24h: tape.price?.change24h ?? null,
				models_live: tape.liveBids?.models ?? null,
				builder_tvl_mor: tape.builderTvlMor ?? null,
			},
		});
	}

	if (await due(env, MODELS_STAMP_KEY, 86_400_000 - 60_000)) {
		try {
			const cached = await selectFatboyCache(env.DB);
			const blob = cached?.value ? JSON.parse(cached.value) : null;
			const demand: ModelDemandRow[] = Array.isArray(blob?.modelDemand)
				? blob.modelDemand
				: [];
			for (const m of demand) {
				if (!m.modelId) continue;
				inputs.push({
					kind: "model",
					id: m.modelId,
					eventAt: now,
					payload: {
						model_id: m.modelId,
						name: m.name ?? null,
						total_sessions: m.totalSessions ?? 0,
						active_sessions: m.activeSessions ?? 0,
						sessions_24h: m.sessions24h ?? 0,
						sessions_7d: m.sessions7d ?? 0,
						unique_users: m.uniqueUsers ?? 0,
					},
				});
			}
		} catch (e) {
			console.error("[warehouse-dump] model batch skipped:", e);
		}
	}

	if (inputs.length > 0) await analytics.dumpSafe(env, inputs);
}
