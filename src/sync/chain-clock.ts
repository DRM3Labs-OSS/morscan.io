/**
 * Chain clock - the measured Base block time, so every freshness rule can be
 * written in SECONDS instead of blocks.
 *
 * Why: block counts silently change meaning when the chain changes cadence. On
 * 2026-11-05 Base went from ~2s blocks to ~200ms blocks, and every threshold
 * written as "N blocks" became 10x tighter overnight (a 50-block "degraded"
 * line that meant ~100s started firing at ~10s of perfectly normal lag).
 *
 * How: each sync tick reads the head block's number AND timestamp (one RPC call,
 * the same one that used to fetch the number alone). The first reading becomes
 * an anchor; once the chain has moved at least MIN_SPAN_SECONDS past it, the
 * block time is (timestamp delta / block delta), stored in sync_state, and the
 * anchor moves forward. Block timestamps have 1s resolution, so the minimum
 * span keeps the error to a few percent. A cadence change is picked up within
 * about two spans, with no deploy.
 */

import { getSyncStateValue } from "../db/ops";
import { setSyncState, setSyncStateStmt } from "../db/sync";

/** Used only until the first measurement lands (minutes after a cold start). */
export const DEFAULT_BLOCK_TIME_MS = 200;
/** Minimum chain-time span between two head readings before we trust a measurement. */
export const MIN_SPAN_SECONDS = 60;
/** Sanity clamp: anything outside this band is a bad reading, not a real cadence. */
export const MIN_BLOCK_TIME_MS = 20;
export const MAX_BLOCK_TIME_MS = 20_000;

export const BLOCK_TIME_KEY = "block_time_ms";
const ANCHOR_KEY = "head_anchor";

export interface HeadReading {
	block: number;
	/** Block timestamp, unix seconds. */
	timestamp: number;
}

/**
 * Block time in ms between two head readings, or null when the span is too
 * short (or backwards, or implausible) to trust.
 */
export function measureBlockTimeMs(
	anchor: HeadReading,
	head: HeadReading,
): number | null {
	const blocks = head.block - anchor.block;
	const seconds = head.timestamp - anchor.timestamp;
	if (blocks <= 0 || seconds < MIN_SPAN_SECONDS) return null;
	const ms = (seconds * 1000) / blocks;
	if (ms < MIN_BLOCK_TIME_MS || ms > MAX_BLOCK_TIME_MS) return null;
	return Math.round(ms);
}

/** Parse a stored block time, falling back to the default for missing or bad values. */
export function parseBlockTimeMs(raw: string | null | undefined): number {
	const n = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(n) && n >= MIN_BLOCK_TIME_MS && n <= MAX_BLOCK_TIME_MS
		? n
		: DEFAULT_BLOCK_TIME_MS;
}

/** How many blocks cover `seconds` of chain time (at least 1). */
export function blocksForSeconds(seconds: number, blockTimeMs: number): number {
	return Math.max(1, Math.ceil((seconds * 1000) / blockTimeMs));
}

/** Seconds of chain time a block gap represents (null passes through). */
export function lagSeconds(blocks: number | null, blockTimeMs: number): number | null {
	if (blocks === null) return null;
	return Math.max(0, Math.round((blocks * blockTimeMs) / 1000));
}

function parseAnchor(raw: string | null | undefined): HeadReading | null {
	if (!raw) return null;
	const [b, t] = raw.split(":").map(Number);
	return Number.isFinite(b) && Number.isFinite(t) && b > 0
		? { block: b, timestamp: t }
		: null;
}

/** Read the current block time estimate (default until the first measurement). */
export async function readBlockTimeMs(db: D1Database): Promise<number> {
	try {
		const row = await getSyncStateValue(db, BLOCK_TIME_KEY);
		return parseBlockTimeMs(row?.value as string | undefined);
	} catch {
		return DEFAULT_BLOCK_TIME_MS;
	}
}

/**
 * Feed one head reading into the clock. Returns the block time to use for this
 * tick (fresh measurement if one landed, else the stored estimate).
 * Never throws: a clock failure must not stop the sync.
 */
export async function recordHead(db: D1Database, head: HeadReading): Promise<number> {
	try {
		const [anchorRow, timeRow] = await Promise.all([
			getSyncStateValue(db, ANCHOR_KEY),
			getSyncStateValue(db, BLOCK_TIME_KEY),
		]);
		const stored = parseBlockTimeMs(timeRow?.value as string | undefined);
		const anchor = parseAnchor(anchorRow?.value as string | undefined);
		const encoded = `${head.block}:${head.timestamp}`;
		// No anchor, or the head went backwards (RPC behind another RPC): re-anchor.
		if (!anchor || head.block < anchor.block) {
			await setSyncState(db, ANCHOR_KEY, encoded);
			return stored;
		}
		const measured = measureBlockTimeMs(anchor, head);
		if (measured === null) return stored;
		await db.batch([
			setSyncStateStmt(db, BLOCK_TIME_KEY, String(measured)),
			setSyncStateStmt(db, ANCHOR_KEY, encoded),
		]);
		return measured;
	} catch {
		return DEFAULT_BLOCK_TIME_MS;
	}
}
