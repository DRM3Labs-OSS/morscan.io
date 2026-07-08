/**
 * Holder-data coverage + backfill timing (leaf module, zero heavy deps).
 *
 * This is deliberately dependency-free (only `Env`) so /health can import it
 * without pulling the BigQuery / cache / RPC-pool graph that compute-events.ts
 * drags in. It owns the canonical contract deploy blocks and the pure math that
 * turns the persisted backfill timing rows into a coverage %, a measured
 * throughput (blocks/sec on the free RPC tier), and an ETA to full coverage.
 *
 * WHY THIS EXISTS: MorScan tracked MOR holders only from its live indexing start
 * (head-100), so every wallet that acquired MOR before that and simply held was
 * invisible - 1.5K holders shown vs ~14.5K real on Basescan. The honest fix is a
 * throttled, resumable re-scan of MOR Transfer events from the token deploy block
 * forward. Because that runs slowly on a free Alchemy key, the UI must show an
 * explicit "indexing full history" state with % + ETA, never a bare low number.
 */

import type { Env } from "../types";
import { getSyncStateByKeys, setSyncStateStmt } from "../db/sync";

// Verified via eth_getCode binary search on Base:
//   MOR ERC-20  : no code at 15002374, code at 15002375.
//   Diamond     : no code at 39593196, code at 39593197.
export const MOR_DEPLOY_BLOCK = 15_002_375;
export const DIAMOND_DEPLOY_BLOCK = 39_593_197;
// BuildersV4 (builder subnet staking) - mirrors BUILDER_DEPLOY_BLOCK in builder.ts.
export const BUILDER_DEPLOY_BLOCK = 24_381_796;

// sync_state keys for the holder-history backfill campaign.
export const HOLDER_BACKFILL_KEYS = {
	frontier: "mor_holder_backfill_block", // highest block scanned contiguously from MOR_DEPLOY_BLOCK
	startedAt: "mor_holder_backfill_started_at", // ISO ts of the current campaign start
	updatedAt: "mor_holder_backfill_updated_at", // ISO ts of the last backfill run
	blocksDone: "mor_holder_backfill_blocks_done", // cumulative blocks scanned this campaign
	elapsedMs: "mor_holder_backfill_elapsed_ms", // cumulative wall-clock spent scanning (ms)
} as const;

export interface HolderCoverage {
	fromBlock: number; // MOR_DEPLOY_BLOCK - where honest holder history begins
	scannedTo: number; // frontier reached so far
	headBlock: number; // chain head (target)
	blocksRemaining: number; // head - frontier
	pct: number; // 0..100 coverage of [deploy, head]
	complete: boolean; // frontier within live-sync range of head
	blocksDone: number; // cumulative blocks scanned this campaign
	elapsedMs: number; // cumulative scanning wall-clock
	blocksPerSec: number | null; // measured throughput on the free tier (null until we have data)
	etaSeconds: number | null; // blocks_remaining / blocks_per_sec (null until measurable)
	startedAt: string | null;
	updatedAt: string | null;
}

// Once the frontier is within this many blocks of head, the live forward sync
// covers the remainder, so the historical backfill is effectively complete.
const LIVE_TAIL_BLOCKS = 100_000;

function toNum(v: string | undefined, fallback = 0): number {
	const n = parseInt(String(v ?? ""), 10);
	return Number.isFinite(n) ? n : fallback;
}

/** Pure coverage math from already-read sync_state values. No I/O. */
export function computeHolderCoverage(
	vals: Record<string, string | undefined>,
	headBlock: number,
): HolderCoverage {
	const fromBlock = MOR_DEPLOY_BLOCK;
	const rawFrontier = toNum(vals[HOLDER_BACKFILL_KEYS.frontier], 0);
	// A frontier below the deploy block (or the legacy cursor's stale meaning)
	// clamps to the deploy floor so pct never overstates coverage.
	const frontier = rawFrontier > 0 ? Math.max(rawFrontier, fromBlock) : fromBlock;
	// A real Base head is far past the MOR deploy block (~48M vs 15M). When
	// /health's D1 query times out it passes headBlock = 0; treating that as valid
	// would clamp head to the frontier and every dataset would falsely read
	// 100%/complete, hiding the syncing banner. So a head must exceed the deploy
	// floor to be trusted; an unknown head => NOT complete (still indexing), and
	// pct is withheld (0) for that tick. This still resolves to complete when the
	// frontier legitimately catches a real head.
	const validHead = headBlock > fromBlock;
	const head = validHead ? Math.max(headBlock, frontier) : frontier;
	const span = Math.max(1, head - fromBlock);
	const scanned = Math.max(0, Math.min(frontier, head) - fromBlock);
	const blocksRemaining = validHead ? Math.max(0, head - frontier) : 0;
	const pct = validHead
		? Math.max(0, Math.min(100, Math.round((scanned / span) * 1000) / 10))
		: 0;
	const complete = rawFrontier > 0 && validHead && blocksRemaining <= LIVE_TAIL_BLOCKS;

	const blocksDone = toNum(vals[HOLDER_BACKFILL_KEYS.blocksDone], 0);
	const elapsedMs = toNum(vals[HOLDER_BACKFILL_KEYS.elapsedMs], 0);
	const elapsedSec = elapsedMs / 1000;
	const blocksPerSec = elapsedSec > 0 && blocksDone > 0 ? blocksDone / elapsedSec : null;
	const etaSeconds =
		blocksPerSec && blocksPerSec > 0 ? Math.round(blocksRemaining / blocksPerSec) : null;

	return {
		fromBlock,
		scannedTo: frontier,
		headBlock: head,
		blocksRemaining,
		pct,
		complete,
		blocksDone,
		elapsedMs,
		blocksPerSec,
		etaSeconds,
		startedAt: vals[HOLDER_BACKFILL_KEYS.startedAt] ?? null,
		updatedAt: vals[HOLDER_BACKFILL_KEYS.updatedAt] ?? null,
	};
}

/** Read the backfill timing keys from sync_state and compute coverage. */
export async function readHolderCoverage(
	env: Env,
	headBlock: number,
): Promise<HolderCoverage> {
	const vals = await readBackfillState(env);
	return computeHolderCoverage(vals, headBlock);
}

async function readBackfillState(env: Env): Promise<Record<string, string>> {
	const keys = Object.values(HOLDER_BACKFILL_KEYS);
	const rows = await getSyncStateByKeys(env.DB, keys);
	const vals: Record<string, string> = {};
	for (const r of rows) vals[r.key] = r.value;
	return vals;
}

/** Per-dataset coverage: real from-block + how much of it we have scanned. */
export interface DatasetCoverage {
	fromBlock: number;
	scannedTo: number;
	headBlock: number;
	pct: number;
	complete: boolean;
}

function datasetCoverage(
	fromBlock: number,
	frontier: number,
	head: number,
): DatasetCoverage {
	const h = Math.max(head, frontier);
	const span = Math.max(1, h - fromBlock);
	// The sweep starts at MOR_DEPLOY_BLOCK; a dataset with a LATER floor (sessions)
	// has 0 coverage until the frontier passes its floor, then climbs.
	const scanned = Math.max(0, Math.min(frontier, h) - fromBlock);
	const pct = Math.max(0, Math.min(100, Math.round((scanned / span) * 1000) / 10));
	const complete = frontier > 0 && h - Math.max(frontier, fromBlock) <= LIVE_TAIL_BLOCKS;
	return {
		fromBlock,
		scannedTo: Math.max(fromBlock, Math.min(frontier, h)),
		headBlock: h,
		pct,
		complete,
	};
}

export interface AllCoverage {
	holders: HolderCoverage; // the sweep's binding constraint (earliest floor)
	sessions: DatasetCoverage; // from DIAMOND_DEPLOY_BLOCK
	builder: DatasetCoverage; // from BUILDER_DEPLOY_BLOCK (complete via its own sync)
	blocksPerSec: number | null;
	etaSeconds: number | null;
}

/**
 * Coverage for EVERY historical dataset from one genesis-ward sweep. The single
 * frontier (scanned up from MOR_DEPLOY_BLOCK, the earliest floor) yields holder
 * coverage directly and session coverage once it passes the Diamond floor.
 * Builder is reported from its own cursor (it has always had a deploy floor).
 */
export async function readAllCoverage(
	env: Env,
	headBlock: number,
	builderFrontier?: number,
): Promise<AllCoverage> {
	const vals = await readBackfillState(env);
	const holders = computeHolderCoverage(vals, headBlock);
	const frontier = holders.scannedTo;
	const head = holders.headBlock;
	const sessions = datasetCoverage(DIAMOND_DEPLOY_BLOCK, frontier, head);
	// Builder is driven by its own event sync from BUILDER_DEPLOY_BLOCK; if a live
	// builder cursor is supplied use it, else assume complete (its floor is wired).
	const bFront = builderFrontier && builderFrontier > 0 ? builderFrontier : head;
	const builder = datasetCoverage(BUILDER_DEPLOY_BLOCK, bFront, head);
	return {
		holders,
		sessions,
		builder,
		blocksPerSec: holders.blocksPerSec,
		etaSeconds: holders.etaSeconds,
	};
}

/**
 * Persist backfill frontier + cumulative timing after a run of ANY historical
 * backfill (generic Diamond+MOR pass, or the holders-only pass). Both advance
 * the SAME contiguous genesis-ward frontier, so coverage/ETA reflect the whole
 * catch-up regardless of which endpoint drove a given window. A run starting at
 * or below MOR_DEPLOY_BLOCK resets the campaign timers (fresh measurement).
 *
 * The frontier only advances when this run is a contiguous extension of it (or a
 * campaign restart), so an out-of-band re-scan of an interior range does not
 * regress the reported coverage.
 */
export async function persistBackfillProgress(
	env: Env,
	from: number,
	scannedTo: number,
	durationMs: number,
): Promise<{ blocksDone: number; elapsedMs: number; blocksPerSec: number | null }> {
	const isCampaignStart = from <= MOR_DEPLOY_BLOCK;
	const prev = await readBackfillState(env);
	let blocksDone = isCampaignStart
		? 0
		: parseInt(prev[HOLDER_BACKFILL_KEYS.blocksDone] || "0", 10) || 0;
	let elapsedMs = isCampaignStart
		? 0
		: parseInt(prev[HOLDER_BACKFILL_KEYS.elapsedMs] || "0", 10) || 0;
	const prevFrontier = parseInt(prev[HOLDER_BACKFILL_KEYS.frontier] || "0", 10) || 0;

	blocksDone += Math.max(0, scannedTo - from + 1);
	elapsedMs += Math.max(0, durationMs);
	const nowIso = new Date().toISOString();

	const contiguous = isCampaignStart || from <= prevFrontier + 1;
	const newFrontier = contiguous ? Math.max(prevFrontier, scannedTo) : prevFrontier;

	const writes: D1PreparedStatement[] = [
		setSyncStateStmt(env.DB, HOLDER_BACKFILL_KEYS.blocksDone, blocksDone.toString()),
		setSyncStateStmt(env.DB, HOLDER_BACKFILL_KEYS.elapsedMs, elapsedMs.toString()),
		setSyncStateStmt(env.DB, HOLDER_BACKFILL_KEYS.updatedAt, nowIso),
		setSyncStateStmt(env.DB, HOLDER_BACKFILL_KEYS.frontier, newFrontier.toString()),
	];
	if (isCampaignStart)
		writes.push(setSyncStateStmt(env.DB, HOLDER_BACKFILL_KEYS.startedAt, nowIso));
	await env.DB.batch(writes);

	const elapsedSec = elapsedMs / 1000;
	const blocksPerSec = elapsedSec > 0 && blocksDone > 0 ? blocksDone / elapsedSec : null;
	return { blocksDone, elapsedMs, blocksPerSec };
}

/** Compact human ETA, e.g. "~3.2 hours" / "~12 min" / "~2.1 days". */
export function formatEta(etaSeconds: number | null): string | null {
	if (etaSeconds === null || !Number.isFinite(etaSeconds) || etaSeconds < 0) return null;
	if (etaSeconds < 90) return `~${Math.max(1, Math.round(etaSeconds))}s`;
	const min = etaSeconds / 60;
	if (min < 90) return `~${Math.round(min)} min`;
	const hr = min / 60;
	if (hr < 48) return `~${Math.round(hr * 10) / 10} hours`;
	return `~${Math.round((hr / 24) * 10) / 10} days`;
}
