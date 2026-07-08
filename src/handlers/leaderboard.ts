/**
 * Leaderboard Handlers - Top Providers & Top Consumer Nodes
 * Supports time-based rankings: weekly (7 days) and all-time
 */

import type { Env } from "../types";
import { getSyncState, buildMeta } from "../utils/rpc";
import {
	getTopProvidersAllTime,
	getTopProvidersWeekly,
	getTopWalletsAllTime,
	getTopWalletsWeekly,
} from "../db/explorer-sessions";

export async function handleLeaderboard(
	env: Env,
	headers: Record<string, string>,
	_url: URL,
) {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);
	const now = Math.floor(Date.now() / 1000);
	const weekAgo = now - 7 * 86400;

	// Run all queries in parallel
	const [topProvidersAllTime, topProvidersWeekly, topWalletsAllTime, topWalletsWeekly] =
		await Promise.all([
			// Top providers - all time (join with providers table for endpoint)
			getTopProvidersAllTime(env.DB, now),
			// Top providers - last 7 days
			getTopProvidersWeekly(env.DB, now, weekAgo),
			// Top consumer nodes - all time
			getTopWalletsAllTime(env.DB, now),
			// Top consumer nodes - last 7 days
			getTopWalletsWeekly(env.DB, now, weekAgo),
		]);

	const formatProvider = (row: Record<string, unknown>) => ({
		provider: row.provider,
		endpoint: row.endpoint || null,
		totalSessions: row.total_sessions || 0,
		successful: row.successful || 0,
		disputed: row.disputed || 0,
		activeNow: row.active_now || 0,
		totalMorStaked: Math.floor((row.total_mor_staked as number) || 0),
		uniqueUsers: row.unique_users || 0,
		uniqueModels: row.unique_models || 0,
		firstSession: row.first_session || 0,
		lastSession: row.last_session || 0,
	});

	const formatWallet = (row: Record<string, unknown>) => ({
		wallet: row.wallet,
		totalSessions: row.total_sessions || 0,
		activeNow: row.active_now || 0,
		successful: row.successful || 0,
		disputed: row.disputed || 0,
		totalMorStaked: Math.floor((row.total_mor_staked as number) || 0),
		activeMorStaked: Math.floor((row.active_mor_staked as number) || 0),
		uniqueProviders: row.unique_providers || 0,
		uniqueModels: row.unique_models || 0,
		firstSession: row.first_session || 0,
		lastSession: row.last_session || 0,
	});

	return new Response(
		JSON.stringify({
			...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
			providers: {
				allTime: topProvidersAllTime.map(formatProvider),
				weekly: topProvidersWeekly.map(formatProvider),
			},
			wallets: {
				allTime: topWalletsAllTime.map(formatWallet),
				weekly: topWalletsWeekly.map(formatWallet),
			},
		}),
		{ headers },
	);
}
