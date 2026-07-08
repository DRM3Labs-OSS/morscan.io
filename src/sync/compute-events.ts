/**
 * Compute sync - per-event-type processors.
 *
 * Extracted from sync() (src/sync/compute.ts) so each Diamond event type and
 * the provider/model discovery pass has a focused processor and the
 * orchestrator stays small. Each processor takes the relevant logs plus a
 * shared context (errors + affected-wallet/pair sets) and returns a count.
 */

import type { Env } from "../types";
import { SELECTORS, parseBidResult, parseSessionResult } from "./parsers";
import { writeBqSafe, sessionRow, bidRow } from "../utils/bigquery";
import { invalidateCfCache } from "../utils/cache";
import { type LogEntry, rpcBatch } from "./compute-rpc";
import { parseDiamondCutData } from "./compute-stats";
import {
	insertSessionStmt,
	getSessionParticipantsByIds,
	closeSessionStmt,
	upsertBidStmt,
	markBidsDeletedStmt,
	insertDiamondUpgradeStmt,
} from "../db/sync";
import {
	upsertMorHolderStmt,
	updateHolderBalancesStmt,
	getStalestHolderWallets,
} from "../db/sync-builder";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";

// balanceOf(address) selector - authoritative current holdings, matches Basescan.
const BALANCE_OF = "0x70a08231";

// Canonical contract deploy blocks live in the dependency-free leaf module so
// /health can read them without importing this (heavy) graph. Re-exported here
// for the backfill + sync callers that already import from compute-events.
export { MOR_DEPLOY_BLOCK, DIAMOND_DEPLOY_BLOCK } from "./holder-coverage";

/** Shared mutable context threaded through the compute event processors. */
export interface ComputeCtx {
	errors: string[];
	affectedWallets: Set<string>;
	affectedPairs: Set<string>;
}

/** SessionOpened: enrich via batch getSession + getBid, then insert. */
export async function processSessionOpened(
	env: Env,
	opened: LogEntry[],
	rpcUrl: string,
	alchemy: string | undefined,
	ctx: ComputeCtx,
): Promise<number> {
	if (opened.length === 0) return 0;
	let sessionsOpened = 0;
	const sessionIds = opened.filter((l) => l.topics.length >= 3).map((l) => l.topics[2]);
	const sessionCalls = sessionIds.map((id) => ({
		method: "eth_call",
		params: [
			{ to: env.DIAMOND_ADDRESS, data: SELECTORS.getSession + id.replace("0x", "") },
			"latest",
		],
	}));

	try {
		const sessionResults = await rpcBatch(rpcUrl, sessionCalls, alchemy);

		const bidIdsNeeded: string[] = [];
		const parsedSessions: Array<ReturnType<typeof parseSessionResult>> = [];
		for (const r of sessionResults) {
			const parsed = r ? parseSessionResult(r as string) : null;
			parsedSessions.push(parsed);
			if (parsed?.bidId) bidIdsNeeded.push(parsed.bidId);
		}

		const uniqueBids = [...new Set(bidIdsNeeded)];
		const bidMap = new Map<string, { provider: string; modelId: string }>();
		if (uniqueBids.length > 0) {
			const bidCalls = uniqueBids.map((id) => ({
				method: "eth_call",
				params: [
					{
						to: env.DIAMOND_ADDRESS,
						data: SELECTORS.getBid + id.replace("0x", "").padStart(64, "0"),
					},
					"latest",
				],
			}));
			const bidResults = await rpcBatch(rpcUrl, bidCalls, alchemy);
			for (let i = 0; i < uniqueBids.length; i++) {
				const bid = bidResults[i] ? parseBidResult(bidResults[i] as string) : null;
				if (bid)
					bidMap.set(uniqueBids[i].toLowerCase(), {
						provider: bid.provider,
						modelId: bid.modelId,
					});
			}
		}

		const inserts: D1PreparedStatement[] = [];
		const bqRows: ReturnType<typeof sessionRow>[] = [];
		for (let i = 0; i < sessionIds.length; i++) {
			const session = parsedSessions[i];
			if (!session) {
				ctx.errors.push(`SessionOpened: null session ${sessionIds[i].slice(0, 18)}`);
				continue;
			}
			const bid = bidMap.get(session.bidId.toLowerCase());
			const id = sessionIds[i].toLowerCase();
			const provider = bid?.provider?.toLowerCase() || "";
			const modelId = bid?.modelId?.toLowerCase() || "";
			const blockNum = parseInt(opened[i].blockNumber, 16);

			ctx.affectedWallets.add(session.user.toLowerCase());
			if (provider && modelId) ctx.affectedPairs.add(`${provider}|${modelId}`);

			inserts.push(
				insertSessionStmt(
					env.DB,
					id,
					session.user.toLowerCase(),
					session.bidId.toLowerCase(),
					provider,
					modelId,
					session.stake,
					session.openedAt,
					session.endsAt,
					blockNum,
					opened[i].transactionHash,
				),
			);

			bqRows.push(
				sessionRow({
					id,
					user_address: session.user.toLowerCase(),
					bid_id: session.bidId.toLowerCase(),
					provider,
					model_id: modelId,
					stake: session.stake,
					opened_at: session.openedAt,
					ends_at: session.endsAt,
					closed_at: null,
					is_active: 1,
					updated_block: blockNum,
					open_tx_hash: opened[i].transactionHash,
				}),
			);
			sessionsOpened++;
			console.log(
				`[sync] OPEN  ${id.slice(0, 18)}... user=${session.user.slice(0, 12)}... stake=${(Number(BigInt(session.stake)) / 1e18).toFixed(2)} MOR`,
			);
		}
		if (inserts.length > 0) {
			for (let i = 0; i < inserts.length; i += 100) {
				try {
					await env.DB.batch(inserts.slice(i, i + 100));
				} catch (e) {
					ctx.errors.push(
						`SessionOpened D1 batch: ${e instanceof Error ? e.message : e}`,
					);
				}
			}
		}
		if (bqRows.length > 0) await writeBqSafe(env, "sessions", bqRows);
		const openedProviders = [...ctx.affectedPairs]
			.map((k) => k.split("|")[0])
			.filter(Boolean);
		if (openedProviders.length > 0) {
			await invalidateCfCache(
				[...new Set(openedProviders)].map((p) => `v1:providers:${p}`),
			);
		}
	} catch (e) {
		ctx.errors.push(`SessionOpened enrichment: ${e instanceof Error ? e.message : e}`);
	}
	return sessionsOpened;
}

/** SessionClosed: mark sessions inactive. */
export async function processSessionClosed(
	env: Env,
	closed: LogEntry[],
	ctx: ComputeCtx,
): Promise<number> {
	if (closed.length === 0) return 0;
	let sessionsClosed = 0;
	const closedIds = closed
		.filter((l) => l.topics.length >= 3)
		.map((l) => l.topics[2].toLowerCase());
	if (closedIds.length > 0) {
		try {
			const rows = await getSessionParticipantsByIds(env.DB, closedIds);
			for (const row of rows) {
				if (row.user_address) ctx.affectedWallets.add(row.user_address);
				if (row.provider && row.model_id)
					ctx.affectedPairs.add(`${row.provider}|${row.model_id}`);
			}
		} catch {}
	}

	const updates: D1PreparedStatement[] = [];
	for (const log of closed) {
		if (log.topics.length < 3) continue;
		const sessionId = log.topics[2].toLowerCase();
		const blockNum = parseInt(log.blockNumber, 16);
		const blockTimestamp = Math.floor(Date.now() / 1000); // Approximate - no per-block timestamp in eth_getLogs
		updates.push(
			closeSessionStmt(env.DB, blockTimestamp, blockNum, log.transactionHash, sessionId),
		);
		sessionsClosed++;
		console.log(`[sync] CLOSE ${sessionId.slice(0, 18)}...`);
	}
	for (let i = 0; i < updates.length; i += 100) {
		try {
			await env.DB.batch(updates.slice(i, i + 100));
		} catch (e) {
			ctx.errors.push(`SessionClosed D1 batch: ${e instanceof Error ? e.message : e}`);
		}
	}
	return sessionsClosed;
}

/** MarketplaceBidPosted: derive bidId via getBidId, enrich via getBid, then insert.
 *
 * MarketplaceBidPosted(address indexed provider, bytes32 indexed modelId, uint256 nonce)
 * carries no bid id - bids are keyed by (provider, modelId, nonce), so the id
 * comes from getBidId on the Diamond. */
export async function processBidPosted(
	env: Env,
	bidPosted: LogEntry[],
	rpcUrl: string,
	alchemy: string | undefined,
	ctx: ComputeCtx,
): Promise<number> {
	if (bidPosted.length === 0) return 0;
	let bidsCreated = 0;
	const posted = bidPosted.filter(
		(l) => l.topics.length >= 3 && l.data && l.data.length >= 66,
	);
	if (posted.length === 0) return 0;
	const newBidIds: string[] = [];
	try {
		const idCalls = posted.map((l) => ({
			method: "eth_call",
			params: [
				{
					to: env.DIAMOND_ADDRESS,
					data:
						SELECTORS.getBidId +
						l.topics[1].slice(2).padStart(64, "0") +
						l.topics[2].slice(2) +
						l.data.slice(2, 66),
				},
				"latest",
			],
		}));
		const idResults = await rpcBatch(rpcUrl, idCalls, alchemy);
		for (const r of idResults) {
			newBidIds.push(
				typeof r === "string" && r.length >= 66 ? `0x${r.slice(2, 66)}` : "",
			);
		}
	} catch (e) {
		ctx.errors.push(`BidPosted getBidId: ${e instanceof Error ? e.message : e}`);
		return 0;
	}
	if (!newBidIds.some(Boolean)) return 0;
	try {
		const bidCalls = newBidIds.map((id) => ({
			method: "eth_call",
			params: [
				{
					to: env.DIAMOND_ADDRESS,
					data: SELECTORS.getBid + id.replace("0x", "").padStart(64, "0"),
				},
				"latest",
			],
		}));
		const bidResults = await rpcBatch(rpcUrl, bidCalls, alchemy);
		const inserts: D1PreparedStatement[] = [];
		const bqRows: ReturnType<typeof bidRow>[] = [];
		for (let i = 0; i < newBidIds.length; i++) {
			const bid = bidResults[i] ? parseBidResult(bidResults[i] as string) : null;
			if (!bid) continue;
			const bidId = newBidIds[i].toLowerCase();
			const blockNum = parseInt(bidPosted[i].blockNumber, 16);
			inserts.push(
				upsertBidStmt(
					env.DB,
					bidId,
					bid.provider.toLowerCase(),
					bid.modelId.toLowerCase(),
					bid.pricePerSecond,
					bid.nonce,
					bid.createdAt,
					bid.deletedAt,
					blockNum,
				),
			);
			bqRows.push(
				bidRow({
					bid_id: bidId,
					provider: bid.provider.toLowerCase(),
					model_id: bid.modelId.toLowerCase(),
					price_per_second: bid.pricePerSecond,
					nonce: bid.nonce,
					created_at: bid.createdAt,
					deleted_at: bid.deletedAt,
					updated_block: blockNum,
				}),
			);
			bidsCreated++;
		}
		if (inserts.length > 0) await env.DB.batch(inserts);
		if (bqRows.length > 0) await writeBqSafe(env, "bids", bqRows);
	} catch (e) {
		ctx.errors.push(`BidPosted enrichment: ${e instanceof Error ? e.message : e}`);
	}
	return bidsCreated;
}

/** BidRetracted: soft-delete matching bids. */
export async function processBidRetracted(
	env: Env,
	bidRetracted: LogEntry[],
): Promise<number> {
	if (bidRetracted.length === 0) return 0;
	let bidsRetracted = 0;
	const updates: D1PreparedStatement[] = [];
	for (const log of bidRetracted) {
		if (log.topics.length < 3) continue;
		const provider = `0x${log.topics[1]?.slice(26)}`.toLowerCase();
		const modelId = `0x${log.topics[2]?.slice(2)}`.toLowerCase();
		const blockNum = parseInt(log.blockNumber, 16);
		const blockTimestamp = Math.floor(Date.now() / 1000);
		updates.push(
			markBidsDeletedStmt(env.DB, blockTimestamp, blockNum, provider, modelId),
		);
		bidsRetracted++;
	}
	if (updates.length > 0) await env.DB.batch(updates);
	return bidsRetracted;
}

/** DiamondCut: record EIP-2535 facet upgrades. */
export async function processDiamondCut(env: Env, cutLogs: LogEntry[]): Promise<number> {
	if (cutLogs.length === 0) return 0;
	let diamondCuts = 0;
	const inserts: D1PreparedStatement[] = [];
	for (const log of cutLogs) {
		const blockNum = parseInt(log.blockNumber, 16);
		const facetChanges = parseDiamondCutData(log.data);
		inserts.push(
			insertDiamondUpgradeStmt(
				env.DB,
				blockNum,
				log.transactionHash,
				parseInt(log.logIndex, 16),
				JSON.stringify(facetChanges),
				facetChanges.length,
				Math.floor(Date.now() / 1000),
			),
		);
		diamondCuts++;
		console.log(
			`[sync] DIAMOND UPGRADE block=${blockNum} tx=${log.transactionHash.slice(0, 18)}...`,
		);
	}
	if (inserts.length > 0) await env.DB.batch(inserts);
	return diamondCuts;
}

/**
 * MOR Token Transfers - holder DISCOVERY.
 *
 * This records WHICH wallets have ever touched MOR (wallet + last_transfer_block),
 * inserting new wallets with updated_at = 0 meaning "discovered, balance not yet
 * computed". It deliberately does NOT net a balance from the transfer value:
 * netting is only correct if every transfer is processed exactly once over the
 * full history with a zeroed start, which a throttled/resumable free-tier
 * re-scan cannot guarantee (a partial or re-run range silently corrupts the
 * balance). The authoritative balance is computed separately and idempotently by
 * refreshHolderBalances() below via balanceOf(latest) - which always equals what
 * Basescan shows, regardless of how far discovery has progressed.
 *
 * When a `discovered` set is passed, every wallet seen is added to it so the
 * caller (the historical backfill) can immediately balance-refresh the wallets
 * this pass surfaced.
 */
export async function processMorTransfers(
	env: Env,
	morLogs: LogEntry[],
	discovered?: Set<string>,
): Promise<number> {
	if (morLogs.length === 0) return 0;
	let morTransfers = 0;
	const inserts: D1PreparedStatement[] = [];
	const upsert = (wallet: string, blockNum: number) => {
		if (discovered) discovered.add(wallet);
		return upsertMorHolderStmt(env.DB, wallet, blockNum);
	};
	for (const log of morLogs) {
		if (log.topics.length < 3) continue;
		const from = `0x${log.topics[1].slice(26).toLowerCase()}`;
		const to = `0x${log.topics[2].slice(26).toLowerCase()}`;
		const blockNum = parseInt(log.blockNumber, 16);
		if (from !== ZERO_ADDRESS) inserts.push(upsert(from, blockNum));
		if (to !== ZERO_ADDRESS) inserts.push(upsert(to, blockNum));
		morTransfers++;
	}
	for (let i = 0; i < inserts.length; i += 100) {
		try {
			await env.DB.batch(inserts.slice(i, i + 100));
		} catch {}
	}
	return morTransfers;
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Compute EXACT current balances for the given wallets via balanceOf(latest) +
 * eth_getBalance and write them to mor_holders, stamping updated_at = now.
 *
 * This is the honest, Basescan-matching balance source: balanceOf at head is the
 * real on-chain holding, so a wallet refreshed here is correct immediately and
 * independently of every other wallet. It is fully idempotent - re-running only
 * re-reads current state - so it is safe under throttled/resumable sweeps on the
 * free RPC tier. A wallet whose RPC read fails is SKIPPED (its stale/zero row is
 * left untouched) rather than written as a false zero.
 */
export async function refreshHolderBalances(
	env: Env,
	wallets: string[],
	delayMs = 150,
): Promise<number> {
	if (wallets.length === 0) return 0;
	const now = Math.floor(Date.now() / 1000);
	let updated = 0;
	const BATCH = 25; // wallets per RPC round (2 sub-calls each = 50 JSON-RPC calls)
	for (let i = 0; i < wallets.length; i += BATCH) {
		const slice = wallets.slice(i, i + BATCH);
		const calls: Array<{ method: string; params: unknown[] }> = [];
		for (const w of slice) {
			const padded = w.toLowerCase().replace("0x", "").padStart(64, "0");
			calls.push({
				method: "eth_call",
				params: [{ to: MOR_TOKEN, data: BALANCE_OF + padded }, "latest"],
			});
			calls.push({ method: "eth_getBalance", params: [w, "latest"] });
		}
		let results: unknown[];
		try {
			results = await rpcBatch(env.RPC_URL, calls, env.ALCHEMY_FALLBACK_URL);
		} catch {
			continue;
		}
		const updates: D1PreparedStatement[] = [];
		for (let j = 0; j < slice.length; j++) {
			const morRes = results[j * 2] as string | undefined;
			const ethRes = results[j * 2 + 1] as string | undefined;
			// undefined => the RPC did not return this call: skip, do not write a
			// false zero. A real zero balance comes back as 0x000...0 (not 0x/undef).
			if (morRes === undefined) continue;
			const morWei = morRes && morRes !== "0x" ? BigInt(morRes).toString() : "0";
			const ethWei = ethRes && ethRes !== "0x" ? BigInt(ethRes).toString() : "0";
			updates.push(
				updateHolderBalancesStmt(env.DB, morWei, ethWei, now, slice[j].toLowerCase()),
			);
			updated++;
		}
		for (let k = 0; k < updates.length; k += 100) {
			try {
				await env.DB.batch(updates.slice(k, k + 100));
			} catch {}
		}
		if (i + BATCH < wallets.length && delayMs > 0) await sleepMs(delayMs);
	}
	return updated;
}

/**
 * Refresh the `limit` stalest holders (updated_at ASC, so never-computed
 * wallets - updated_at = 0 - come first, then the oldest refreshes). Repeatable
 * and resumable: each call advances the sweep and moves refreshed wallets to the
 * back of the queue. Returns how many were picked vs actually written.
 */
export async function refreshStaleHolderBalances(
	env: Env,
	limit: number,
): Promise<{ picked: number; updated: number }> {
	const rows = await getStalestHolderWallets(env.DB, limit);
	const wallets = rows.map((r) => r.wallet);
	const updated = await refreshHolderBalances(env, wallets);
	return { picked: wallets.length, updated };
}

export { MOR_TOKEN };
