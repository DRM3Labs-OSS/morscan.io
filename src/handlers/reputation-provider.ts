/**
 * Provider Reputation - per-provider detail (/mor/v1/reputation/:provider).
 */

import type { Env } from "../types";
import { getSyncState, buildMeta } from "../utils/rpc";
import type { ProviderReputationRow } from "./reputation-types";
import { getProviderBids, getModelNamesByIds } from "../db/explorer-market";
import {
	getProviderModelStats,
	getProviderRecentSessions50,
} from "../db/explorer-sessions";

export async function handleProviderReputation(
	env: Env,
	provider: string,
): Promise<Response> {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);
	const providerLower = provider.toLowerCase();

	const statsRows = await getProviderModelStats(env.DB, providerLower);

	const bidRows = await getProviderBids(env.DB, providerLower);

	const modelIds = [
		...new Set(statsRows.map((r: Record<string, unknown>) => r.model_id as string)),
	];
	const modelNames = new Map<string, string>();
	if (modelIds.length > 0) {
		const modelRows = await getModelNamesByIds(env.DB, modelIds);
		for (const row of modelRows) {
			modelNames.set(row.model_id.toLowerCase(), row.name);
		}
	}

	const recentSessions = await getProviderRecentSessions50(env.DB, providerLower);

	const modelStats = (statsRows as unknown as ProviderReputationRow[]).map((row) => ({
		modelId: row.model_id,
		modelName:
			modelNames.get(row.model_id.toLowerCase()) || `${row.model_id.slice(0, 10)}...`,
		successCount: row.success_count || 0,
		disputeCount: row.dispute_count || 0,
		earlyTerminationCount: row.early_termination_count || 0,
		totalSessions: row.total_sessions || 0,
		avgTps: row.tps_scaled ? row.tps_scaled / 1000 : 0,
		avgTtftMs: row.ttft_ms || 0,
	}));

	const totalSessions = modelStats.reduce((sum, m) => sum + m.totalSessions, 0);
	const totalSuccess = modelStats.reduce((sum, m) => sum + m.successCount, 0);
	const totalDisputes = modelStats.reduce((sum, m) => sum + m.disputeCount, 0);
	const totalEarly = modelStats.reduce((sum, m) => sum + m.earlyTerminationCount, 0);

	return new Response(
		JSON.stringify({
			provider,
			successCount: totalSuccess,
			disputeCount: totalDisputes,
			earlyTerminationCount: totalEarly,
			totalSessions,
			activeBids: bidRows.filter((b: Record<string, unknown>) => b.deleted_at === 0)
				.length,
			retractedBids: bidRows.filter(
				(b: Record<string, unknown>) => (b.deleted_at as number) > 0,
			).length,
			modelStats,
			recentSessions: recentSessions.map((s: Record<string, unknown>) => ({
				id: s.id,
				user: s.user_address,
				modelId: s.model_id,
				modelName:
					modelNames.get((s.model_id as string)?.toLowerCase()) ||
					`${(s.model_id as string)?.slice(0, 10)}...`,
				stake: s.stake,
				openedAt: s.opened_at,
				endsAt: s.ends_at,
				closedAt: s.closed_at,
				closeoutType: s.closeout_type === 1 ? "dispute" : "normal",
				providerWithdrawn: s.provider_withdrawn,
				isActive: s.is_active === 1,
				isEarlyTermination:
					(s.closed_at as number) > 0 && (s.closed_at as number) < (s.ends_at as number),
			})),
			bids: bidRows.map((b: Record<string, unknown>) => ({
				bidId: b.bid_id,
				modelId: b.model_id,
				modelName:
					modelNames.get((b.model_id as string)?.toLowerCase()) ||
					`${(b.model_id as string)?.slice(0, 10)}...`,
				pricePerSecond: b.price_per_second,
				createdAt: b.created_at,
				isRetracted: (b.deleted_at as number) > 0,
				retractedAt: (b.deleted_at as number) > 0 ? b.deleted_at : null,
			})),
			...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		}),
		{
			headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		},
	);
}
