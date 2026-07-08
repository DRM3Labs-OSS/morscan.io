/**
 * Provider Reputation API
 *
 * Exposes provider quality metrics:
 * - Success rate (non-dispute sessions)
 * - Dispute rate
 * - Early termination rate
 * - Aggregated stats from on-chain data
 */

import type { Env, ProviderReputation } from "../types";
import { getSyncState, buildMeta } from "../utils/rpc";
import type { ProviderReputationRow, ProviderBidRow } from "./reputation-types";
import { countBidsByProvider } from "../db/explorer-market";
import { getProviderStatsAggregated, getDisputedSessions } from "../db/explorer-sessions";

// Per-provider detail lives in reputation-provider.ts; re-exported here so
// existing imports (`from '../handlers/reputation'`) keep working.
export { handleProviderReputation } from "./reputation-provider";

/**
 * GET /mor/v1/reputation
 * Returns provider reputation scores for all providers
 */
export async function handleReputation(env: Env): Promise<Response> {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);

	// Get aggregated stats per provider
	const statsRows = await getProviderStatsAggregated(env.DB);

	// Get bid counts per provider
	const bidRows = await countBidsByProvider(env.DB);

	const bidMap = new Map<string, { active: number; retracted: number }>();
	for (const row of bidRows as unknown as ProviderBidRow[]) {
		bidMap.set(row.provider.toLowerCase(), {
			active: row.active_bids || 0,
			retracted: row.retracted_bids || 0,
		});
	}

	// Build reputation objects - raw data only, no computed scores
	const reputations: ProviderReputation[] = [];

	for (const row of statsRows as unknown as ProviderReputationRow[]) {
		const total = row.total_sessions || 0;
		if (total === 0) continue;

		const bids = bidMap.get(row.provider.toLowerCase()) || { active: 0, retracted: 0 };

		reputations.push({
			provider: row.provider,
			successCount: row.success_count || 0,
			disputeCount: row.dispute_count || 0,
			earlyTerminationCount: row.early_termination_count || 0,
			totalSessions: total,
			avgTps: row.tps_scaled ? row.tps_scaled / 1000 : 0,
			avgTtftMs: row.ttft_ms || 0,
			activeBids: bids.active,
			retractedBids: bids.retracted,
		});
	}

	// Sort by total sessions descending
	reputations.sort((a, b) => b.totalSessions - a.totalSessions);

	return new Response(
		JSON.stringify({
			providers: reputations,
			totalProviders: reputations.length,
			...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		}),
		{
			headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		},
	);
}
/**
 * GET /mor/v1/disputes
 * Returns recent disputed sessions
 */
export async function handleDisputes(env: Env): Promise<Response> {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);

	const disputes = await getDisputedSessions(env.DB);

	return new Response(
		JSON.stringify({
			disputes: disputes.map((d: Record<string, unknown>) => ({
				sessionId: d.id,
				user: d.user_address,
				provider: d.provider,
				modelId: d.model_id,
				modelName: d.model_name || `${(d.model_id as string)?.slice(0, 10)}...`,
				stake: d.stake,
				openedAt: d.opened_at,
				endsAt: d.ends_at,
				closedAt: d.closed_at,
				providerWithdrawn: d.provider_withdrawn,
				isEarlyTermination: (d.closed_at as number) < (d.ends_at as number),
			})),
			totalDisputes: disputes.length,
			...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		}),
		{
			headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		},
	);
}
