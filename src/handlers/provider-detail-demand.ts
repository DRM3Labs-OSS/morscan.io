/**
 * Model demand heatmap + daily session counts (supply/demand intelligence).
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { getSyncState, buildMeta } from "../utils/rpc";
import { signResponse } from "../utils/provenance";
import {
	getBidStatsByModel,
	getModelIdNameTags,
	getEconomicsHistoryAsc,
} from "../db/explorer-market";
import {
	getModelSessionStats,
	getModelSessionCounts24h,
	getModelSessionCounts7d,
	getDailySessionStats,
} from "../db/explorer-sessions";

/**
 * GET /mor/v1/models/demand
 * Model demand heatmap - sessions per model, trending, pricing spread.
 */
export async function handleModelDemand(env: Env, headers: Record<string, string>) {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);
	const now = Math.floor(Date.now() / 1000);
	const oneDay = now - 86400;
	const oneWeek = now - 604800;

	const [modelSessions, modelSessionsDay, modelSessionsWeek, modelBids, modelNames] =
		await Promise.all([
			getModelSessionStats(env.DB, now),
			getModelSessionCounts24h(env.DB, oneDay),
			getModelSessionCounts7d(env.DB, oneWeek),
			getBidStatsByModel(env.DB),
			getModelIdNameTags(env.DB),
		]);

	const nameMap = new Map<string, { name: string; tags: string[] }>();
	for (const m of modelNames) {
		nameMap.set((m.model_id as string)?.toLowerCase(), {
			name: m.name as string,
			tags: m.tags ? (m.tags as string).split(",") : [],
		});
	}
	const day = new Map<string, number>();
	for (const r of modelSessionsDay) {
		day.set((r.model_id as string)?.toLowerCase(), r.sessions_24h as number);
	}
	const week = new Map<string, number>();
	for (const r of modelSessionsWeek) {
		week.set((r.model_id as string)?.toLowerCase(), r.sessions_7d as number);
	}
	const bidMap = new Map<string, Record<string, unknown>>();
	for (const b of modelBids) {
		const minPerDay = (Number(b.min_price) * 86400) / 1e18;
		const maxPerDay = (Number(b.max_price) * 86400) / 1e18;
		const avgPerDay = (Number(b.avg_price) * 86400) / 1e18;
		bidMap.set((b.model_id as string)?.toLowerCase(), {
			bidCount: b.bid_count,
			providerCount: b.provider_count,
			priceMorPerDay: {
				min: minPerDay.toFixed(6),
				max: maxPerDay.toFixed(6),
				avg: avgPerDay.toFixed(6),
			},
		});
	}

	const allModels = modelSessions
		.map((r: Record<string, unknown>) => {
			const mid = (r.model_id as string)?.toLowerCase();
			const info = nameMap.get(mid);
			const bids = bidMap.get(mid);
			const sessions24h = day.get(mid) || 0;
			const sessions7d = week.get(mid) || 0;
			const hasName = !!info?.name;
			return {
				modelId: r.model_id,
				modelIdShort: r.model_id
					? `${(r.model_id as string).slice(0, 10)}...${(r.model_id as string).slice(-6)}`
					: "",
				model: info?.name || null,
				tags: info?.tags || [],
				totalSessions: r.total_sessions,
				activeSessions: r.active_sessions,
				sessions24h,
				sessions7d,
				uniqueUsers: r.unique_users,
				totalStakeMor: (Number(r.total_stake_wei || 0) / 1e18).toFixed(2),
				supply: bids
					? {
							bidCount: bids.bidCount,
							providerCount: bids.providerCount,
							priceMorPerDay: bids.priceMorPerDay,
						}
					: null,
				demandScore:
					(r.total_sessions as number) +
					sessions24h * 10 +
					(r.active_sessions as number) * 5,
				hasName,
				isDead: !hasName && r.active_sessions === 0 && !bids && sessions7d === 0,
			};
		})
		.sort((a, b) => b.demandScore - a.demandScore);

	const models = allModels.filter((m) => !m.isDead);
	const deadModels = allModels.filter((m) => m.isDead);

	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		modelCount: models.length,
		deadModelCount: deadModels.length,
		models,
		deadModels,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const receipt = await signResponse(
			"blockchain.model_demand",
			{ endpoint: "/mor/v1/models/demand", syncedBlock: lastBlock },
			{ modelCount: models.length, deadModelCount: deadModels.length },
			mnemonic,
			env.DB,
			responseData,
		);
		if (receipt) responseData._provenance = JSON.parse(receipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}

/**
 * GET /mor/v1/sessions/daily
 * Real daily session counts from the sessions table - no fake data.
 */
export async function handleDailySessions(env: Env, headers: Record<string, string>) {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);

	const result = await getDailySessionStats(
		env.DB,
		Math.floor(Date.now() / 1000) - 30 * 86400,
	);

	const days = result.map((r: Record<string, unknown>) => ({
		date: r.day,
		sessions: r.sessions,
		uniqueUsers: r.unique_users,
		totalStakeMor: (Number(r.total_stake_wei || 0) / 1e18).toFixed(2),
	}));

	const econHistory = await getEconomicsHistoryAsc(env.DB);

	const economics = econHistory.map((r: Record<string, unknown>) => ({
		date: r.date,
		stakingFactor: r.staking_factor,
		computeBalance: r.compute_balance,
		totalMorSupply: r.total_mor_supply,
	}));

	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		days,
		economics,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const receipt = await signResponse(
			"blockchain.daily_sessions",
			{ endpoint: "/mor/v1/sessions/daily", syncedBlock: lastBlock },
			{ dayCount: days.length },
			mnemonic,
			env.DB,
			responseData,
		);
		if (receipt) responseData._provenance = JSON.parse(receipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}
