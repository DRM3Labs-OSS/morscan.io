/**
 * Sync - event-driven projector
 *
 * 2026-04-27: REWRITTEN. The old block-receipt projector called eth_getBlockReceipts
 * for every single block (181K RPC calls to catch up 4 days). This version uses
 * eth_getLogs to fetch ONLY Diamond events across the entire gap in 1-2 RPC calls.
 *
 * Old: 181,000 blocks × 2 RPC calls/block = 362,000 calls, 25 hours, $500+ in D1
 * New: 1 eth_getLogs call = 2,202 events, <1 second, ~2,200 D1 writes
 *
 * Architecture:
 *   1. eth_getLogs(fromBlock, toBlock, Diamond address) → all Diamond events
 *   2. eth_getLogs(fromBlock, toBlock, MOR token, Transfer topic) → holder tracking
 *   3. Enrich SessionOpened events via batch getSession + getBid (same as before)
 *   4. Write to D1, advance cursor
 *
 * Cost: 2 eth_getLogs + N batch RPC calls for enrichment per tick.
 * On a quiet network (few events per tick), this is 2-3 RPC calls total.
 * During catchup, one tick can process thousands of events in seconds.
 *
 * Free RPCs support eth_getLogs with large block ranges. Alchemy also supports it.
 * No alchemy_getTransactionReceipts needed. No per-block receipt fetching.
 */

import { type Env, EVENTS } from "../types";
import { SELECTORS } from "./parsers";
import { type LogEntry, getEndpoints, rpc } from "./compute-rpc";
import {
	ensureWalletStatsSchema,
	refreshWalletStats,
	rebuildAllWalletStats,
	refreshProviderStats,
	ensureDiamondUpgradesTable,
} from "./compute-stats";
import {
	type ComputeCtx,
	MOR_TOKEN,
	processSessionOpened,
	processSessionClosed,
	processBidPosted,
	processBidRetracted,
	processDiamondCut,
	processMorTransfers,
} from "./compute-events";
import { processProviderDiscovery } from "./compute-discovery";
import { hasSessionErrors, isStall, planSyncRange, shouldAdvanceCursor } from "./plan";
import {
	setSyncState,
	setSyncStateStmt,
	countWalletStats,
	upsertNetworkEconomics,
	insertEconomicsHistory,
} from "../db/sync";
import { getSyncStateValue } from "../db/ops";

// Confirmation buffer + max range now live in ./plan (the pure decision layer).

export interface SyncResult {
	fromBlock: number;
	toBlock: number;
	blocksProcessed: number;
	sessionsOpened: number;
	sessionsClosed: number;
	bidsCreated: number;
	bidsRetracted: number;
	morTransfers: number;
	diamondCuts: number;
	errors: string[];
	durationMs: number;
}

/**
 * Main sync entry point. Uses eth_getLogs to fetch Diamond + MOR events
 * across the entire block range, then enriches and writes to D1.
 *
 * One tick can catch up thousands of blocks because eth_getLogs returns
 * only the relevant events, not every block's full receipts.
 */
export async function sync(env: Env): Promise<SyncResult> {
	const startTime = Date.now();
	await ensureWalletStatsSchema(env);
	await ensureDiamondUpgradesTable(env);
	const errors: string[] = [];

	const rpcUrl = env.RPC_URL;
	const alchemy = env.ALCHEMY_FALLBACK_URL;

	const currentBlock = parseInt(
		(await rpc(rpcUrl, "eth_blockNumber", [], alchemy)) as string,
		16,
	);
	// Persist chain head so /health can read it without RPC
	await setSyncState(env.DB, "current_block", currentBlock.toString());

	const lastRow = await getSyncStateValue(env.DB, "last_event_block");
	const lastEventBlock = lastRow ? parseInt(lastRow.value, 10) : 0;

	// Plan this tick's range: confirmation buffer, cold-start fallback, and the
	// per-tick range cap all live in the pure planner (see ./plan).
	const { fromBlock, toBlock, gap, upToDate } = planSyncRange(
		lastEventBlock,
		currentBlock,
	);

	if (upToDate) {
		return {
			fromBlock,
			toBlock,
			blocksProcessed: 0,
			sessionsOpened: 0,
			sessionsClosed: 0,
			bidsCreated: 0,
			bidsRetracted: 0,
			morTransfers: 0,
			diamondCuts: 0,
			errors: [],
			durationMs: Date.now() - startTime,
		};
	}

	const affectedWallets = new Set<string>();
	const affectedPairs = new Set<string>();

	const ctx: ComputeCtx = { errors, affectedWallets, affectedPairs };

	// --- Fetch Diamond events via eth_getLogs ---
	const diamondTopics = [
		EVENTS.SESSION_OPENED,
		EVENTS.SESSION_CLOSED,
		EVENTS.BID_POSTED,
		EVENTS.BID_RETRACTED,
		EVENTS.DIAMOND_CUT,
	];

	// Gap-proof: a failed fetch must NEVER let the cursor advance past its range.
	// Track fetch failures explicitly instead of pattern-matching error strings.
	let fetchFailed = false;

	let diamondLogs: LogEntry[] = [];
	try {
		const result = await rpc(
			rpcUrl,
			"eth_getLogs",
			[
				{
					fromBlock: `0x${fromBlock.toString(16)}`,
					toBlock: `0x${toBlock.toString(16)}`,
					address: env.DIAMOND_ADDRESS,
					topics: [diamondTopics],
				},
			],
			alchemy,
		);
		diamondLogs = (result as LogEntry[]) || [];
	} catch (e) {
		fetchFailed = true;
		errors.push(`eth_getLogs Diamond: ${e instanceof Error ? e.message : e}`);
		console.error(
			`[sync] Diamond getLogs FAILED for ${fromBlock}-${toBlock} - refusing to advance cursor: ${e instanceof Error ? e.message : e}`,
		);
	}

	// --- Fetch MOR Transfer events via eth_getLogs ---
	let morLogs: LogEntry[] = [];
	try {
		const result = await rpc(
			rpcUrl,
			"eth_getLogs",
			[
				{
					fromBlock: `0x${fromBlock.toString(16)}`,
					toBlock: `0x${toBlock.toString(16)}`,
					address: MOR_TOKEN,
					topics: [EVENTS.ERC721_TRANSFER],
				},
			],
			alchemy,
		);
		morLogs = (result as LogEntry[]) || [];
	} catch (e) {
		fetchFailed = true;
		errors.push(`eth_getLogs MOR: ${e instanceof Error ? e.message : e}`);
		console.error(
			`[sync] MOR getLogs FAILED for ${fromBlock}-${toBlock} - refusing to advance cursor: ${e instanceof Error ? e.message : e}`,
		);
	}

	// --- Process Diamond events ---
	const opened = diamondLogs.filter(
		(l) => l.topics[0]?.toLowerCase() === EVENTS.SESSION_OPENED.toLowerCase(),
	);
	const closed = diamondLogs.filter(
		(l) => l.topics[0]?.toLowerCase() === EVENTS.SESSION_CLOSED.toLowerCase(),
	);
	const bidPosted = diamondLogs.filter(
		(l) => l.topics[0]?.toLowerCase() === EVENTS.BID_POSTED.toLowerCase(),
	);
	const bidRetracted = diamondLogs.filter(
		(l) => l.topics[0]?.toLowerCase() === EVENTS.BID_RETRACTED.toLowerCase(),
	);
	const cutLogs = diamondLogs.filter(
		(l) => l.topics[0]?.toLowerCase() === EVENTS.DIAMOND_CUT?.toLowerCase(),
	);

	// Same call order, DB write order and batching as the original inline blocks.
	const sessionsOpened = await processSessionOpened(env, opened, rpcUrl, alchemy, ctx);
	const sessionsClosed = await processSessionClosed(env, closed, ctx);
	let bidsCreated = await processBidPosted(env, bidPosted, rpcUrl, alchemy, ctx);
	const bidsRetracted = await processBidRetracted(env, bidRetracted);
	const diamondCuts = await processDiamondCut(env, cutLogs);
	// Discovery runs after the per-event processors (as before) and its newly
	// discovered bids add to this tick's bid count.
	bidsCreated += await processProviderDiscovery(env, rpcUrl, alchemy, toBlock, ctx);
	const morTransfers = await processMorTransfers(env, morLogs);

	const blocksProcessed = gap;

	// Incremental wallet_stats + provider_stats
	// If wallet_stats is empty (fresh schema migration), do a full rebuild once
	try {
		const wsCount = await countWalletStats(env.DB);
		if (!wsCount || wsCount.c === 0) {
			await rebuildAllWalletStats(env);
		} else if (affectedWallets.size > 0) {
			await refreshWalletStats(env, [...affectedWallets]);
		}
	} catch (_) {}
	if (affectedPairs.size > 0) {
		const pairs = [...affectedPairs].map((k) => {
			const [p, m] = k.split("|");
			return { provider: p, model_id: m };
		});
		try {
			await refreshProviderStats(env, pairs);
		} catch (_) {}
	}

	// Advance cursor - no confirmation buffer games. eth_getLogs already
	// only returns finalized events. The cursor moves to toBlock directly.
	//
	// GAP-PROOF: advance ONLY if BOTH getLogs fetches succeeded (fetchFailed
	// stays false) AND no per-event processor reported a session error. If the
	// Diamond or MOR fetch threw, its logs are [] purely because of an RPC error,
	// not a real absence of events - advancing here would skip real deposits /
	// sessions. Holding the cursor retries this exact range next tick.
	const sessionErrors = hasSessionErrors(errors);
	if (shouldAdvanceCursor(fetchFailed, sessionErrors)) {
		await setSyncState(env.DB, "last_event_block", toBlock.toString());
		await setSyncState(env.DB, "last_block", toBlock.toString());
	} else if (fetchFailed) {
		console.error(
			`[sync] Cursor HELD at ${lastEventBlock} - getLogs fetch failed for ${fromBlock}-${toBlock}`,
		);
	}

	if (isStall(gap, diamondLogs.length, morLogs.length, blocksProcessed)) {
		console.error(
			`[sync] STALL: ${gap} blocks, ${diamondLogs.length} diamond events, ${morLogs.length} MOR events, ${errors.length} errors`,
		);
		if (errors.length > 0)
			console.error(`[sync] errors: ${errors.slice(0, 3).join("; ")}`);
	} else {
		console.log(
			`[sync] ${gap} blocks (${fromBlock}-${toBlock}): ${sessionsOpened} opened, ${sessionsClosed} closed, ${bidsCreated} bids, ${morTransfers} transfers [${Date.now() - startTime}ms]`,
		);
	}

	await setSyncState(env.DB, "last_sync_ts", new Date().toISOString());

	return {
		fromBlock,
		toBlock,
		blocksProcessed,
		sessionsOpened,
		sessionsClosed,
		bidsCreated,
		bidsRetracted,
		morTransfers,
		diamondCuts,
		errors,
		durationMs: Date.now() - startTime,
	};
}

/**
 * Initialize / reset the sync cursor (manual reset via /sync/reset-events?block=N).
 *
 * The LIVE compute projector reads `last_event_block` (see sync() above), so a
 * reset MUST write that key or the cursor never actually moves - the historical
 * bug where reset-events wrote only `last_block` (a health-display mirror) left
 * the projector parked exactly where it was. We write BOTH here:
 *   - `last_event_block` : the real cursor sync() reads and advances.
 *   - `last_block`       : the value /health surfaces as `syncedBlock`, kept in
 *                          lock-step so the health display reflects the reset
 *                          immediately instead of lagging until the next tick.
 *
 * RACE NOTE: the SyncCoordinator DO rewrites `last_event_block` every tick, so a
 * reset while the loop is running gets clobbered. Callers that need the cursor
 * to STICK must stop the DO first (GET /sync/coordinator/stop), reset, then
 * restart (GET /sync/coordinator/start).
 */
export async function initSync(env: Env, startBlock?: number): Promise<void> {
	const block =
		startBlock ||
		parseInt(
			(await rpc(env.RPC_URL, "eth_blockNumber", [], env.ALCHEMY_FALLBACK_URL)) as string,
			16,
		) - 100;
	await env.DB.batch([
		setSyncStateStmt(env.DB, "last_event_block", block.toString()),
		setSyncStateStmt(env.DB, "last_block", block.toString()),
	]);
}

/** Economics sync - standalone function */
export async function syncEconomics(env: Env): Promise<void> {
	const timestamp = Math.floor(Date.now() / 1000);
	const tsHex = timestamp.toString(16).padStart(64, "0");
	const _endpoints = getEndpoints(env);

	try {
		const [computeResult, supplyResult] = await Promise.all([
			rpc(
				env.RPC_URL,
				"eth_call",
				[
					{ to: env.DIAMOND_ADDRESS, data: SELECTORS.getComputeBalance + tsHex },
					"latest",
				],
				env.ALCHEMY_FALLBACK_URL,
			),
			rpc(
				env.RPC_URL,
				"eth_call",
				[{ to: env.DIAMOND_ADDRESS, data: SELECTORS.totalMORSupply + tsHex }, "latest"],
				env.ALCHEMY_FALLBACK_URL,
			),
		]);

		const computeBalance = computeResult ? BigInt(computeResult as string) : 0n;
		const totalSupply = supplyResult ? BigInt(supplyResult as string) : 0n;
		const stakingFactor =
			totalSupply > 0n
				? Number((computeBalance * 10000n) / (totalSupply * 100n)) / 10000
				: 0;

		await upsertNetworkEconomics(
			env.DB,
			computeBalance.toString(),
			totalSupply.toString(),
			stakingFactor,
			timestamp,
		);

		// Daily snapshot
		const today = new Date().toISOString().slice(0, 10);
		await insertEconomicsHistory(
			env.DB,
			today,
			computeBalance.toString(),
			totalSupply.toString(),
			stakingFactor,
		);
	} catch (e) {
		console.error(`[sync] Economics failed: ${e instanceof Error ? e.message : e}`);
	}
}
