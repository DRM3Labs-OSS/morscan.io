/**
 * Builder event-log processors - per-event-type D1 + BQ row builders.
 * Extracted from syncBuilderEvents() so each event type has a focused processor.
 */

import type { Env } from "../types";
import type { EventLog } from "./events-batch";
import { builderEventRow, builderSubnetRow } from "../utils/bigquery";
import {
	parseBuilderStakeEvent,
	parseBuilderClaimEvent,
	parseSubnetCreatedEvent,
} from "./builder-parsers";
import {
	upsertSubnetFromCreatedEventStmt,
	insertSubnetShellStmt,
	upsertStakeOnDepositStmt,
	touchStakeStmt,
	setStakeDeposited,
	insertBuilderEventStmt,
	getStakeFlowEvents,
} from "../db/sync-builder";

/** Shared accumulators threaded through the per-event processors. */
export interface BuilderEventCtx {
	bqSubnetRows: ReturnType<typeof builderSubnetRow>[];
	bqEventRows: ReturnType<typeof builderEventRow>[];
	touchedStakes: Set<string>; // `${subnet_id}:${wallet}`
}

export function makeBuilderEventCtx(): BuilderEventCtx {
	return { bqSubnetRows: [], bqEventRows: [], touchedStakes: new Set() };
}

// id is assigned by SQLite at INSERT; pass 0 and let insertId fall back to the
// (tx_hash, log_index) shape inside builderEventRow.
function addEventRow(
	ctx: BuilderEventCtx,
	eventType: string,
	subnetId: string,
	wallet: string | null,
	amount: string,
	txHash: string | null,
	blockNum: number,
	blockTimestamp: number | null,
	logIndex: number | null,
): void {
	ctx.bqEventRows.push(
		builderEventRow({
			id: 0,
			event_type: eventType,
			subnet_id: subnetId,
			wallet,
			amount,
			tx_hash: txHash,
			block_number: blockNum,
			block_timestamp: blockTimestamp,
			log_index: logIndex,
		}),
	);
}

/**
 * Real log position within the block, parsed from the eth_getLogs hex field.
 * The dedup key is UNIQUE(tx_hash, log_index, event_type) - binding a literal 0
 * here (the old behavior) collapsed two same-type events in one tx into one row.
 * NaN-safe: a malformed/missing field falls back to 0 rather than failing the bind.
 */
function parseLogIndex(log: EventLog): number {
	return Number.parseInt(log.logIndex, 16) || 0;
}

async function flush(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
	for (let i = 0; i < stmts.length; i += 100) {
		await env.DB.batch(stmts.slice(i, i + 100));
	}
}

/** Process SubnetCreated events - extract full struct from event data. */
export async function processSubnetCreated(
	env: Env,
	logs: EventLog[],
	ctx: BuilderEventCtx,
): Promise<number> {
	if (logs.length === 0) return 0;
	let subnetsCreated = 0;
	const inserts: D1PreparedStatement[] = [];
	for (const log of logs) {
		const parsed = parseSubnetCreatedEvent(log);
		const blockNum = parseInt(log.blockNumber, 16);
		if (parsed) {
			inserts.push(
				upsertSubnetFromCreatedEventStmt(
					env.DB,
					parsed.subnetId,
					parsed.name,
					parsed.admin,
					parsed.claimAdmin,
					parsed.minimalDeposit,
					parsed.withdrawLockPeriod,
					blockNum,
					blockNum,
				),
			);
			ctx.bqSubnetRows.push(
				builderSubnetRow({
					subnet_id: parsed.subnetId,
					name: parsed.name,
					admin: parsed.admin,
					claim_admin: parsed.claimAdmin,
					minimal_deposit: parsed.minimalDeposit,
					withdraw_lock_period: parsed.withdrawLockPeriod,
					total_deposited: null,
					pending_rewards: null,
					staker_count: null,
					chain: "base",
					created_at: blockNum,
					updated_at: blockNum,
				}),
			);
		} else if (log.topics && log.topics.length >= 2) {
			const subnetId = log.topics[1].toLowerCase();
			inserts.push(insertSubnetShellStmt(env.DB, subnetId, blockNum, blockNum));
			ctx.bqSubnetRows.push(
				builderSubnetRow({
					subnet_id: subnetId,
					name: "",
					admin: "",
					minimal_deposit: null,
					withdraw_lock_period: null,
					total_deposited: null,
					pending_rewards: null,
					staker_count: null,
					chain: "base",
					created_at: blockNum,
					updated_at: blockNum,
				}),
			);
		}
		subnetsCreated++;
	}
	await flush(env, inserts);
	return subnetsCreated;
}

/** Process UserDeposited events - deposited is recomputed from events later. */
export async function processDeposits(
	env: Env,
	logs: EventLog[],
	ctx: BuilderEventCtx,
): Promise<number> {
	if (logs.length === 0) return 0;
	let deposited = 0;
	const stmts: D1PreparedStatement[] = [];
	const nowEpoch = Math.floor(Date.now() / 1000);
	for (const log of logs) {
		const evt = parseBuilderStakeEvent(log);
		if (!evt) continue;
		const blockNum = parseInt(log.blockNumber, 16);
		const logIdx = parseLogIndex(log);
		stmts.push(insertSubnetShellStmt(env.DB, evt.subnetId, blockNum, blockNum));
		stmts.push(upsertStakeOnDepositStmt(env.DB, evt.subnetId, evt.wallet, nowEpoch));
		stmts.push(
			insertBuilderEventStmt(
				env.DB,
				"deposit",
				evt.subnetId,
				evt.wallet,
				evt.amount,
				log.transactionHash,
				blockNum,
				logIdx,
			),
		);
		addEventRow(
			ctx,
			"deposit",
			evt.subnetId,
			evt.wallet,
			evt.amount,
			log.transactionHash,
			blockNum,
			blockNum,
			logIdx,
		);
		ctx.touchedStakes.add(`${evt.subnetId}:${evt.wallet}`);
		deposited++;
	}
	await flush(env, stmts);
	return deposited;
}

/** Process UserWithdrawn events - deposited is recomputed from events later. */
export async function processWithdrawals(
	env: Env,
	logs: EventLog[],
	ctx: BuilderEventCtx,
): Promise<number> {
	if (logs.length === 0) return 0;
	let withdrawn = 0;
	const stmts: D1PreparedStatement[] = [];
	const nowEpoch = Math.floor(Date.now() / 1000);
	for (const log of logs) {
		const evt = parseBuilderStakeEvent(log);
		if (!evt) continue;
		const blockNum = parseInt(log.blockNumber, 16);
		const logIdx = parseLogIndex(log);
		stmts.push(touchStakeStmt(env.DB, nowEpoch, evt.subnetId, evt.wallet));
		stmts.push(
			insertBuilderEventStmt(
				env.DB,
				"withdraw",
				evt.subnetId,
				evt.wallet,
				evt.amount,
				log.transactionHash,
				blockNum,
				logIdx,
			),
		);
		addEventRow(
			ctx,
			"withdraw",
			evt.subnetId,
			evt.wallet,
			evt.amount,
			log.transactionHash,
			blockNum,
			blockNum,
			logIdx,
		);
		ctx.touchedStakes.add(`${evt.subnetId}:${evt.wallet}`);
		withdrawn++;
	}
	await flush(env, stmts);
	return withdrawn;
}

/** Process AdminClaimed events. */
export async function processClaims(
	env: Env,
	logs: EventLog[],
	ctx: BuilderEventCtx,
): Promise<number> {
	if (logs.length === 0) return 0;
	let claimed = 0;
	const stmts: D1PreparedStatement[] = [];
	for (const log of logs) {
		const evt = parseBuilderClaimEvent(log);
		if (!evt) continue;
		const blockNum = parseInt(log.blockNumber, 16);
		const logIdx = parseLogIndex(log);
		stmts.push(
			insertBuilderEventStmt(
				env.DB,
				"claim",
				evt.subnetId,
				evt.receiver,
				evt.pendingRewards,
				log.transactionHash,
				blockNum,
				logIdx,
			),
		);
		addEventRow(
			ctx,
			"claim",
			evt.subnetId,
			evt.receiver,
			evt.pendingRewards,
			log.transactionHash,
			blockNum,
			blockNum,
			logIdx,
		);
		claimed++;
	}
	await flush(env, stmts);
	return claimed;
}

/** Process FeePaid events. subnet_id slot doubles as the operation tag. */
export async function processFees(
	env: Env,
	logs: EventLog[],
	ctx: BuilderEventCtx,
): Promise<void> {
	if (logs.length === 0) return;
	const stmts: D1PreparedStatement[] = [];
	for (const log of logs) {
		if (!log.topics || log.topics.length < 3) continue;
		const wallet = `0x${log.topics[1].slice(26).toLowerCase()}`;
		const operation = log.topics[2].toLowerCase();
		const data = log.data.replace(/^0x/, "");
		const amount = data.length >= 64 ? BigInt(`0x${data.slice(0, 64)}`).toString() : "0";
		const blockNum = parseInt(log.blockNumber, 16);
		const logIdx = parseLogIndex(log);
		stmts.push(
			insertBuilderEventStmt(
				env.DB,
				"fee",
				operation,
				wallet,
				amount,
				log.transactionHash,
				blockNum,
				logIdx,
			),
		);
		addEventRow(
			ctx,
			"fee",
			operation,
			wallet,
			amount,
			log.transactionHash,
			blockNum,
			blockNum,
			logIdx,
		);
	}
	await flush(env, stmts);
}

/**
 * Recompute deposited for touched stakes from events using BigInt (avoids
 * SQLite INTEGER overflow on wei values).
 */
export async function recomputeStakes(env: Env, ctx: BuilderEventCtx): Promise<void> {
	for (const key of ctx.touchedStakes) {
		const idx = key.indexOf(":");
		const subnetId = key.slice(0, idx);
		const wallet = key.slice(idx + 1);
		const events = await getStakeFlowEvents(env.DB, subnetId, wallet);
		let total = BigInt(0);
		for (const e of events) {
			const amt = BigInt(e.amount || "0");
			if (e.event_type === "deposit") total += amt;
			else total -= amt;
		}
		if (total < BigInt(0)) total = BigInt(0);
		await setStakeDeposited(env.DB, total.toString(), subnetId, wallet);
	}
}
