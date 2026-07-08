/**
 * Historical backfill - throttled archive-RPC re-scan.
 *
 * WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM THE LIVE CURSOR
 * ===========================================================
 * The live projector (src/sync/compute.ts `sync()`) walks forward from
 * `last_event_block` toward chain head, driven by the SyncCoordinator DO. That
 * cursor is the site's freshness. You must NEVER rewind it to backfill history:
 * a naive rewind parks the live site in the past (the incident where the site
 * showed an error for ~40 min while the cursor was 400k blocks behind), and on a
 * FREE PUBLIC RPC the large historical getLogs simply fails and the gap-proof
 * loop refuses to skip, so it stalls hard.
 *
 * Instead this is a SEPARATE, self-contained pass. It re-scans an explicit
 * [from, to] historical range in throttled chunks, upserts whatever events it
 * finds with the SAME idempotent processors the live sync uses (INSERT OR
 * REPLACE / OR IGNORE / ON CONFLICT - additive, never deletes), and NEVER writes
 * `last_event_block` / `last_block` / `current_block`. The live forward sync keeps
 * running at head the entire time and the site stays fresh. Backfill != rewinding
 * the cursor.
 *
 * RPC PATH: unlike the live single-call `rpc()` (which prefers the free WASM
 * rpc-pool first), backfill's heavy historical getLogs go straight through
 * `buildEndpoints()` which is ALCHEMY-FIRST. Large historical getLogs ranges
 * need an archive-capable RPC; free public peers fail on them. See
 * docs/DEPENDENCIES.md -> "Historical backfill".
 *
 * THROTTLE: a free Alchemy account has a monthly compute-unit budget and a
 * per-second throughput cap. Backfill is chunked + delayed so it stays well
 * under both and leaves headroom for the live sync. All three knobs are env-
 * configurable (see defaults below).
 */

import { type Env, EVENTS } from "../types";
import { type LogEntry, buildBackfillEndpoints, RPC_TIMEOUT } from "./compute-rpc";
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
import {
	ensureWalletStatsSchema,
	ensureDiamondUpgradesTable,
	refreshWalletStats,
	refreshProviderStats,
} from "./compute-stats";
import { persistBackfillProgress } from "./holder-coverage";
import { ensureMorHoldersUpdatedIndex } from "../db/sync-builder";

// --- Throttle defaults (override via wrangler [vars] / secrets) -------------
// Blocks per getLogs chunk. Smaller = gentler on the RPC, more chunks.
const DEFAULT_CHUNK_BLOCKS = 2000;
// Delay between chunks (ms). Spreads CU spend under the free throughput cap and
// yields the RPC to the live forward sync between chunks.
const DEFAULT_DELAY_MS = 250;
// Hard cap on chunks per HTTP invocation, so one call is bounded (subrequests +
// wall clock). Resume the rest via the returned `nextFrom`.
const DEFAULT_MAX_CHUNKS_PER_RUN = 30;

export interface BackfillResult {
	requestedFrom: number;
	requestedTo: number;
	scannedFrom: number;
	scannedTo: number;
	/** null when the whole [from,to] range was covered; else re-call with from=nextFrom. */
	nextFrom: number | null;
	done: boolean;
	chunksRun: number;
	chunkBlocks: number;
	delayMs: number;
	maxChunksPerRun: number;
	sessionsOpened: number;
	sessionsClosed: number;
	bidsCreated: number;
	bidsRetracted: number;
	diamondCuts: number;
	morTransfers: number;
	errors: string[];
	durationMs: number;
}

function numEnv(v: string | undefined, fallback: number): number {
	if (v === undefined || v === null || v === "") return fallback;
	const n = parseInt(String(v), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * getLogs for the backfill pass. Routes through buildBackfillEndpoints(), which
 * prefers the DEDICATED backfill Alchemy key (BACKFILL_ALCHEMY_URL) so heavy
 * historical getLogs never starve the live sync's ALCHEMY_FALLBACK_URL, then
 * falls back to that live key and finally public peers if the dedicated key errors.
 * Throws on total failure so the caller STOPS rather than silently skipping a
 * range (a skipped range would leave a permanent hole).
 */
async function backfillGetLogs(
	env: Env,
	filter: { fromBlock: string; toBlock: string; address: string; topics: unknown[] },
): Promise<LogEntry[]> {
	const endpoints = buildBackfillEndpoints(env);
	let lastErr: unknown = null;
	for (const url of endpoints) {
		try {
			const resp = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "eth_getLogs",
					id: 1,
					params: [filter],
				}),
				signal: AbortSignal.timeout(RPC_TIMEOUT),
			});
			const data = (await resp.json()) as Record<string, unknown>;
			if (data.error) {
				lastErr = (data.error as Record<string, unknown>).message;
				continue;
			}
			return (data.result as LogEntry[]) || [];
		} catch (e) {
			lastErr = e instanceof Error ? e.message : e;
		}
	}
	throw new Error(
		`backfill getLogs failed for ${filter.fromBlock}-${filter.toBlock}: ${lastErr}`,
	);
}

/**
 * Re-scan [from, to] historical blocks in throttled chunks and upsert any
 * events found. Does NOT touch the live cursor. Bounded per call by
 * BACKFILL_MAX_CHUNKS_PER_RUN; resume with the returned `nextFrom`.
 */
export async function backfillRange(
	env: Env,
	from: number,
	to: number,
): Promise<BackfillResult> {
	const startTime = Date.now();
	await ensureWalletStatsSchema(env);
	await ensureDiamondUpgradesTable(env);

	const chunkBlocks = numEnv(env.BACKFILL_CHUNK_BLOCKS, DEFAULT_CHUNK_BLOCKS);
	const delayMs = numEnv(env.BACKFILL_DELAY_MS, DEFAULT_DELAY_MS);
	const maxChunksPerRun = numEnv(
		env.BACKFILL_MAX_CHUNKS_PER_RUN,
		DEFAULT_MAX_CHUNKS_PER_RUN,
	);

	const errors: string[] = [];
	// Affected sets accumulate across ALL chunks so the aggregate tables
	// (wallet_stats / provider_stats) get refreshed once at the end, not per chunk.
	const affectedWallets = new Set<string>();
	const affectedPairs = new Set<string>();

	const diamondTopics = [
		EVENTS.SESSION_OPENED,
		EVENTS.SESSION_CLOSED,
		EVENTS.BID_POSTED,
		EVENTS.BID_RETRACTED,
		EVENTS.DIAMOND_CUT,
	];

	let sessionsOpened = 0,
		sessionsClosed = 0,
		bidsCreated = 0,
		bidsRetracted = 0,
		diamondCuts = 0,
		morTransfers = 0;
	let cursor = from;
	let chunksRun = 0;

	while (cursor <= to && chunksRun < maxChunksPerRun) {
		const chunkTo = Math.min(cursor + chunkBlocks - 1, to);
		const fromHex = `0x${cursor.toString(16)}`;
		const toHex = `0x${chunkTo.toString(16)}`;

		let diamondLogs: LogEntry[];
		let morLogs: LogEntry[];
		try {
			// Sequential (not parallel) to keep the throughput gentle on the free tier.
			diamondLogs = await backfillGetLogs(env, {
				fromBlock: fromHex,
				toBlock: toHex,
				address: env.DIAMOND_ADDRESS,
				topics: [diamondTopics],
			});
			morLogs = await backfillGetLogs(env, {
				fromBlock: fromHex,
				toBlock: toHex,
				address: MOR_TOKEN,
				topics: [EVENTS.ERC721_TRANSFER],
			});
		} catch (e) {
			// Fetch failed - STOP here rather than skip. The caller can retry from
			// `nextFrom` (which stays at this chunk's start because we did not advance).
			errors.push(`chunk ${cursor}-${chunkTo}: ${e instanceof Error ? e.message : e}`);
			break;
		}

		const ctx: ComputeCtx = { errors, affectedWallets, affectedPairs };
		const opened = diamondLogs.filter(
			(l) => l.topics[0]?.toLowerCase() === EVENTS.SESSION_OPENED.toLowerCase(),
		);
		const closed = diamondLogs.filter(
			(l) => l.topics[0]?.toLowerCase() === EVENTS.SESSION_CLOSED.toLowerCase(),
		);
		const bidPosted = diamondLogs.filter(
			(l) => l.topics[0]?.toLowerCase() === EVENTS.BID_POSTED.toLowerCase(),
		);
		const bidRetractedLogs = diamondLogs.filter(
			(l) => l.topics[0]?.toLowerCase() === EVENTS.BID_RETRACTED.toLowerCase(),
		);
		const cutLogs = diamondLogs.filter(
			(l) => l.topics[0]?.toLowerCase() === EVENTS.DIAMOND_CUT?.toLowerCase(),
		);

		// Same processors + order as the live sync. Idempotent upserts - re-running a
		// range that is already complete is a safe no-op (INSERT OR REPLACE).
		sessionsOpened += await processSessionOpened(
			env,
			opened,
			env.RPC_URL,
			env.ALCHEMY_FALLBACK_URL,
			ctx,
		);
		sessionsClosed += await processSessionClosed(env, closed, ctx);
		bidsCreated += await processBidPosted(
			env,
			bidPosted,
			env.RPC_URL,
			env.ALCHEMY_FALLBACK_URL,
			ctx,
		);
		bidsRetracted += await processBidRetracted(env, bidRetractedLogs);
		diamondCuts += await processDiamondCut(env, cutLogs);
		morTransfers += await processMorTransfers(env, morLogs);

		cursor = chunkTo + 1;
		chunksRun++;

		// Throttle: yield to the live sync + stay under the free CU/s cap.
		if (cursor <= to && chunksRun < maxChunksPerRun && delayMs > 0) await sleep(delayMs);
	}

	// Refresh aggregate tables ONCE for everything this run touched, mirroring the
	// live sync's incremental refresh (leaderboards / provider stats stay correct).
	try {
		if (affectedWallets.size > 0) await refreshWalletStats(env, [...affectedWallets]);
	} catch (e) {
		errors.push(`wallet_stats refresh: ${e instanceof Error ? e.message : e}`);
	}
	try {
		if (affectedPairs.size > 0) {
			const pairs = [...affectedPairs].map((k) => {
				const [p, m] = k.split("|");
				return { provider: p, model_id: m };
			});
			await refreshProviderStats(env, pairs);
		}
	} catch (e) {
		errors.push(`provider_stats refresh: ${e instanceof Error ? e.message : e}`);
	}

	const scannedTo = cursor - 1;
	const done = cursor > to;

	// This generic pass fills sessions AND holders over the SAME range, so it
	// advances the one shared genesis-ward frontier + timing that every dataset's
	// coverage/ETA is derived from. See holder-coverage.ts.
	try {
		await persistBackfillProgress(env, from, scannedTo, Date.now() - startTime);
	} catch (e) {
		errors.push(`timing persist: ${e instanceof Error ? e.message : e}`);
	}

	console.log(
		`[backfill] scanned ${from}-${scannedTo} in ${chunksRun} chunk(s): +${sessionsOpened} opened, +${sessionsClosed} closed, +${bidsCreated} bids, +${morTransfers} transfers${done ? " [DONE]" : ` [more: nextFrom=${cursor}]`} dedicated-key=${env.BACKFILL_ALCHEMY_URL ? "yes" : "no"} [${Date.now() - startTime}ms]`,
	);

	return {
		requestedFrom: from,
		requestedTo: to,
		scannedFrom: from,
		scannedTo,
		nextFrom: done ? null : cursor,
		done,
		chunksRun,
		chunkBlocks,
		delayMs,
		maxChunksPerRun,
		sessionsOpened,
		sessionsClosed,
		bidsCreated,
		bidsRetracted,
		diamondCuts,
		morTransfers,
		errors,
		durationMs: Date.now() - startTime,
	};
}

export interface HolderBackfillResult {
	requestedFrom: number;
	requestedTo: number;
	scannedTo: number;
	/** null when [from,to] was fully covered; else re-call with from=nextFrom. */
	nextFrom: number | null;
	done: boolean;
	chunksRun: number;
	chunkBlocks: number;
	morTransfers: number;
	walletsDiscovered: number;
	/** cumulative campaign progress (persisted, survives across runs). */
	frontier: number;
	blocksDoneTotal: number;
	elapsedMsTotal: number;
	blocksPerSec: number | null;
	errors: string[];
	durationMs: number;
}

/**
 * Holder-history DISCOVERY backfill: MOR Transfer events only, from
 * MOR_DEPLOY_BLOCK forward. This is the honest fix for the undercount - it finds
 * every wallet that ever held MOR, including those that acquired it before the
 * live indexer started and simply held (invisible to the live cursor).
 *
 * It is intentionally cheap (one getLogs per chunk, no per-wallet RPC) so it
 * grinds safely under the free tier and stays well within the Worker subrequest
 * budget. Balances are NOT computed here; the separate, idempotent balanceOf
 * sweep (/sync/holder-balances) does that. Discovery only records which wallets
 * exist (updated_at = 0 until their balance is refreshed).
 *
 * Timing is persisted so the syncing UI and /health can show measured
 * throughput (blocks/sec on the free tier) and an ETA to full coverage. A run
 * that starts at or below MOR_DEPLOY_BLOCK RESETS the campaign timers (fresh
 * measurement); a resume run accumulates onto them.
 */
export async function backfillHolders(
	env: Env,
	from: number,
	to: number,
): Promise<HolderBackfillResult> {
	const startTime = Date.now();
	// Index that makes the "stalest holders first" balance sweep cheap.
	try {
		await ensureMorHoldersUpdatedIndex(env.DB);
	} catch {}

	const chunkBlocks = numEnv(env.BACKFILL_CHUNK_BLOCKS, DEFAULT_CHUNK_BLOCKS);
	const delayMs = numEnv(env.BACKFILL_DELAY_MS, DEFAULT_DELAY_MS);
	const maxChunksPerRun = numEnv(
		env.BACKFILL_MAX_CHUNKS_PER_RUN,
		DEFAULT_MAX_CHUNKS_PER_RUN,
	);

	const errors: string[] = [];
	const discovered = new Set<string>();
	let morTransfers = 0;
	let cursor = from;
	let chunksRun = 0;

	while (cursor <= to && chunksRun < maxChunksPerRun) {
		const chunkTo = Math.min(cursor + chunkBlocks - 1, to);
		const fromHex = `0x${cursor.toString(16)}`;
		const toHex = `0x${chunkTo.toString(16)}`;
		let morLogs: LogEntry[];
		try {
			morLogs = await backfillGetLogs(env, {
				fromBlock: fromHex,
				toBlock: toHex,
				address: MOR_TOKEN,
				topics: [EVENTS.ERC721_TRANSFER],
			});
		} catch (e) {
			// STOP rather than skip - a skipped range leaves a permanent hole.
			errors.push(`chunk ${cursor}-${chunkTo}: ${e instanceof Error ? e.message : e}`);
			break;
		}
		morTransfers += await processMorTransfers(env, morLogs, discovered);
		cursor = chunkTo + 1;
		chunksRun++;
		if (cursor <= to && chunksRun < maxChunksPerRun && delayMs > 0) await sleep(delayMs);
	}

	const scannedTo = cursor - 1;
	const done = cursor > to;
	const durationMs = Date.now() - startTime;

	// Advance the shared genesis-ward frontier + accumulate campaign timing.
	let blocksPerSec: number | null = null;
	let blocksDoneTotal = 0;
	let elapsedMsTotal = 0;
	try {
		const p = await persistBackfillProgress(env, from, scannedTo, durationMs);
		blocksPerSec = p.blocksPerSec;
		blocksDoneTotal = p.blocksDone;
		elapsedMsTotal = p.elapsedMs;
	} catch (e) {
		errors.push(`timing persist: ${e instanceof Error ? e.message : e}`);
	}

	console.log(
		`[backfill-holders] scanned ${from}-${scannedTo} in ${chunksRun} chunk(s): +${discovered.size} wallets seen, ${morTransfers} transfers${done ? " [DONE]" : ` [more: nextFrom=${cursor}]`} rate=${blocksPerSec ? blocksPerSec.toFixed(0) : "?"} blk/s dedicated-key=${env.BACKFILL_ALCHEMY_URL ? "yes" : "no"} [${durationMs}ms]`,
	);

	return {
		requestedFrom: from,
		requestedTo: to,
		scannedTo,
		nextFrom: done ? null : cursor,
		done,
		chunksRun,
		chunkBlocks,
		morTransfers,
		walletsDiscovered: discovered.size,
		frontier: scannedTo,
		blocksDoneTotal,
		elapsedMsTotal,
		blocksPerSec,
		errors,
		durationMs,
	};
}
