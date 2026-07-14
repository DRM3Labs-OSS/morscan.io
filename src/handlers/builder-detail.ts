/**
 * Builder Staking - subnet detail + per-wallet positions.
 */

import type { Env } from "../types";
import { HEADERS, builderDailyEmissions, formatMor, morNumber } from "./builder-shared";
import {
	countSubnetDepositors,
	selectFirstSubnetDepositBlock,
	selectLastSubnetClaimBlock,
	selectLatestDepositBlocksBySubnet,
	selectLatestDepositBlocksByWallet,
	selectPreviousSubnetStakers,
	selectRecentSubnetEvents,
	selectSubnetById,
	selectTopSubnetStakers,
	selectWalletBuilderStakes,
	sumSubnetClaims,
} from "../db/explorer-builder";

/** Deposit time from its BLOCK NUMBER: Base blocks are a fixed 2s, so
 * now - (head - block) * 2 is chain-derived truth. Falls back to the
 * indexer's processing stamp only when the deposit event is not indexed. */
function depositTsFromBlock(
	nowEpoch: number,
	currentBlock: number,
	blk: number | undefined,
	fallbackTs: number,
): number {
	if (blk && currentBlock > 0 && blk <= currentBlock)
		return nowEpoch - (currentBlock - blk) * 2;
	return fallbackTs;
}
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
		depositBlocks,
		previousStakerRows,
	] = await Promise.all([
		selectSubnetById(env.DB, subnetId),
		selectTopSubnetStakers(env.DB, subnetId),
		selectRecentSubnetEvents(env.DB, subnetId),
		getBuilderSyncStateValue(env.DB, "global_stats"),
		sumSubnetClaims(env.DB, subnetId),
		countSubnetDepositors(env.DB, subnetId),
		selectCurrentBlockValue(env.DB),
		selectLatestDepositBlocksBySubnet(env.DB, subnetId),
		selectPreviousSubnetStakers(env.DB, subnetId),
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

	const nowEpoch = Math.floor(Date.now() / 1000);

	// Per-staker withdraw unlock: the subnet's withdraw_lock_period counted from
	// that staker's LAST deposit (the contract keeps ONE lastDeposit per
	// position - every new deposit relocks the whole stake). Deposit time is
	// derived from the deposit's block number (Base's fixed 2s clock), not the
	// indexer's processing stamp, so backfilled history reads chain-true. Same
	// basis as /mor/v1/builder/stakes/:wallet - one definition.
	const lockPeriod = (subnet.withdraw_lock_period as number) || 604800;
	const blkByWallet = new Map(depositBlocks.map((d) => [d.wallet, d.blk]));
	const stakerRows = topStakers;
	const enrichedStakers = stakerRows
		.filter((s) => BigInt((s.deposited as string) || "0") > BigInt(0))
		.map((s) => {
			const lastDep = depositTsFromBlock(
				nowEpoch,
				currentBlock,
				blkByWallet.get(s.wallet as string),
				(s.last_deposit_at as number) || 0,
			);
			const unlockAt = lastDep > 0 ? lastDep + lockPeriod : null;
			return {
				wallet: s.wallet as string,
				deposited: formatMor((s.deposited as string) || "0"),
				lastDepositAt: lastDep || s.last_deposit_at,
				unlockAt,
				locked: unlockAt !== null && nowEpoch < unlockAt,
			};
		})
		.sort(
			(a, b) =>
				parseFloat(b.deposited.replace(/,/g, "")) -
				parseFloat(a.deposited.replace(/,/g, "")),
		);

	// Previous stakers: fully-exited positions (deposited netted to 0). We keep
	// them here with credit for what they staked, instead of silently dropping
	// them from the subnet the moment they withdraw.
	const previousStakers = previousStakerRows.map((p) => {
		const blk = p.last_block as number;
		return {
			wallet: p.wallet as string,
			totalStakedEver: ((Number(p.total_deposited_ever) || 0) / 1e18).toFixed(2),
			exitedAt: blk && currentBlock > 0 ? nowEpoch - (currentBlock - blk) * 2 : null,
		};
	});

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
				// Active stakers only (deposited > 0). A withdrawal drops the count;
				// fully-exited wallets move to previousStakers, not the active tally.
				stakerCount: Math.max(
					enrichedStakers.length,
					(subnet.staker_count as number) || 0,
				),
				totalDepositorsEver: (uniqueStakerRow?.cnt as number) || 0,
				poolShare: `${(subnetShare * 100).toFixed(2)}%`,
				estimatedDailyEmissions: estimatedDaily.toFixed(2),
				estimatedWeeklyEmissions: (estimatedDaily * 7).toFixed(2),
				estimatedYearlyEmissions: (estimatedDaily * 365).toFixed(2),
				globalDailyEmissions: builderDailyEmissions(),
			},
			topStakers: enrichedStakers,
			previousStakers,
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
	const [stakes, globalRow, currentBlockRow, depositBlocks] = await Promise.all([
		selectWalletBuilderStakes(env.DB, wallet.toLowerCase()),
		getBuilderSyncStateValue(env.DB, "global_stats"),
		selectCurrentBlockValue(env.DB),
		selectLatestDepositBlocksByWallet(env.DB, wallet.toLowerCase()),
	]);
	const globalStats = globalRow ? JSON.parse(globalRow.value as string) : {};
	const totalDepositedMor = morNumber(globalStats.total_deposited || "0");
	const currentBlock = parseInt(currentBlockRow?.value || "0", 10);
	const blkBySubnet = new Map(depositBlocks.map((d) => [d.subnet_id, d.blk]));

	const results = stakes.map((s) => {
		const depositedMor = morNumber((s.deposited as string) || "0");
		const share = totalDepositedMor > 0 ? depositedMor / totalDepositedMor : 0;
		const lockPeriod = (s.withdraw_lock_period as number) || 604800;
		const now = Math.floor(Date.now() / 1000);
		// Same chain-derived deposit clock as the subnet detail (one definition).
		const lastDeposit = depositTsFromBlock(
			now,
			currentBlock,
			blkBySubnet.get(s.subnet_id as string),
			(s.last_deposit_at as number) || 0,
		);
		const unlockAt = lastDeposit + lockPeriod;
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
