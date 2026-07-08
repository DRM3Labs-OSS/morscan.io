/**
 * Session Handlers - list + analytics + per-wallet session lists.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { getSyncState, buildMeta } from "../utils/rpc";
import { signResponse, signBatchResponse } from "../utils/provenance";
import { SELECTORS, ethCallBatchChecked } from "../sync/parsers";
import {
	buildCloseExpiredSessionStmt,
	countSessions,
	countActiveSessions,
	countDistinctSessionWallets,
	getSessionsPage,
	getWalletSessionsByBlock,
	getWalletStatsOrdered,
} from "../db/explorer-sessions";

function parseSessionClosedAt(
	result: string,
): { closedAt: number; endsAt: number; exists: boolean } | null {
	if (!result || result === "0x") return { closedAt: 0, endsAt: 0, exists: false };
	if (result.length < 706) return null;
	try {
		const stakeHex = result.slice(194, 258);
		const endsAt = parseInt(result.slice(514, 578), 16);
		const closedAt = parseInt(result.slice(578, 642), 16);
		const exists = !/^0+$/.test(stakeHex) || endsAt > 0 || closedAt > 0;
		return { closedAt, endsAt, exists };
	} catch {
		return null;
	}
}

async function _verifyExpiredOpenRows(
	env: Env,
	sessions: Record<string, unknown>[],
	now: number,
): Promise<void> {
	const candidates = sessions.filter(
		(s) =>
			s.is_active === 1 && Number(s.ends_at || 0) > 0 && Number(s.ends_at || 0) < now,
	);
	if (candidates.length === 0) return;

	const calls = candidates.map(
		(s) => SELECTORS.getSession + String(s.id).replace("0x", ""),
	);
	const payload = await ethCallBatchChecked(env, calls, 8000);
	if (!payload) return;

	const updates: D1PreparedStatement[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const chain = parseSessionClosedAt(payload[i]);
		if (!chain) continue;
		if ((chain.exists && chain.closedAt > 0) || !chain.exists) {
			const closedAt =
				chain.closedAt > 0 ? chain.closedAt : chain.endsAt > 0 ? chain.endsAt : now;
			candidates[i].is_active = 0;
			candidates[i].closed_at = closedAt;
			updates.push(buildCloseExpiredSessionStmt(env.DB, closedAt, candidates[i].id));
		}
	}

	for (let i = 0; i < updates.length; i += 50) {
		await env.DB.batch(updates.slice(i, i + 50)).catch(() => {});
	}
}

// _verifyExpiredOpenRows is retained for chain-rehydration repair paths.
void _verifyExpiredOpenRows;

export async function handleAllSessions(
	env: Env,
	headers: Record<string, string>,
	url: URL,
) {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);

	// Hard caps, server-enforced: max 100 rows per page, max page depth 1000
	// (keeps offset*limit from forcing a deep scan). The pagination meta echoes
	// the applied values, so over-cap requests see what they actually got.
	const rawPage = parseInt(url.searchParams.get("page") || "1", 10);
	const page = Number.isFinite(rawPage) ? Math.min(1000, Math.max(1, rawPage)) : 1;
	const rawLimit = parseInt(url.searchParams.get("limit") || "100", 10);
	const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 100;
	const offset = (page - 1) * limit;

	const countResult = await countSessions(env.DB);
	const totalCount = ((countResult as Record<string, unknown>)?.count as number) || 0;
	const now = Math.floor(Date.now() / 1000);

	const result = await getSessionsPage(env.DB, limit, offset);

	const sessions: Record<string, unknown>[] = result.map(
		(s: Record<string, unknown>) => ({
			id: s.id,
			userAddress: s.user_address,
			provider: s.provider,
			modelId: s.model_id,
			bidId: s.bid_id,
			stake: s.stake,
			openedAt: s.opened_at,
			endsAt: s.ends_at,
			closedAt: s.closed_at,
			closeoutType: s.closeout_type || 0,
			// is_active is the authoritative "not yet closed" flag (see KB-006).
			isActive:
				(s.is_active as number) === 1 && (s.ends_at === 0 || (s.ends_at as number) > now),
			updatedBlock: s.updated_block,
		}),
	);

	const activeResult = await countActiveSessions(env.DB, now);
	const walletResult = await countDistinctSessionWallets(env.DB);
	const totalPages = Math.ceil(totalCount / limit);

	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		total: totalCount,
		active: ((activeResult as Record<string, unknown>)?.count as number) || 0,
		uniqueWallets: ((walletResult as Record<string, unknown>)?.count as number) || 0,
		pagination: { page, limit, totalPages, hasMore: page < totalPages },
		sessions,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const batch = signBatchResponse("blockchain.sessions", sessions, mnemonic);
		if (batch) {
			for (let i = 0; i < sessions.length; i++)
				sessions[i]._receipt = batch.receiptIds[i];
			responseData._provenance = {
				service: "morscan",
				producer: "morscan/sessions",
				receipt_count: batch.receiptIds.length,
				merkle_root: batch.merkleRoot,
			};
		}
		const aggregateReceipt = await signResponse(
			"blockchain.sessions",
			{ endpoint: "/mor/v1/sessions", syncedBlock: lastBlock, page },
			{ total: totalCount, pageSize: sessions.length },
			mnemonic,
			env.DB,
		);
		if (aggregateReceipt)
			responseData._provenance_aggregate = JSON.parse(aggregateReceipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}

// Analytics: sessions grouped by wallet - reads from precomputed wallet_stats.
export async function handleSessionAnalytics(env: Env, headers: Record<string, string>) {
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);

	const walletStats = await getWalletStatsOrdered(env.DB);

	const wallets = walletStats.map((w: Record<string, unknown>) => ({
		wallet: w.wallet,
		totalSessions: w.total_sessions,
		activeSessions: w.active_sessions,
		closedSessions: w.closed_sessions,
		claimableSessions: w.claimable_sessions || 0,
		activeStakeMor: (Number(w.active_stake_wei || 0) / 1e18).toFixed(4),
		claimableStakeMor: (Number(w.claimable_stake_wei || 0) / 1e18).toFixed(4),
		totalHistoricalMor: (Number(w.total_historical_wei || 0) / 1e18).toFixed(4),
		firstSession: w.first_session,
		lastSession: w.last_session,
		avgDurationMin: w.avg_duration_sec
			? Math.round((w.avg_duration_sec as number) / 60)
			: null,
	}));

	const totalSessions = wallets.reduce((sum, w) => sum + (w.totalSessions as number), 0);
	const totalActive = wallets.reduce((sum, w) => sum + (w.activeSessions as number), 0);
	const totalClaimable = wallets.reduce(
		(sum, w) => sum + (w.claimableSessions as number),
		0,
	);
	const activeStake = wallets.reduce((sum, w) => sum + parseFloat(w.activeStakeMor), 0);
	const claimableStake = wallets.reduce(
		(sum, w) => sum + parseFloat(w.claimableStakeMor),
		0,
	);

	return new Response(
		JSON.stringify({
			...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
			summary: {
				totalWallets: wallets.length,
				totalSessions,
				activeSessions: totalActive,
				claimableSessions: totalClaimable,
				activeStakeMor: activeStake.toFixed(4),
				claimableStakeMor: claimableStake.toFixed(4),
			},
			wallets,
		}),
		{ headers },
	);
}

export async function handleWalletSessions(
	env: Env,
	wallet: string,
	headers: Record<string, string>,
) {
	const { lastBlock, currentBlock, lastSyncTs } = await getSyncState(env);

	const result = await getWalletSessionsByBlock(env.DB, wallet.toLowerCase());
	const now = Math.floor(Date.now() / 1000);
	const sessions = result.map((s: Record<string, unknown>) => ({
		id: s.id,
		userAddress: s.user_address,
		provider: s.provider,
		modelId: s.model_id,
		bidId: s.bid_id,
		stake: s.stake,
		openedAt: s.opened_at,
		endsAt: s.ends_at,
		closedAt: s.closed_at,
		closeoutType: s.closeout_type || 0,
		isActive:
			(s.is_active as number) === 1 && (s.ends_at === 0 || (s.ends_at as number) > now),
		updatedBlock: s.updated_block,
	}));
	const active = sessions.filter((s) => s.isActive).length;

	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock, undefined, lastSyncTs),
		wallet,
		source: "db",
		total: sessions.length,
		active,
		sessions,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const receipt = await signResponse(
			"blockchain.wallet_sessions",
			{ endpoint: `/mor/v1/sessions/${wallet}`, syncedBlock: lastBlock },
			{ total: sessions.length, active },
			mnemonic,
			env.DB,
		);
		if (receipt) responseData._provenance = JSON.parse(receipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}
