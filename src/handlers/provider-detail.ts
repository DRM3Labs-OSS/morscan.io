/**
 * Provider Detail & Model Demand Handlers
 *
 * Provider dashboard data and model demand heatmap for
 * the supply side of the marketplace.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { getSyncState, buildMeta } from "../utils/rpc";
import { signResponse } from "../utils/provenance";
import {
	getProviderByAddress,
	getProviderActiveBidsWithModels,
	getProviderRetractedBidsWithModels,
	getNetworkEconomics,
} from "../db/explorer-market";
import {
	getProviderStatsRows,
	getRecentProviderSessions,
	getProviderSessionSummary,
	getProviderBidSessionCounts,
} from "../db/explorer-sessions";

// Model demand + daily sessions live in provider-detail-demand.ts; re-exported
// here so existing imports (`from '../handlers/provider-detail'`) keep working.
export { handleModelDemand, handleDailySessions } from "./provider-detail-demand";

/**
 * GET /mor/v1/providers/:address
 * Full provider dashboard - bids, sessions, earnings estimate, reputation
 */
export async function handleProviderDetail(
	env: Env,
	address: string,
	headers: Record<string, string>,
) {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);
	const addr = address.toLowerCase();
	const now = Math.floor(Date.now() / 1000);

	const [
		provider,
		activeBids,
		retractedBids,
		reputationStats,
		recentSessions,
		sessionSummary,
		economicsRow,
		bidSessionCounts,
	] = await Promise.all([
		getProviderByAddress(env.DB, addr),
		getProviderActiveBidsWithModels(env.DB, addr),
		getProviderRetractedBidsWithModels(env.DB, addr),
		getProviderStatsRows(env.DB, addr),
		getRecentProviderSessions(env.DB, addr),
		getProviderSessionSummary(env.DB, now, addr),
		getNetworkEconomics(env.DB),
		// Per-bid active session counts
		getProviderBidSessionCounts(env.DB, addr),
	]);

	if (!provider) {
		return new Response(JSON.stringify({ error: "Provider not found" }), {
			status: 404,
			headers,
		});
	}

	// Parse economics for earnings estimate
	const stakingFactor =
		((economicsRow as Record<string, unknown>)?.staking_factor as number) || 0.00315;

	// Calculate earnings estimate from session data
	const totalStakeWei = Number(
		(sessionSummary as Record<string, unknown>)?.total_stake_wei || 0,
	);
	const totalSessions =
		((sessionSummary as Record<string, unknown>)?.total_sessions as number) || 0;
	const activeSessions =
		((sessionSummary as Record<string, unknown>)?.active_sessions as number) || 0;

	// Build per-bid session count lookup
	const bidSessions: Record<string, Record<string, unknown>> = {};
	for (const r of bidSessionCounts) bidSessions[r.bid_id as string] = r;

	// Format bids with pricing + session counts
	const bids = activeBids.map((b: Record<string, unknown>) => {
		const pricePerSec = BigInt((b.price_per_second as string) || "0");
		const pricePerDay = (Number(pricePerSec) * 86400) / 1e18;
		const pricePerWeek = pricePerDay * 7;
		const morPerHour = (Number(pricePerSec) * 3600) / 1e18;
		const hourlyStake =
			stakingFactor > 0 && morPerHour > 0 ? Math.ceil(morPerHour / stakingFactor) : 0;
		const bs = bidSessions[b.bid_id as string] || {};
		return {
			bidId: b.bid_id,
			modelId: b.model_id,
			model: b.model_name || `${(b.model_id as string)?.slice(0, 18)}...`,
			tags: b.model_tags ? (b.model_tags as string).split(",") : [],
			pricePerSecond: pricePerSec.toString(),
			priceMorPerDay: pricePerDay.toFixed(6),
			priceMorPerWeek: pricePerWeek.toFixed(6),
			hourlyStake,
			totalSessions: bs.total_count || 0,
			activeSessions: bs.active_count || 0,
			successCount: bs.success_count || 0,
			disputeCount: bs.dispute_count || 0,
			nonce: b.nonce,
			createdAt: b.created_at,
		};
	});

	// Reputation per model
	const reputation = reputationStats.map((r: Record<string, unknown>) => ({
		modelId: r.model_id,
		successCount: r.success_count,
		disputeCount: r.dispute_count,
		earlyTerminationCount: r.early_termination_count,
		totalSessions: r.total_sessions,
		avgDurationSecs: r.avg_duration_secs,
		successRate:
			(r.total_sessions as number) > 0
				? (((r.success_count as number) / (r.total_sessions as number)) * 100).toFixed(1)
				: null,
	}));

	// Recent sessions
	const sessions = recentSessions.map((s: Record<string, unknown>) => ({
		id: s.id,
		user: s.user_address,
		model: s.model_name || `${(s.model_id as string)?.slice(0, 18)}...`,
		modelId: s.model_id,
		stakeMor: (Number(BigInt((s.stake as string) || "0")) / 1e18).toFixed(4),
		openedAt: s.opened_at,
		endsAt: s.ends_at,
		closedAt: s.closed_at,
		isActive: s.is_active === 1,
		closeoutType: s.closeout_type,
	}));

	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		provider: {
			address: (provider as Record<string, unknown>).address,
			endpoint: (provider as Record<string, unknown>).endpoint,
			stakeMor: (
				Number(BigInt(((provider as Record<string, unknown>).stake as string) || "0")) /
				1e18
			).toFixed(4),
			createdAt: (provider as Record<string, unknown>).created_at,
		},
		summary: {
			activeBids: bids.length,
			retractedBids: retractedBids.length,
			totalSessions,
			activeSessions,
			disputedSessions:
				((sessionSummary as Record<string, unknown>)?.disputed_sessions as number) || 0,
			earlyTerminated:
				((sessionSummary as Record<string, unknown>)?.early_terminated as number) || 0,
			totalStakeMor: (totalStakeWei / 1e18).toFixed(4),
			avgDurationMin: (sessionSummary as Record<string, unknown>)?.avg_duration_secs
				? Math.round(
						((sessionSummary as Record<string, unknown>).avg_duration_secs as number) /
							60,
					)
				: null,
			firstSession: (sessionSummary as Record<string, unknown>)?.first_session,
			lastSession: (sessionSummary as Record<string, unknown>)?.last_session,
			stakingFactor,
		},
		bids,
		reputation,
		recentSessions: sessions,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const receipt = await signResponse(
			"blockchain.provider_detail",
			{ endpoint: `/mor/v1/providers/${addr}`, syncedBlock: lastBlock },
			{ activeBids: bids.length, totalSessions, activeSessions },
			mnemonic,
			env.DB,
			responseData,
		);
		if (receipt) responseData._provenance = JSON.parse(receipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}
