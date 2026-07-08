/**
 * Marketplace - full marketplace rollup (/mor/v1/all).
 *
 * The heaviest read in the explorer: providers + active/retracted bids +
 * session counts + per-provider reputation + live economics, with optional
 * row-level provenance signing.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { getSyncState, buildMeta } from "../utils/rpc";
import { signResponse, signBatchResponse } from "../utils/provenance";
import {
	getAllProviders,
	getActiveBidsWithModels,
	getRetractedBidsWithModels,
	getNetworkEconomics,
	getEconomicsHistoryDesc,
} from "../db/explorer-market";
import {
	countActiveSessions,
	countSessions,
	sumActiveSessionStake,
	getClaimableSessionTotals,
	getAllProviderStats,
} from "../db/explorer-sessions";

interface ModelStats {
	totalSessions: number;
	successCount: number;
	disputeCount: number;
	earlyTerminationCount: number;
	avgDurationSecs: number;
}
interface ProviderStats {
	totalSessions: number;
	successCount: number;
	disputeCount: number;
	earlyTerminationCount: number;
	modelStats: Record<string, ModelStats>;
}

/** Build the provider -> aggregate + per-model stats lookup from provider_stats rows. */
function buildStatsLookup(
	providerStats: Record<string, unknown>[],
): Record<string, ProviderStats> {
	const statsLookup: Record<string, ProviderStats> = {};
	for (const row of providerStats) {
		const p = (row.provider as string)?.toLowerCase();
		if (!p) continue;
		if (!statsLookup[p]) {
			statsLookup[p] = {
				totalSessions: 0,
				successCount: 0,
				disputeCount: 0,
				earlyTerminationCount: 0,
				modelStats: {},
			};
		}
		const s = statsLookup[p];
		s.totalSessions += (row.total_sessions as number) || 0;
		s.successCount += (row.success_count as number) || 0;
		s.disputeCount += (row.dispute_count as number) || 0;
		s.earlyTerminationCount += (row.early_termination_count as number) || 0;
		if (row.model_id) {
			s.modelStats[(row.model_id as string).toLowerCase()] = {
				totalSessions: (row.total_sessions as number) || 0,
				successCount: (row.success_count as number) || 0,
				disputeCount: (row.dispute_count as number) || 0,
				earlyTerminationCount: (row.early_termination_count as number) || 0,
				avgDurationSecs: (row.avg_duration_secs as number) || 0,
			};
		}
	}
	return statsLookup;
}

/** Format a bid with honest pricing + per-model quality stats. */
function makeBidFormatter(
	stakingFactor: number,
	statsLookup: Record<string, ProviderStats>,
) {
	return (bid: Record<string, unknown>, isDeleted = false) => {
		const priceWei = BigInt((bid.price_per_second as string) || "0");
		const priceMorDay = Number(priceWei * 86400n) / 1e18;
		const tags = bid.model_tags ? (bid.model_tags as string).split(",") : [];
		const provider = (bid.provider as string)?.toLowerCase();
		const modelId = (bid.model_id as string)?.toLowerCase();
		const modelStats =
			provider && modelId ? statsLookup[provider]?.modelStats[modelId] : null;

		const userCostPerDay = priceMorDay > 0 ? priceMorDay / stakingFactor : 0;
		const durationSecsFor100 =
			priceMorDay > 0 ? ((100 * stakingFactor) / priceMorDay) * 86400 : 0;
		const minsFor100 = Math.round(durationSecsFor100 / 60);
		const durationSecsFor10 =
			priceMorDay > 0 ? ((10 * stakingFactor) / priceMorDay) * 86400 : 0;
		const minsFor10 = Math.round(durationSecsFor10 / 60);
		const fmt = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
		return {
			bidId: bid.bid_id,
			modelId: bid.model_id,
			model: bid.model_name || null,
			tags,
			pricePerSecond: bid.price_per_second,
			priceMorPerDay: priceMorDay.toFixed(6),
			priceMorPerWeek: (priceMorDay * 7).toFixed(6),
			userCostPerDay: Math.round(userCostPerDay),
			durationFor10Mor: fmt(minsFor10),
			durationFor100Mor: fmt(minsFor100),
			createdAt: bid.created_at || null,
			deletedAt: isDeleted ? bid.deleted_at : null,
			updatedBlock: bid.updated_block,
			totalSessions: modelStats?.totalSessions || 0,
			successCount: modelStats?.successCount || 0,
			disputeCount: modelStats?.disputeCount || 0,
			earlyTerminationCount: modelStats?.earlyTerminationCount || 0,
			avgDurationSecs: modelStats?.avgDurationSecs || 0,
		};
	};
}

export async function handleAll(env: Env, headers: Record<string, string>) {
	const now = Math.floor(Date.now() / 1000);
	const [
		syncState,
		providersResult,
		activeBidsResult,
		retractedBidsResult,
		sessionsResult,
		totalSessionsResult,
		stakeResult,
		claimableResult,
		providerStatsResult,
		economicsRow,
		economicsHistoryResult,
	] = await Promise.all([
		getSyncState(env),
		getAllProviders(env.DB),
		getActiveBidsWithModels(env.DB),
		getRetractedBidsWithModels(env.DB),
		countActiveSessions(env.DB, now),
		countSessions(env.DB),
		sumActiveSessionStake(env.DB, now),
		getClaimableSessionTotals(env.DB, now),
		getAllProviderStats(env.DB),
		getNetworkEconomics(env.DB),
		getEconomicsHistoryDesc(env.DB),
	]);

	const { lastBlock, currentBlock, startBlock, lastSyncTs } = syncState;
	const activeStakeWei = BigInt(
		Math.floor(((stakeResult as Record<string, unknown>)?.total as number) || 0),
	);
	const activeStakeMor = Number(activeStakeWei) / 1e18;
	const claimableStakeWei = BigInt(
		Math.floor(((claimableResult as Record<string, unknown>)?.total as number) || 0),
	);
	const claimableStakeMor = Number(claimableStakeWei) / 1e18;
	const claimableSessions =
		((claimableResult as Record<string, unknown>)?.count as number) || 0;

	const providers = providersResult;
	const activeBids = activeBidsResult;
	const retractedBids = retractedBidsResult;
	const statsLookup = buildStatsLookup(providerStatsResult);

	const econ = economicsRow as Record<string, unknown> | null;
	const STAKING_FACTOR = (econ?.staking_factor as number) || 0.00315;
	// D1 can hold NULL in any wei column - BigInt(null) throws, so guard every conversion.
	const safeWei = (v: unknown): bigint => BigInt(String(v ?? "0") || "0");
	const computeBalanceMor = econ ? Number(safeWei(econ.compute_balance)) / 1e18 : null;
	const totalMorSupplyMor = econ
		? Number(safeWei(econ.total_supply || econ.total_mor_supply)) / 1e18
		: null;
	const todaysBudgetMor = econ ? Number(safeWei(econ.todays_budget)) / 1e18 : null;
	const economicsUpdatedAt = (econ?.updated_at as string) || null;

	const economicsHistory = economicsHistoryResult.map((row: Record<string, unknown>) => ({
		date: row.date,
		computeBalance: Number(safeWei(row.compute_balance)) / 1e18,
		totalMorSupply: Number(safeWei(row.total_supply || row.total_mor_supply)) / 1e18,
		stakingFactor: row.staking_factor,
		providersClaimed: parseFloat((row.providers_claimed as string) || "0"),
	}));

	const formatBid = makeBidFormatter(STAKING_FACTOR, statsLookup);

	const bidsByProvider: Record<string, Record<string, unknown>[]> = {};
	for (const bid of activeBids) {
		const p = (bid as Record<string, unknown>).provider as string;
		if (!bidsByProvider[p]) bidsByProvider[p] = [];
		bidsByProvider[p].push(formatBid(bid as Record<string, unknown>));
	}
	const retractedBidsByProvider: Record<string, Record<string, unknown>[]> = {};
	for (const bid of retractedBids) {
		const p = (bid as Record<string, unknown>).provider as string;
		if (!retractedBidsByProvider[p]) retractedBidsByProvider[p] = [];
		retractedBidsByProvider[p].push(formatBid(bid as Record<string, unknown>, true));
	}

	const formatted: (Record<string, unknown> & { bidCount: number })[] = providers
		.map((p: Record<string, unknown>) => {
			const pStats = statsLookup[(p.address as string)?.toLowerCase()];
			return {
				address: p.address,
				endpoint: p.endpoint,
				bidCount: (bidsByProvider[p.address as string] || []).length,
				retractedBidCount: (retractedBidsByProvider[p.address as string] || []).length,
				updatedBlock: p.updated_block,
				totalSessions: pStats?.totalSessions || 0,
				successCount: pStats?.successCount || 0,
				disputeCount: pStats?.disputeCount || 0,
				earlyTerminationCount: pStats?.earlyTerminationCount || 0,
				bids: bidsByProvider[p.address as string] || [],
				retractedBids: retractedBidsByProvider[p.address as string] || [],
			};
		})
		.sort((a, b) => b.bidCount - a.bidCount);

	let networkSuccess = 0,
		networkDisputes = 0,
		networkEarly = 0;
	for (const p of Object.values(statsLookup)) {
		networkSuccess += p.successCount;
		networkDisputes += p.disputeCount;
		networkEarly += p.earlyTerminationCount;
	}

	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		providerCount: providers.length,
		totalBids: activeBids.length,
		totalRetractedBids: retractedBids.length,
		activeSessions: ((sessionsResult as Record<string, unknown>)?.count as number) || 0,
		totalSessions:
			((totalSessionsResult as Record<string, unknown>)?.count as number) || 0,
		totalSuccessful: networkSuccess,
		totalDisputed: networkDisputes,
		totalEarlyTermination: networkEarly,
		morStaked: activeStakeMor.toFixed(2),
		morStakedWei: activeStakeWei.toString(),
		claimableSessions,
		morClaimable: claimableStakeMor.toFixed(2),
		morInEscrow: (activeStakeMor + claimableStakeMor).toFixed(2),
		economics: {
			computeBalance: computeBalanceMor ? Math.round(computeBalanceMor) : null,
			computeBalanceWei: econ?.compute_balance || null,
			totalMorSupply: totalMorSupplyMor ? Math.round(totalMorSupplyMor) : null,
			totalMorSupplyWei: econ?.total_mor_supply || null,
			todaysBudget: todaysBudgetMor ? Math.round(todaysBudgetMor) : null,
			todaysBudgetWei: econ?.todays_budget || null,
			stakingFactor: STAKING_FACTOR,
			updatedAt: economicsUpdatedAt,
			history: economicsHistory,
		},
		providers: formatted,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const batch = signBatchResponse("blockchain.all", formatted, mnemonic);
		if (batch) {
			for (let i = 0; i < formatted.length; i++)
				formatted[i]._receipt = batch.receiptIds[i];
			responseData._provenance = {
				service: "morscan",
				producer: "morscan/all",
				receipt_count: batch.receiptIds.length,
				merkle_root: batch.merkleRoot,
			};
		}
		const aggregateReceipt = await signResponse(
			"blockchain.marketplace",
			{ endpoint: "/mor/v1/all", syncedBlock: lastBlock },
			{
				providers: providers.length,
				bids: activeBids.length,
				sessions:
					((totalSessionsResult as Record<string, unknown>)?.count as number) || 0,
			},
			mnemonic,
			env.DB,
		);
		if (aggregateReceipt)
			responseData._provenance_aggregate = JSON.parse(aggregateReceipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}
