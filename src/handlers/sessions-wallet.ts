/**
 * Session Handlers - per-wallet transaction history, detail, and audit.
 */

import type { Env } from "../types";
import { getSyncState, buildMeta } from "../utils/rpc";
import { getModelIdNames, getNamedModelIdNames } from "../db/explorer-market";
import { getWalletSessionHistory } from "../db/explorer-sessions";

// Wallet transaction history - every open, close, dispute, reclaim event.
export async function handleWalletTransactions(
	env: Env,
	wallet: string,
	headers: Record<string, string>,
) {
	const { lastBlock, currentBlock, lastSyncTs } = await getSyncState(env);
	const now = Math.floor(Date.now() / 1000);

	const result = await getWalletSessionHistory(env.DB, wallet.toLowerCase());

	const modelResult = await getModelIdNames(env.DB);
	const modelNames: Record<string, string> = {};
	for (const m of modelResult) {
		modelNames[(m.model_id as string)?.toLowerCase()] = m.name as string;
	}

	const transactions: Record<string, unknown>[] = [];

	for (const s of result) {
		const stakeWei = BigInt((s.stake as string) || "0");
		const stakeMor = (Number(stakeWei) / 1e18).toFixed(4);
		const modelName = modelNames[(s.model_id as string)?.toLowerCase()] || null;

		transactions.push({
			type: "open",
			sessionId: s.id,
			provider: s.provider,
			modelId: s.model_id,
			modelName,
			stake: s.stake,
			stakeMor,
			timestamp: s.opened_at,
			block: s.updated_block,
		});

		if (s.closed_at && (s.closed_at as number) > 0) {
			const closeType = s.closeout_type === 1 ? "dispute" : "close";
			transactions.push({
				type: closeType,
				sessionId: s.id,
				provider: s.provider,
				modelId: s.model_id,
				modelName,
				stake: s.stake,
				stakeMor,
				timestamp: s.closed_at,
				block: s.updated_block,
			});
		} else if (
			s.is_active === 1 &&
			(s.ends_at as number) > 0 &&
			(s.ends_at as number) < now
		) {
			transactions.push({
				type: "expired",
				sessionId: s.id,
				provider: s.provider,
				modelId: s.model_id,
				modelName,
				stake: s.stake,
				stakeMor,
				timestamp: s.ends_at,
				block: s.updated_block,
			});
		}
	}

	transactions.sort((a, b) => (b.timestamp as number) - (a.timestamp as number));

	return new Response(
		JSON.stringify({
			...buildMeta(lastBlock, currentBlock, undefined, lastSyncTs),
			wallet: wallet.toLowerCase(),
			total: transactions.length,
			transactions,
		}),
		{ headers },
	);
}

// Wallet detail page - reads from the canonical accounting module.
export async function handleWalletDetail(
	env: Env,
	wallet: string,
	headers: Record<string, string>,
) {
	const { buildWalletAccounting } = await import("../accounting");
	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);

	const acct = await buildWalletAccounting(env, wallet);

	const modelRows = await getNamedModelIdNames(env.DB);
	const modelNames: Record<string, string> = {};
	for (const m of modelRows) {
		if (m.model_id && m.name) modelNames[m.model_id as string] = m.name as string;
	}

	const formatSession = (s: (typeof acct.sessions)[0]) => ({
		id: s.id,
		provider: s.provider,
		modelId: s.model_id,
		modelName: modelNames[s.model_id] || null,
		bidId: s.bid_id,
		stake: s.stake,
		stakeMor: (Number(BigInt(s.stake)) / 1e18).toFixed(4),
		openedAt: s.opened_at,
		endsAt: s.ends_at,
		closedAt: s.closed_at,
		isActive: s.state === "active_open",
		isClaimable: s.state === "expired_open",
		state: s.state,
	});

	const activeSessions = acct.sessions
		.filter((s) => s.state === "active_open")
		.map(formatSession);
	const claimableSessions = acct.sessions
		.filter((s) => s.state === "expired_open")
		.map(formatSession);
	const closedSessions = acct.sessions
		.filter((s) => s.state === "closed" || s.state === "hold_withdrawable")
		.map(formatSession);
	const providers = [...new Set(acct.sessions.map((s) => s.provider))];

	return new Response(
		JSON.stringify({
			...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
			wallet: acct.wallet,
			accounting: acct,
			balances: {
				morBalance: acct.wallet_mor,
				morBalanceWei: acct.wallet_mor_wei,
				ethBalance: acct.eth_balance,
				ethBalanceWei: acct.eth_balance_wei,
			},
			stakesOnHold: acct.stakes_on_hold,
			stake: {
				active: acct.staked_mor,
				activeWei: acct.staked_mor_wei,
				claimable: acct.reclaimable_mor,
				claimableWei: acct.reclaimable_mor_wei,
				locked: acct.locked_mor,
				lockedWei: acct.locked_mor_wei,
				totalHistorical: acct.total_mor,
				totalHistoricalWei: acct.total_mor_wei,
			},
			counts: {
				total: acct.counts.total,
				active: acct.counts.active_open,
				claimable: acct.counts.expired_open,
				closed: acct.counts.closed,
			},
			partial: acct.partial,
			providers: providers.length,
			providerList: providers,
			activeSessions,
			claimableSessions: claimableSessions.slice(0, 50),
			recentClosed: closedSessions.slice(0, 20),
		}),
		{ headers },
	);
}

// Audit endpoint - canonical accounting for any wallet, plaintext.
export async function handleWalletAudit(
	env: Env,
	wallet: string,
	headers: Record<string, string>,
) {
	const { buildWalletAccounting, formatAudit } = await import("../accounting");
	const acct = await buildWalletAccounting(env, wallet);
	return new Response(formatAudit(acct), {
		headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
	});
}
