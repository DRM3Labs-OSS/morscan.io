/**
 * Builder Staking Sync - Event-based incremental sync for BuildersV4
 *
 * Independent from Compute sync. Separate cursor, separate tables.
 * Same 3-layer pattern: event sync (5s), full sync (1m), background.
 *
 * Orchestration only - per-event processors live in builder-events.ts; the
 * full-state refreshers live in builder-discovery.ts + builder-refresh.ts.
 */

import { type Env, EVENTS } from "../types";
import { getCurrentBlock } from "../utils/rpc";
import { findWorkingRpc, type EventLog } from "./events-batch";
import { getLogsWithFallback } from "../utils/rpc-fallback";
import { writeBqSafe, builderStakeRow } from "../utils/bigquery";
import {
	makeBuilderEventCtx,
	processSubnetCreated,
	processDeposits,
	processWithdrawals,
	processClaims,
	processFees,
	recomputeStakes,
} from "./builder-events";
import { syncBuilderGlobalStats, syncFromGoldsky } from "./builder-discovery";
import { refreshSubnetData } from "./builder-refresh";
import {
	ensureBuilderEventsDedupIndex,
	getBuilderSyncStateValue,
	setBuilderSyncState,
	getStakesByPairs,
} from "../db/sync-builder";

interface BuilderSyncResult {
	fromBlock: number;
	toBlock: number;
	deposited: number;
	withdrawn: number;
	claimed: number;
	subnetsCreated: number;
	errors: string[];
	durationMs: number;
}

const CONFIRMATION_BUFFER = 20;

/** BuildersV4 proxy deploy block on Base - first SubnetCreated events start here */
const BUILDER_DEPLOY_BLOCK = 24_381_796;

/**
 * Catch-up chunking parameters.
 *
 * MAX_CHUNK: blocks per eth_getLogs range. Public RPCs cap the range (Base
 *   free tiers often 800-10000). 800 is safe for all providers; if an RPC
 *   still rejects the range we halve down to MIN_CHUNK before giving up.
 * MAX_ITERATIONS + TIME_BUDGET_MS: forward-progress budget for one tick so a
 *   large backlog heals over one or two ticks instead of blocking the tick.
 */
const MAX_CHUNK = 800;
const MIN_CHUNK = 50;
const MAX_ITERATIONS = 8;
const TIME_BUDGET_MS = 15000;

/** Fetch all builder topics for [from,to]. Rejects if ANY topic call fails
 *  (getLogsWithFallback only throws when every RPC endpoint failed), so the
 *  caller can refuse to advance the cursor. Never swallows an error into []. */
async function fetchBuilderLogs(
	rpcEndpoint: string,
	rpcUrl: string,
	contract: string,
	from: number,
	to: number,
): Promise<{
	deposit: EventLog[];
	withdraw: EventLog[];
	claim: EventLog[];
	subnetCreated: EventLog[];
	subnetEdited: EventLog[];
	fee: EventLog[];
}> {
	const get = (topic: string) =>
		getLogsWithFallback(
			rpcEndpoint,
			rpcUrl,
			contract,
			topic,
			from,
			to,
			`builder ${topic.slice(0, 10)}`,
		);
	const [deposit, withdraw, claim, subnetCreated, subnetEdited, fee] = await Promise.all([
		get(EVENTS.BUILDER_USER_DEPOSITED),
		get(EVENTS.BUILDER_USER_WITHDRAWN),
		get(EVENTS.BUILDER_ADMIN_CLAIMED),
		get(EVENTS.BUILDER_SUBNET_CREATED),
		get(EVENTS.BUILDER_SUBNET_EDITED),
		get(EVENTS.BUILDER_FEE_PAID),
	]);
	return { deposit, withdraw, claim, subnetCreated, subnetEdited, fee };
}

/**
 * Incremental event sync for builder staking.
 *
 * GAP-PROOF CONTRACT: the cursor advances to block N only after EVERY topic's
 * getLogs for [cursor+1, N] succeeded AND the resulting events were written to
 * D1. A getLogs failure (all RPCs down for that topic) is never swallowed into
 * an empty result that would let the cursor skip past unread blocks. Progress
 * is chunked and persisted after each fully-successful chunk, so a large lag
 * heals across one or two ticks and a partial failure never leaves a hole.
 */
export async function syncBuilderEvents(
	env: Env,
	maxBlocks = 100000,
): Promise<BuilderSyncResult> {
	const startTime = Date.now();
	const errors: string[] = [];

	const result = (
		fromBlock: number,
		toBlock: number,
		extra: Partial<BuilderSyncResult> = {},
	): BuilderSyncResult => ({
		fromBlock,
		toBlock,
		deposited: 0,
		withdrawn: 0,
		claimed: 0,
		subnetsCreated: 0,
		errors,
		durationMs: Date.now() - startTime,
		...extra,
	});

	if (!env.BUILDER_CONTRACT) {
		errors.push("BUILDER_CONTRACT not configured");
		return result(0, 0);
	}
	const builderContract = env.BUILDER_CONTRACT;

	// Idempotent dedup index - makes chunk re-processing after a reorg or retry
	// safe (a re-seen event collides on this UNIQUE key and is ignored).
	try {
		await ensureBuilderEventsDedupIndex(env.DB);
	} catch {}

	// Independent cursor. `cursor` = last block fully synced (inclusive).
	const lastBlockRow = await getBuilderSyncStateValue(env.DB, "last_builder_event_block");
	const startCursor = lastBlockRow
		? parseInt(lastBlockRow.value, 10)
		: BUILDER_DEPLOY_BLOCK - 1;

	const currentBlock = await getCurrentBlock(env);
	// Reorg safety: never index the last CONFIRMATION_BUFFER (~40s on Base) blocks.
	const safeHead = currentBlock - CONFIRMATION_BUFFER;
	// Absolute ceiling on how far one invocation may progress.
	const targetHead = Math.min(safeHead, startCursor + maxBlocks);

	if (startCursor >= targetHead) return result(startCursor + 1, startCursor);

	const rpcEndpoint = await findWorkingRpc(env);
	if (!rpcEndpoint) {
		// Do NOT advance - all RPCs are down. Same range retries next tick.
		errors.push("All RPCs failed (no cursor advance)");
		console.error("[syncBuilder] All RPCs failed - refusing to advance cursor");
		return result(startCursor + 1, startCursor);
	}

	console.log(
		`[syncBuilder] Catch-up: cursor ${startCursor} → target ${targetHead} (${targetHead - startCursor} blocks behind)`,
	);

	let cursor = startCursor;
	let chunkSize = MAX_CHUNK;
	let deposited = 0,
		withdrawn = 0,
		claimed = 0,
		subnetsCreated = 0;
	let iter = 0;

	while (
		cursor < targetHead &&
		iter < MAX_ITERATIONS &&
		Date.now() - startTime < TIME_BUDGET_MS
	) {
		iter++;
		const from = cursor + 1;
		const to = Math.min(from + chunkSize - 1, targetHead);

		let logs: Awaited<ReturnType<typeof fetchBuilderLogs>>;
		try {
			logs = await fetchBuilderLogs(rpcEndpoint, env.RPC_URL, builderContract, from, to);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// Range too large for some RPC? Halve and retry WITHOUT advancing.
			if (
				chunkSize > MIN_CHUNK &&
				/range|limit|too large|exceed|10000|block range|response size/i.test(msg)
			) {
				chunkSize = Math.max(MIN_CHUNK, Math.floor(chunkSize / 2));
				console.warn(
					`[syncBuilder] chunk ${from}-${to} rejected (${msg}); halving chunk to ${chunkSize}, cursor held at ${cursor}`,
				);
				continue;
			}
			// Real RPC failure - refuse to advance. This block range is retried next
			// tick. NEVER skip past unread blocks.
			errors.push(`chunk ${from}-${to}: ${msg}`);
			console.error(
				`[syncBuilder] REFUSING to advance cursor past ${cursor}: chunk ${from}-${to} failed: ${msg}`,
			);
			break;
		}

		// --- Write this chunk's events to D1 BEFORE advancing the cursor ---
		const ctx = makeBuilderEventCtx();
		subnetsCreated += await processSubnetCreated(env, logs.subnetCreated, ctx);
		deposited += await processDeposits(env, logs.deposit, ctx);
		withdrawn += await processWithdrawals(env, logs.withdraw, ctx);
		claimed += await processClaims(env, logs.claim, ctx);
		await processFees(env, logs.fee, ctx);
		await recomputeStakes(env, ctx);

		if (ctx.bqSubnetRows.length > 0)
			await writeBqSafe(env, "builder_subnets", ctx.bqSubnetRows);
		if (ctx.bqEventRows.length > 0)
			await writeBqSafe(env, "builder_events", ctx.bqEventRows);
		if (ctx.touchedStakes.size > 0) {
			const pairs = Array.from(ctx.touchedStakes).map((k) => {
				const idx = k.indexOf(":");
				return [k.slice(0, idx), k.slice(idx + 1)];
			});
			const res = await getStakesByPairs(env.DB, pairs);
			const bqStakeRows = res.map(builderStakeRow);
			if (bqStakeRows.length > 0) await writeBqSafe(env, "builder_stakes", bqStakeRows);
		}

		// Chunk fully processed → persist cursor. Durable even if a later chunk fails.
		cursor = to;
		await setBuilderSyncState(env.DB, "last_builder_event_block", cursor.toString());

		if (
			logs.deposit.length +
				logs.withdraw.length +
				logs.claim.length +
				logs.subnetCreated.length >
			0
		) {
			console.log(
				`[syncBuilder] chunk ${from}-${to}: ${logs.deposit.length} dep, ${logs.withdraw.length} wd, ${logs.claim.length} claim, ${logs.subnetCreated.length} subnet → cursor ${cursor}`,
			);
		}
	}

	if (cursor < targetHead) {
		console.warn(
			`[syncBuilder] tick ended ${targetHead - cursor} blocks behind (iter=${iter}, ${Date.now() - startTime}ms) - will continue next tick`,
		);
	}

	// Refresh global stats every tick (cheap - 2 eth_calls).
	try {
		await syncBuilderGlobalStats(env);
	} catch (e) {
		errors.push(`Global stats error: ${e instanceof Error ? e.message : String(e)}`);
	}

	return result(startCursor + 1, cursor, {
		deposited,
		withdrawn,
		claimed,
		subnetsCreated,
	});
}

/**
 * Full state sync - refresh global stats + all subnet on-chain data.
 * Called by cron (Layer 2) as backup.
 *
 * Three data sources:
 * 1. Goldsky subgraph (subnet list, staker counts, metadata) - authoritative
 * 2. On-chain subnetsData() (deposited/rewards) - supplements
 * 3. On-chain subnets() struct (admin backfill) - supplements
 */
export async function syncBuilderFullState(env: Env): Promise<void> {
	if (!env.BUILDER_CONTRACT) return;

	await syncBuilderGlobalStats(env);
	await syncFromGoldsky(env);
	await refreshSubnetData(env);
}
