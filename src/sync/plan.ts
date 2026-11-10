/**
 * Sync planning - the PURE decision logic of the indexer state machine.
 *
 * These functions carry no I/O. They decide, from plain numbers and flags:
 *   - which block range a tick should fetch (confirmation buffer + range cap),
 *   - whether the cursor may advance (the gap-proof invariant),
 *   - whether a tick looks stalled.
 *
 * They are extracted from sync() in compute.ts so the load-bearing rules can be
 * unit-tested without a live RPC or D1, and so they can move verbatim into the
 * eventual closed scanner-core. compute.ts imports these; the numbers here are
 * the single source of truth for the buffer and range constants.
 */

// Reorg safety margin, in chain time. History: 20 blocks, then 5 (2026-04-27),
// both sized for ~2s blocks. Since Base moved to ~200ms blocks (2026-11-05) a
// block count no longer means a fixed amount of time, so the margin is now
// seconds and converted with the measured block time (see ./chain-clock).
export const CONFIRMATION_SECONDS = 10;
// Block-count default for callers that do not pass a measured buffer.
export const CONFIRMATION_BUFFER = 5;
// Max block range per eth_getLogs call. Alchemy supports up to 100K.
// Free RPCs vary. 50K is safe for all providers.
export const MAX_LOG_RANGE = 50000;

export interface SyncRange {
	fromBlock: number;
	toBlock: number;
	gap: number;
	/** True when the cursor is already within the confirmation buffer of head. */
	upToDate: boolean;
}

/**
 * Plan the block range for one sync tick.
 *
 * Cold start (no cursor yet) begins bufferBlocks back from head (default
 * CONFIRMATION_BUFFER; the live sync passes the time-based buffer). Otherwise resume at lastEventBlock + 1. The range never crosses safeHead
 * (head minus the confirmation buffer) and is capped at MAX_LOG_RANGE blocks
 * per tick. When the cursor has caught up to safeHead, upToDate is true and the
 * caller does nothing this tick.
 */
export function planSyncRange(
	lastEventBlock: number,
	currentBlock: number,
	bufferBlocks: number = CONFIRMATION_BUFFER,
): SyncRange {
	const fromBlock = lastEventBlock > 0 ? lastEventBlock + 1 : currentBlock - bufferBlocks;
	const safeHead = currentBlock - bufferBlocks;

	if (fromBlock > safeHead) {
		return { fromBlock, toBlock: safeHead, gap: 0, upToDate: true };
	}

	const toBlock = Math.min(fromBlock + MAX_LOG_RANGE - 1, safeHead);
	const gap = toBlock - fromBlock + 1;
	return { fromBlock, toBlock, gap, upToDate: false };
}

/**
 * The GAP-PROOF invariant. The cursor may advance ONLY when no getLogs fetch
 * threw (fetchFailed stays false) AND no per-event processor reported a session
 * error. A failed fetch yields an empty log array purely because of an RPC
 * error, not a real absence of events - advancing on that would silently skip
 * real deposits and sessions. When held, the same range retries next tick.
 */
export function shouldAdvanceCursor(
	fetchFailed: boolean,
	sessionErrors: boolean,
): boolean {
	return !fetchFailed && !sessionErrors;
}

/**
 * Whether any collected error string signals a session-processing failure.
 * Kept as substring matching to mirror the historical behavior exactly.
 */
export function hasSessionErrors(errors: string[]): boolean {
	return errors.some((e) => e.includes("SessionOpened") || e.includes("SessionClosed"));
}

/**
 * Stall heuristic for logging/alerting: a tick that processed no blocks, or a
 * wide gap (>100 blocks) that returned zero Diamond AND zero MOR events, is
 * almost certainly an RPC problem rather than a genuinely quiet window.
 */
export function isStall(
	gap: number,
	diamondEventCount: number,
	morEventCount: number,
	blocksProcessed: number,
): boolean {
	return (
		blocksProcessed === 0 || (gap > 100 && diamondEventCount === 0 && morEventCount === 0)
	);
}
