/**
 * Builder Staking API Handlers
 *
 * All endpoints under /mor/v1/builder/*. Same auth model as Compute endpoints.
 * Subnet detail + per-wallet positions live in builder-detail.ts; shared
 * helpers in builder-shared.ts. Both re-exported here so existing imports
 * (`from '../handlers/builder'`) keep working.
 */

import type { Env } from "../types";
import { HEADERS, builderDailyEmissions, formatMor, morNumber } from "./builder-shared";
import {
	countBuilderEvents,
	countSubnets,
	selectBuilderEventsPage,
	selectSubnetsByDeposit,
	sumSubnetStakerCounts,
} from "../db/explorer-builder";
import { getBuilderSyncStateValue } from "../db/sync-builder";

export { handleBuilderSubnetDetail, handleBuilderWalletStakes } from "./builder-detail";

/** GET /mor/v1/builder/subnets - All subnets with staker counts and APR */
export async function handleBuilderSubnets(env: Env, _url?: URL): Promise<Response> {
	const [subnets, globalRow] = await Promise.all([
		selectSubnetsByDeposit(env.DB),
		getBuilderSyncStateValue(env.DB, "global_stats"),
	]);

	const globalStats = globalRow ? JSON.parse(globalRow.value as string) : {};
	const totalDepositedMor = morNumber(globalStats.total_deposited || "0");
	const apr =
		totalDepositedMor > 0
			? ((builderDailyEmissions() * 365) / totalDepositedMor) * 100
			: 0;

	const results = subnets.map((s) => {
		const subnetDepositedMor = morNumber((s.total_deposited as string) || "0");
		const subnetShare =
			totalDepositedMor > 0 ? subnetDepositedMor / totalDepositedMor : 0;
		return {
			subnetId: s.subnet_id,
			name: s.name || "(unnamed)",
			admin: s.admin,
			totalDeposited: formatMor((s.total_deposited as string) || "0"),
			totalDepositedWei: s.total_deposited,
			pendingRewards: formatMor((s.pending_rewards as string) || "0"),
			stakerCount: (s.staker_count as number) || 0,
			withdrawLockPeriod: s.withdraw_lock_period,
			poolShare: `${(subnetShare * 100).toFixed(5)}%`,
			estimatedDailyEmissions: (subnetShare * builderDailyEmissions()).toFixed(2),
			network: (s.chain as string) || "base",
			metadataName: s.metadata_name || "",
			metadataDescription: s.metadata_description || "",
			metadataUrl: s.metadata_url || "",
			metadataLogo: s.metadata_logo || "",
		};
	});

	return new Response(
		JSON.stringify({
			subnets: results,
			global: {
				totalDeposited: formatMor(globalStats.total_deposited || "0"),
				totalDepositedWei: globalStats.total_deposited || "0",
				allPoolsTotal: formatMor(globalStats.all_pools_total || "0"),
				allPoolsTotalWei: globalStats.all_pools_total || "0",
				subnetCount: results.length,
				dailyEmissions: builderDailyEmissions(),
				apr: `${apr.toFixed(1)}%`,
				currentPendingRewards: formatMor(globalStats.current_pending_rewards || "0"),
				claimedRewards: formatMor(globalStats.claimed_rewards || "0"),
				lastUpdate: globalStats.updated_at,
			},
		}),
		{ headers: HEADERS },
	);
}

/** GET /mor/v1/builder/stats - Global builder stats */
export async function handleBuilderStats(env: Env): Promise<Response> {
	const [globalRow, subnetCount, stakerCount] = await Promise.all([
		getBuilderSyncStateValue(env.DB, "global_stats"),
		countSubnets(env.DB),
		sumSubnetStakerCounts(env.DB),
	]);

	const stats = globalRow ? JSON.parse(globalRow.value as string) : {};
	const totalDepositedMor = morNumber(stats.total_deposited || "0");
	const apr =
		totalDepositedMor > 0
			? ((builderDailyEmissions() * 365) / totalDepositedMor) * 100
			: 0;

	return new Response(
		JSON.stringify({
			totalDeposited: formatMor(stats.total_deposited || "0"),
			totalDepositedWei: stats.total_deposited || "0",
			allPoolsTotal: formatMor(stats.all_pools_total || "0"),
			allPoolsTotalWei: stats.all_pools_total || "0",
			subnetCount: (subnetCount as Record<string, number>)?.count || 0,
			activeStakers: (stakerCount as Record<string, number>)?.count || 0,
			dailyEmissions: builderDailyEmissions(),
			apr: `${apr.toFixed(1)}%`,
			undistributedRewards: formatMor(stats.undistributed_rewards || "0"),
			claimedRewards: formatMor(stats.claimed_rewards || "0"),
			currentPendingRewards: formatMor(stats.current_pending_rewards || "0"),
			lastUpdate: stats.updated_at,
			contract: env.BUILDER_CONTRACT,
		}),
		{ headers: HEADERS },
	);
}

/** GET /mor/v1/builder/events - Recent builder events (paginated) */
export async function handleBuilderEvents(env: Env, url: URL): Promise<Response> {
	// Hard caps, server-enforced: max 100 rows per page, max page depth 1000.
	const page = Math.min(
		1000,
		Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1),
	);
	const limit = Math.min(
		100,
		Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50),
	);
	const offset = (page - 1) * limit;

	const [events, total] = await Promise.all([
		selectBuilderEventsPage(env.DB, limit, offset),
		countBuilderEvents(env.DB),
	]);

	return new Response(
		JSON.stringify({
			events: events.map((e) => ({
				type: e.event_type,
				subnetId: e.subnet_id,
				wallet: e.wallet,
				amount: formatMor((e.amount as string) || "0"),
				txHash: e.tx_hash,
				blockNumber: e.block_number,
			})),
			page,
			limit,
			total: (total as Record<string, number>)?.count || 0,
		}),
		{ headers: HEADERS },
	);
}

/** GET /mor/v1/builder/all - Fatboy blob for builder plane */
export async function handleBuilderAll(env: Env, url?: URL): Promise<Response> {
	const [subnetsResp, statsResp] = await Promise.all([
		handleBuilderSubnets(env, url),
		handleBuilderStats(env),
	]);

	const subnets = (await subnetsResp.json()) as Record<string, unknown>;
	const stats = (await statsResp.json()) as Record<string, unknown>;

	return new Response(
		JSON.stringify({
			...stats,
			subnets: subnets.subnets,
		}),
		{ headers: HEADERS },
	);
}
