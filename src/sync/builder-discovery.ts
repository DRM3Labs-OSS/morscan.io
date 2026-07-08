/**
 * Builder global stats + Goldsky subgraph discovery.
 *
 * - syncBuilderGlobalStats: on-chain network-wide pool totals + reward state.
 * - syncFromGoldsky: subnet list, staker counts, and metadata from the Morpheus
 *   Dashboard Goldsky subgraph (authoritative for staker counts + discovery).
 */

import type { Env } from "../types";
import {
	BUILDER_SELECTORS,
	ethCallBuilder,
	parseAllSubnetsData,
	parseAllSubnetsDataV4,
} from "./builder-parsers";
import {
	getFundedSubnetDeposits,
	setBuilderSyncState,
	addSubnetChainColumn,
	upsertSubnetFromGoldskyStmt,
} from "../db/sync-builder";

/**
 * Refresh builder global stats from chain + D1.
 *
 * allSubnetsData() returns the total across ALL Morpheus staking pools
 * (capital + code + compute + builder) - NOT just builder subnets. The
 * builder-only total is computed from SUM(builder_subnets.total_deposited).
 */
export async function syncBuilderGlobalStats(env: Env): Promise<void> {
	const [allDataResult, allDataV4Result, rewardsResult, subnetRows] = await Promise.all([
		ethCallBuilder(env, BUILDER_SELECTORS.allSubnetsData),
		ethCallBuilder(env, BUILDER_SELECTORS.allSubnetsDataV4),
		ethCallBuilder(env, BUILDER_SELECTORS.getCurrentSubnetsRewards),
		getFundedSubnetDeposits(env.DB),
	]);

	const allData = parseAllSubnetsData(allDataResult);
	const allDataV4 = parseAllSubnetsDataV4(allDataV4Result);
	const currentRewards = BigInt(
		`0x${rewardsResult.replace(/^0x/, "") || "0"}`,
	).toString();
	// Wei values overflow SQLite INTEGER - sum with BigInt in JS
	let builderSum = 0n;
	for (const row of subnetRows) {
		try {
			builderSum += BigInt(row.total_deposited);
		} catch {
			/* skip bad rows */
		}
	}
	const builderTotal = builderSum.toString();

	const now = Math.floor(Date.now() / 1000);
	const stats = {
		total_deposited: builderTotal,
		all_pools_total: allData.totalStaked,
		rate: allData.rate,
		undistributed_rewards: allDataV4.undistributed,
		distributed_rewards: allDataV4.distributed,
		claimed_rewards: allDataV4.claimed,
		last_contract_update: allDataV4.lastUpdate,
		current_pending_rewards: currentRewards,
		updated_at: now,
	};

	await setBuilderSyncState(env.DB, "global_stats", JSON.stringify(stats));
}

/**
 * Sync subnet data from the Morpheus Dashboard Goldsky subgraph.
 *
 * The Goldsky API (dashboard.mor.org) indexes the BuilderSubnets contract and
 * provides accurate staker counts, total staked amounts, and metadata that raw
 * RPC calls alone can't give. Supplements (not replaces) on-chain data.
 */
export async function syncFromGoldsky(env: Env): Promise<void> {
	// Ensure chain column exists (safe to run repeatedly - SQLite no-ops if present)
	try {
		await addSubnetChainColumn(env.DB);
	} catch {
		/* already exists */
	}

	const now = Math.floor(Date.now() / 1000);
	const stmts: D1PreparedStatement[] = [];

	for (const chain of ["base", "arbitrum"] as const) {
		try {
			const resp = await fetch(
				`https://dashboard.mor.org/api/builders/goldsky/${chain}`,
				{
					signal: AbortSignal.timeout(10000),
				},
			);
			if (!resp.ok) {
				console.error(`[syncBuilder] Goldsky ${chain}: HTTP ${resp.status}`);
				continue;
			}
			const data = (await resp.json()) as {
				buildersProjects?: Array<Record<string, string>>;
			};
			const projects = data.buildersProjects || [];

			for (const p of projects) {
				const subnetId = (p.id || "").toLowerCase();
				if (!subnetId || !subnetId.startsWith("0x")) continue;
				const name = p.name || "";
				const admin = (p.admin || "").toLowerCase();
				const totalStaked = p.totalStaked || "0";
				const totalUsers = parseInt(p.totalUsers || "0", 10);
				const minDeposit = p.minimalDeposit || "0";
				const lockPeriod = parseInt(p.withdrawLockPeriodAfterDeposit || "604800", 10);
				const description = p.description || "";
				const website = p.website || "";
				const image = p.image || "";
				const slug = p.slug || "";

				stmts.push(
					upsertSubnetFromGoldskyStmt(
						env.DB,
						subnetId,
						name,
						admin,
						totalStaked,
						totalUsers,
						minDeposit,
						lockPeriod,
						slug,
						description,
						website,
						image,
						chain,
						now,
						now,
					),
				);
			}

			console.log(`[syncBuilder] Goldsky ${chain}: ${projects.length} subnets`);
		} catch (e) {
			console.error(`[syncBuilder] Goldsky ${chain} error:`, e);
		}
	}

	for (let i = 0; i < stmts.length; i += 100) {
		await env.DB.batch(stmts.slice(i, i + 100));
	}
}
