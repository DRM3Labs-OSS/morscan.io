/**
 * Builder Staking - subnet detail + per-wallet positions.
 */

import type { Env } from "../types";
import { HEADERS, builderDailyEmissions, formatMor, morNumber } from "./builder-shared";
import {
	countSubnetDepositors,
	selectFirstSubnetDepositBlock,
	selectLastSubnetClaimBlock,
	selectRecentSubnetEvents,
	selectSubnetById,
	selectTopSubnetStakers,
	selectWalletBuilderStakes,
	sumSubnetClaims,
} from "../db/explorer-builder";
import { getBuilderSyncStateValue } from "../db/sync-builder";
import { selectCurrentBlockValue } from "../db/explorer-core";

/** GET /mor/v1/builder/subnets/:subnetId - Subnet detail */
export async function handleBuilderSubnetDetail(
	env: Env,
	subnetId: string,
): Promise<Response> {
	const [
		subnet,
		topStakers,
		recentEvents,
		globalRow,
		claimedRow,
		uniqueStakerRow,
		currentBlockRow,
	] = await Promise.all([
		selectSubnetById(env.DB, subnetId),
		selectTopSubnetStakers(env.DB, subnetId),
		selectRecentSubnetEvents(env.DB, subnetId),
		getBuilderSyncStateValue(env.DB, "global_stats"),
		sumSubnetClaims(env.DB, subnetId),
		countSubnetDepositors(env.DB, subnetId),
		selectCurrentBlockValue(env.DB),
	]);
	const currentBlock = parseInt(currentBlockRow?.value || "0", 10);

	if (!subnet)
		return new Response(JSON.stringify({ error: "Subnet not found" }), {
			status: 404,
			headers: HEADERS,
		});

	// D1 data is refreshed every ~30s by SyncCoordinator - no live RPC call needed.
	let livePending = (subnet.pending_rewards as string) || "0";
	const liveDeposited = (subnet.total_deposited as string) || "0";

	const globalStats = globalRow ? JSON.parse(globalRow.value as string) : {};
	const totalDepositedMor = morNumber(globalStats.total_deposited || "0");
	const subnetDepositedMor = morNumber(liveDeposited);
	const subnetShare = totalDepositedMor > 0 ? subnetDepositedMor / totalDepositedMor : 0;
	const estimatedDaily = subnetShare * builderDailyEmissions();

	// If chain says 0 pending but we have emissions, estimate from time since last
	// claim (or first deposit if never claimed). Per-second precision.
	if (morNumber(livePending) === 0 && estimatedDaily > 0) {
		const [lastClaimEvent, firstDepositEvent] = await Promise.all([
			selectLastSubnetClaimBlock(env.DB, subnetId),
			selectFirstSubnetDepositBlock(env.DB, subnetId),
		]);
		const referenceBlock =
			(lastClaimEvent?.b as number) || (firstDepositEvent?.b as number) || 0;
		if (referenceBlock > 0 && currentBlock > referenceBlock) {
			const secsSince = (currentBlock - referenceBlock) * 2;
			const morPerSecond = estimatedDaily / 86400;
			const estimatedPending = morPerSecond * secsSince;
			if (estimatedPending > 0.01)
				livePending = BigInt(Math.round(estimatedPending * 1e18)).toString();
		}
	}

	const stakerRows = topStakers;
	const enrichedStakers = stakerRows
		.filter((s) => BigInt((s.deposited as string) || "0") > BigInt(0))
		.map((s) => ({
			wallet: s.wallet as string,
			deposited: formatMor((s.deposited as string) || "0"),
			lastDepositAt: s.last_deposit_at,
		}))
		.sort(
			(a, b) =>
				parseFloat(b.deposited.replace(/,/g, "")) -
				parseFloat(a.deposited.replace(/,/g, "")),
		);

	const nowEpoch = Math.floor(Date.now() / 1000);

	return new Response(
		JSON.stringify({
			subnet: {
				subnetId: subnet.subnet_id,
				name: subnet.name || "(unnamed)",
				admin: subnet.admin,
				claimAdmin: subnet.claim_admin,
				minimalDeposit: formatMor((subnet.minimal_deposit as string) || "0"),
				withdrawLockPeriod: subnet.withdraw_lock_period,
				totalDeposited: formatMor(liveDeposited),
				pendingRewards: formatMor(livePending),
				totalClaimed: formatMor(((claimedRow?.total as number) || 0).toString()),
				network: (subnet.chain as string) || "base",
				metadataName: subnet.metadata_name || "",
				metadataDescription: subnet.metadata_description || "",
				metadataUrl: subnet.metadata_url || "",
				metadataLogo: subnet.metadata_logo || "",
				stakerCount: Math.max(
					enrichedStakers.length,
					(subnet.staker_count as number) || 0,
					(uniqueStakerRow?.cnt as number) || 0,
				),
				poolShare: `${(subnetShare * 100).toFixed(2)}%`,
				estimatedDailyEmissions: estimatedDaily.toFixed(2),
				estimatedWeeklyEmissions: (estimatedDaily * 7).toFixed(2),
				estimatedYearlyEmissions: (estimatedDaily * 365).toFixed(2),
				globalDailyEmissions: builderDailyEmissions(),
			},
			topStakers: enrichedStakers,
			recentEvents: recentEvents.map((e) => {
				const blockNum = e.block_number as number;
				const approxTs = currentBlock > 0 ? nowEpoch - (currentBlock - blockNum) * 2 : 0;
				return {
					type: e.event_type,
					wallet: e.wallet,
					amount: formatMor((e.amount as string) || "0"),
					blockNumber: blockNum,
					timestamp: approxTs > 0 ? approxTs : null,
				};
			}),
		}),
		{ headers: HEADERS },
	);
}

/** GET /mor/v1/builder/stakes/:wallet - Wallet's builder positions */
export async function handleBuilderWalletStakes(
	env: Env,
	wallet: string,
): Promise<Response> {
	const stakes = await selectWalletBuilderStakes(env.DB, wallet.toLowerCase());

	const globalRow = await getBuilderSyncStateValue(env.DB, "global_stats");
	const globalStats = globalRow ? JSON.parse(globalRow.value as string) : {};
	const totalDepositedMor = morNumber(globalStats.total_deposited || "0");

	const results = stakes.map((s) => {
		const depositedMor = morNumber((s.deposited as string) || "0");
		const share = totalDepositedMor > 0 ? depositedMor / totalDepositedMor : 0;
		const lockPeriod = (s.withdraw_lock_period as number) || 604800;
		const lastDeposit = (s.last_deposit_at as number) || 0;
		const unlockAt = lastDeposit + lockPeriod;
		const now = Math.floor(Date.now() / 1000);
		return {
			subnetId: s.subnet_id,
			subnetName: s.name || "(unnamed)",
			deposited: formatMor((s.deposited as string) || "0"),
			depositedWei: s.deposited,
			lastDepositAt: lastDeposit,
			unlockAt,
			locked: now < unlockAt,
			lockedUntil: now < unlockAt ? new Date(unlockAt * 1000).toISOString() : null,
			poolShare: `${(share * 100).toFixed(4)}%`,
			estimatedDailyMor: (share * builderDailyEmissions()).toFixed(4),
		};
	});

	return new Response(
		JSON.stringify({
			wallet: wallet.toLowerCase(),
			positions: results,
			totalDeposited: formatMor(
				results
					.reduce((acc, r) => acc + BigInt((r.depositedWei as string) || "0"), 0n)
					.toString(),
			),
		}),
		{ headers: HEADERS },
	);
}
