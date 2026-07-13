/**
 * Analytics Handler - Gas costs, session duration, network economics
 *
 * Fetches tx receipts for session operations, caches gas data,
 * and serves aggregated analytics for consumers and providers.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { signResponse } from "../utils/provenance";
import {
	countPendingGasReceipts,
	selectClosedSessionStats,
	selectGasStatsByOperation,
} from "../db/explorer-core";

// Gas backfill + per-wallet gas estimation live in analytics-gas.ts; re-exported
// here so existing imports (`from '../handlers/analytics'`) keep working.
export { backfillTxHashes, handleWalletGas } from "./analytics-gas";

export async function handleAnalytics(
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	// Gas backfill removed from API path - was causing 10-12s responses when pending receipts existed.
	// Backfill now only runs via /sync/backfill-tx (admin endpoint) or can be added to cron.

	// Aggregate gas costs
	const [gasStats, durationStats, pendingCount] = await Promise.all([
		selectGasStatsByOperation(env.DB),

		// Session duration analytics (last 1000 closed sessions)
		selectClosedSessionStats(env.DB),

		// Count pending receipts (for reporting, not backfilling)
		countPendingGasReceipts(env.DB),
	]);

	// Per-operation gas breakdown
	const gasByOp: Record<
		string,
		{
			count: number;
			avgEth: number;
			minEth: number;
			maxEth: number;
			totalEth: number;
			avgGasUsed: number;
		}
	> = {};
	for (const row of gasStats) {
		gasByOp[row.operation] = {
			count: row.count,
			avgEth: parseFloat(row.avg_eth?.toFixed(8) || "0"),
			minEth: parseFloat(row.min_eth?.toFixed(8) || "0"),
			maxEth: parseFloat(row.max_eth?.toFixed(8) || "0"),
			totalEth: parseFloat(row.total_eth?.toFixed(6) || "0"),
			avgGasUsed: Math.round(row.avg_gas_used || 0),
		};
	}

	// Total gas per session lifecycle (open + close)
	const openAvg = gasByOp.open?.avgEth || 0;
	const closeAvg = gasByOp.close?.avgEth || 0;
	const lifecycleAvgEth = openAvg + closeAvg;

	const earlyRate =
		durationStats?.total_closed && durationStats.total_closed > 0
			? (
					((durationStats.early_terminations || 0) / durationStats.total_closed) *
					100
				).toFixed(1)
			: "0";
	const disputeRate =
		durationStats?.total_closed && durationStats.total_closed > 0
			? (((durationStats.disputes || 0) / durationStats.total_closed) * 100).toFixed(1)
			: "0";

	const responseData: Record<string, unknown> = {
		gas: {
			perOperation: gasByOp,
			perSessionLifecycle: {
				avgEth: parseFloat(lifecycleAvgEth.toFixed(8)),
				description: "Average ETH cost to open + close one session",
			},
			totalReceipts: gasStats.reduce((s, r) => s + r.count, 0),
			pendingReceipts: pendingCount?.cnt || 0,
		},
		sessions: {
			totalClosed: durationStats?.total_closed || 0,
			avgDurationMins: durationStats?.avg_duration_secs
				? Math.round(durationStats.avg_duration_secs / 60)
				: 0,
			avgExpectedDurationMins: durationStats?.avg_expected_duration_secs
				? Math.round(durationStats.avg_expected_duration_secs / 60)
				: 0,
			earlyTerminations: durationStats?.early_terminations || 0,
			earlyTerminationRate: parseFloat(earlyRate),
			disputes: durationStats?.disputes || 0,
			disputeRate: parseFloat(disputeRate),
			avgFullDurationMins: durationStats?.avg_full_duration_secs
				? Math.round(durationStats.avg_full_duration_secs / 60)
				: 0,
			avgEarlyDurationMins: durationStats?.avg_early_duration_secs
				? Math.round(durationStats.avg_early_duration_secs / 60)
				: 0,
		},
		stakes: {
			avgMor: parseFloat(((durationStats?.avg_stake_mor || 0) / 1e18).toFixed(2)),
			minMor: parseFloat(((durationStats?.min_stake_mor || 0) / 1e18).toFixed(4)),
			maxMor: parseFloat(((durationStats?.max_stake_mor || 0) / 1e18).toFixed(2)),
		},
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const aggregateReceipt = await signResponse(
			"blockchain.analytics",
			{ endpoint: "/mor/v1/analytics" },
			{
				totalClosedSessions: durationStats?.total_closed || 0,
				totalGasReceipts: gasStats.reduce((s, r) => s + r.count, 0),
				lifecycleAvgEth: parseFloat(lifecycleAvgEth.toFixed(8)),
			},
			mnemonic,
			env.DB,
			responseData,
		);
		if (aggregateReceipt) {
			responseData._provenance_aggregate = JSON.parse(aggregateReceipt);
		}
	}

	return new Response(JSON.stringify(responseData), { headers });
}
