/**
 * The /health status rules, as one pure function so they can be unit-tested.
 *
 * Every lag rule is in SECONDS of chain time, never in blocks: the block gap is
 * converted with the measured block time (src/sync/chain-clock.ts). Blocks were
 * the old unit, and when Base went from ~2s to ~200ms blocks on 2026-11-05 every
 * block threshold quietly became 10x stricter and the badge went yellow on a
 * healthy index. The second values below are the old block thresholds times the
 * old 2s cadence, so the real-time meaning is unchanged.
 */

import { lagSeconds } from "../sync/chain-clock";

/** Wall-clock age of the last sync tick (the stall signal). */
export const SYNC_STALE_SECONDS = 120;
export const SYNC_VERY_STALE_SECONDS = 300;
/** Diamond / MOR index lag behind the head. Was 50 / 500 blocks. */
export const LAG_DEGRADED_SECONDS = 100;
export const LAG_ERROR_SECONDS = 1000;
/** Builder index lag behind the head. Was 100 / 500 blocks. */
export const BUILDER_LAG_DEGRADED_SECONDS = 200;
export const BUILDER_LAG_ERROR_SECONDS = 1000;
/** Event cursor lag that, with a stale tick, means the cursor is stuck. Was 30 blocks. */
export const CURSOR_STUCK_LAG_SECONDS = 60;

export type LagLevel = "ok" | "degraded" | "error";

export interface HealthInputs {
	syncError: boolean;
	blockTimeMs: number;
	/** Seconds since the last sync tick, null when it was never recorded. */
	lastSyncAgeSeconds: number | null;
	blocksBehind: number;
	builderBlocksBehind: number | null;
	cursorBlocksBehind: number | null;
}

export interface HealthVerdict {
	status: "ok" | "degraded" | "error";
	lagSeconds: number;
	builderLagSeconds: number | null;
	builderStatus: LagLevel | null;
	syncStale: boolean;
	eventCursorStuck: boolean;
}

function level(seconds: number, degraded: number, error: number): LagLevel {
	return seconds >= error ? "error" : seconds >= degraded ? "degraded" : "ok";
}

export function classifyHealth(i: HealthInputs): HealthVerdict {
	const lag = lagSeconds(i.blocksBehind, i.blockTimeMs) ?? 0;
	const builderLag = lagSeconds(i.builderBlocksBehind, i.blockTimeMs);
	const cursorLag = lagSeconds(i.cursorBlocksBehind, i.blockTimeMs);

	// Wall-clock staleness is the only reliable stall signal (a dead sync freezes
	// head and cursor together, so the gap alone can look healthy). Missing
	// timestamp = cannot prove freshness = stale.
	const age = i.lastSyncAgeSeconds;
	const syncStale = age === null || age > SYNC_STALE_SECONDS;
	const syncVeryStale = age === null || age > SYNC_VERY_STALE_SECONDS;
	const eventCursorStuck =
		age !== null &&
		age > SYNC_STALE_SECONDS &&
		cursorLag !== null &&
		cursorLag > CURSOR_STUCK_LAG_SECONDS;

	const lagLevel = level(lag, LAG_DEGRADED_SECONDS, LAG_ERROR_SECONDS);
	const builderStatus =
		builderLag === null
			? null
			: level(builderLag, BUILDER_LAG_DEGRADED_SECONDS, BUILDER_LAG_ERROR_SECONDS);

	const status = i.syncError
		? "error"
		: syncVeryStale || lagLevel === "error" || builderStatus === "error"
			? "error"
			: syncStale ||
					eventCursorStuck ||
					lagLevel === "degraded" ||
					builderStatus === "degraded"
				? "degraded"
				: "ok";

	return {
		status,
		lagSeconds: lag,
		builderLagSeconds: builderLag,
		builderStatus,
		syncStale,
		eventCursorStuck,
	};
}
