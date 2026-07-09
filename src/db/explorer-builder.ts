/**
 * Builder-plane data-access layer.
 *
 * D1 queries for builder subnets, stakes, events, and the builder sync
 * cursor. SQL strings are moved verbatim from the handlers; every function
 * takes the D1 database first. Read executors return `T[]`
 * (`r.results ?? []`) or `T | null` (`.first()`).
 */

// ─── Row shapes ───

/** Generic untyped row - queries whose handlers consume raw records. */
export type BuilderRawRow = Record<string, unknown>;

// ─── Subnet list + global stats ───

/** All subnets ordered by total deposited. */
export async function selectSubnetsByDeposit(db: D1Database): Promise<BuilderRawRow[]> {
	const r = await db
		.prepare("SELECT * FROM builder_subnets ORDER BY CAST(total_deposited AS REAL) DESC")
		.all();
	return r.results ?? [];
}

// One builder_sync_state value by key: use getBuilderSyncStateValue from sync-builder.ts (canonical).

/** Block cursor of the builder event scanner. */
export function selectLastBuilderEventBlock(
	db: D1Database,
): Promise<BuilderRawRow | null> {
	return db
		.prepare(
			"SELECT value FROM builder_sync_state WHERE key = 'last_builder_event_block'",
		)
		.first();
}

/** Total subnet count. */
export function countSubnets(db: D1Database): Promise<BuilderRawRow | null> {
	return db.prepare("SELECT COUNT(*) as count FROM builder_subnets").first();
}

/** Sum of per-subnet staker counts (active stakers). */
export function sumSubnetStakerCounts(db: D1Database): Promise<BuilderRawRow | null> {
	return db.prepare("SELECT SUM(staker_count) as count FROM builder_subnets").first();
}

// ─── Builder events feed ───

/** One page of recent builder events. */
export async function selectBuilderEventsPage(
	db: D1Database,
	limit: number,
	offset: number,
): Promise<BuilderRawRow[]> {
	const r = await db
		.prepare("SELECT * FROM builder_events ORDER BY block_number DESC LIMIT ? OFFSET ?")
		.bind(limit, offset)
		.all();
	return r.results ?? [];
}

/** Total builder event count. */
export function countBuilderEvents(db: D1Database): Promise<BuilderRawRow | null> {
	return db.prepare("SELECT COUNT(*) as count FROM builder_events").first();
}

// ─── Subnet detail ───

/** One subnet by id. */
export function selectSubnetById(
	db: D1Database,
	subnetId: string,
): Promise<BuilderRawRow | null> {
	return db
		.prepare("SELECT * FROM builder_subnets WHERE subnet_id = ?")
		.bind(subnetId)
		.first();
}

/** Latest deposit BLOCK per staker of one subnet. Base blocks are a fixed 2s,
 * so the block number is a clock: deposit time derives from it exactly
 * (now - (head - block) * 2), unlike builder_stakes.last_deposit_at which is
 * stamped at event-PROCESSING time and drifts badly for backfilled history.
 * This is the one honest basis for the withdraw-unlock countdown. */
export async function selectLatestDepositBlocksBySubnet(
	db: D1Database,
	subnetId: string,
): Promise<{ wallet: string; blk: number }[]> {
	const r = await db
		.prepare(
			`SELECT wallet, MAX(block_number) as blk FROM builder_events
       WHERE subnet_id = ? AND event_type = 'deposit' GROUP BY wallet`,
		)
		.bind(subnetId)
		.all<{ wallet: string; blk: number }>();
	return r.results ?? [];
}

/** Latest deposit BLOCK per subnet for one wallet (same clock as above). */
export async function selectLatestDepositBlocksByWallet(
	db: D1Database,
	wallet: string,
): Promise<{ subnet_id: string; blk: number }[]> {
	const r = await db
		.prepare(
			`SELECT subnet_id, MAX(block_number) as blk FROM builder_events
       WHERE wallet = ? AND event_type = 'deposit' GROUP BY subnet_id`,
		)
		.bind(wallet)
		.all<{ subnet_id: string; blk: number }>();
	return r.results ?? [];
}

/** Top stakers of one subnet by deposited amount. */
export async function selectTopSubnetStakers(
	db: D1Database,
	subnetId: string,
): Promise<BuilderRawRow[]> {
	const r = await db
		.prepare(
			"SELECT * FROM builder_stakes WHERE subnet_id = ? ORDER BY CAST(deposited AS REAL) DESC LIMIT 50",
		)
		.bind(subnetId)
		.all();
	return r.results ?? [];
}

/** Recent events of one subnet, deduped by tx/log/event. */
export async function selectRecentSubnetEvents(
	db: D1Database,
	subnetId: string,
): Promise<BuilderRawRow[]> {
	const r = await db
		.prepare(
			"SELECT * FROM builder_events WHERE subnet_id = ? GROUP BY tx_hash, log_index, event_type ORDER BY block_number DESC LIMIT 50",
		)
		.bind(subnetId)
		.all();
	return r.results ?? [];
}

/** Total MOR claimed on one subnet (deduped claim events). */
export function sumSubnetClaims(
	db: D1Database,
	subnetId: string,
): Promise<BuilderRawRow | null> {
	return db
		.prepare(
			"SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM (SELECT DISTINCT tx_hash, log_index, amount FROM builder_events WHERE subnet_id = ? AND event_type = 'claim')",
		)
		.bind(subnetId)
		.first();
}

/** Distinct wallets that ever deposited into one subnet. */
export function countSubnetDepositors(
	db: D1Database,
	subnetId: string,
): Promise<BuilderRawRow | null> {
	return db
		.prepare(
			"SELECT COUNT(DISTINCT wallet) as cnt FROM builder_events WHERE subnet_id = ? AND event_type = 'deposit'",
		)
		.bind(subnetId)
		.first();
}

/** Latest claim block on one subnet. */
export function selectLastSubnetClaimBlock(
	db: D1Database,
	subnetId: string,
): Promise<BuilderRawRow | null> {
	return db
		.prepare(
			"SELECT MAX(block_number) as b FROM builder_events WHERE subnet_id = ? AND event_type = 'claim'",
		)
		.bind(subnetId)
		.first();
}

/** First deposit block on one subnet. */
export function selectFirstSubnetDepositBlock(
	db: D1Database,
	subnetId: string,
): Promise<BuilderRawRow | null> {
	return db
		.prepare(
			"SELECT MIN(block_number) as b FROM builder_events WHERE subnet_id = ? AND event_type = 'deposit'",
		)
		.bind(subnetId)
		.first();
}

// ─── Wallet positions ───

/** One wallet's builder positions with subnet metadata. */
export async function selectWalletBuilderStakes(
	db: D1Database,
	wallet: string,
): Promise<BuilderRawRow[]> {
	const r = await db
		.prepare(`
    SELECT s.*, sub.name, sub.withdraw_lock_period
    FROM builder_stakes s
    JOIN builder_subnets sub ON s.subnet_id = sub.subnet_id
    WHERE s.wallet = ? AND CAST(s.deposited AS REAL) > 0
    ORDER BY CAST(s.deposited AS REAL) DESC
  `)
		.bind(wallet)
		.all();
	return r.results ?? [];
}
