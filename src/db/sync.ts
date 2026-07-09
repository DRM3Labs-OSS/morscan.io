/**
 * Sync engine data-access layer - compute side.
 *
 * Every inline SQL string from the compute sync files (src/sync/compute*.ts,
 * src/sync/holder-coverage.ts, src/durable/SyncCoordinator.ts) lives here
 * verbatim. Builder subnet + MOR holder queries live in sync-builder.ts.
 *
 * Two function shapes:
 *   - async executors: run the query and return typed rows
 *   - *Stmt builders: return a bound D1PreparedStatement for env.DB.batch()
 */

// Shared row shapes (raw D1 rows - distinct from the API-facing types.ts shapes).
export interface KeyValueRow {
	key: string;
	value: string;
}

export interface ProviderAddressRow {
	provider: string;
}

export interface ProviderBidCountRow {
	provider: string;
	cnt: number;
}

export interface ModelIdRow {
	model_id: string;
}

export interface SessionParticipantRow {
	user_address: string;
	provider: string;
	model_id: string;
}

export interface CountRow {
	c: number;
}

// ─── sync_state ───

export function setSyncStateStmt(
	db: D1Database,
	key: string,
	value: string,
): D1PreparedStatement {
	return db
		.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)")
		.bind(key, value);
}

export async function setSyncState(
	db: D1Database,
	key: string,
	value: string,
): Promise<D1Result> {
	return setSyncStateStmt(db, key, value).run();
}

// Single-key sync_state read: use getSyncStateValue from ops.ts (canonical).

/** Dynamic IN-list read (holder-coverage backfill state keys). */
export async function getSyncStateByKeys(
	db: D1Database,
	keys: string[],
): Promise<KeyValueRow[]> {
	const ph = keys.map(() => "?").join(",");
	const r = await db
		.prepare(`SELECT key, value FROM sync_state WHERE key IN (${ph})`)
		.bind(...keys)
		.all<KeyValueRow>();
	return r.results ?? [];
}

/** Fixed two-key read (SyncCoordinator cursor + freshness). */
export async function getSyncStatePair(
	db: D1Database,
	keyA: string,
	keyB: string,
): Promise<KeyValueRow[]> {
	const r = await db
		.prepare("SELECT key, value FROM sync_state WHERE key IN (?, ?)")
		.bind(keyA, keyB)
		.all<KeyValueRow>();
	return r.results ?? [];
}

// ─── providers ───

export function upsertProviderStmt(
	db: D1Database,
	address: string,
	endpoint: string,
	stake: string,
	createdAt: number,
	updatedBlock: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR REPLACE INTO providers (address, endpoint, stake, created_at, updated_block) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(address, endpoint, stake, createdAt, updatedBlock);
}

// ─── bids ───

/** Every provider address seen in bids or sessions (discovery input). */
export async function getKnownProviderAddresses(
	db: D1Database,
): Promise<ProviderAddressRow[]> {
	const r = await db
		.prepare(
			`SELECT DISTINCT provider FROM bids
       UNION
       SELECT DISTINCT provider FROM sessions`,
		)
		.all<ProviderAddressRow>();
	return r.results ?? [];
}

export async function getActiveBidCountsByProvider(
	db: D1Database,
): Promise<ProviderBidCountRow[]> {
	const r = await db
		.prepare(
			`SELECT provider, COUNT(*) as cnt FROM bids WHERE (deleted_at = 0 OR deleted_at IS NULL) GROUP BY provider`,
		)
		.all<ProviderBidCountRow>();
	return r.results ?? [];
}

export function upsertBidStmt(
	db: D1Database,
	bidId: string,
	provider: string,
	modelId: string,
	pricePerSecond: string,
	nonce: number,
	createdAt: number,
	deletedAt: number,
	updatedBlock: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR REPLACE INTO bids (bid_id, provider, model_id, price_per_second, nonce, created_at, deleted_at, updated_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			bidId,
			provider,
			modelId,
			pricePerSecond,
			nonce,
			createdAt,
			deletedAt,
			updatedBlock,
		);
}

export function markBidsDeletedStmt(
	db: D1Database,
	deletedAt: number,
	updatedBlock: number,
	provider: string,
	modelId: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE bids SET deleted_at = ?, updated_block = ? WHERE provider = ? AND model_id = ? AND deleted_at = 0`,
		)
		.bind(deletedAt, updatedBlock, provider, modelId);
}

/** Model ids referenced by live bids that have no row in models yet. */
export async function getUnnamedBidModelIds(db: D1Database): Promise<ModelIdRow[]> {
	const r = await db
		.prepare(
			`SELECT DISTINCT b.model_id FROM bids b
       LEFT JOIN models m ON b.model_id = m.model_id
       WHERE m.model_id IS NULL AND b.model_id != ''
       AND (b.deleted_at = 0 OR b.deleted_at IS NULL)`,
		)
		.all<ModelIdRow>();
	return r.results ?? [];
}

// ─── models ───

export function upsertModelStmt(
	db: D1Database,
	modelId: string,
	name: string,
	tags: string,
	updatedAt: number,
): D1PreparedStatement {
	// ON CONFLICT (not INSERT OR REPLACE): REPLACE deleted the whole row and
	// re-inserted WITHOUT created_at, so every sync refresh wiped every
	// model's first-seen stamp back to NULL (the newcomers panel read empty
	// forever). New models stamp first-seen at insert; refreshes preserve it.
	return db
		.prepare(
			`INSERT INTO models (model_id, name, tags, updated_at, created_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(model_id) DO UPDATE SET
         name = excluded.name, tags = excluded.tags, updated_at = excluded.updated_at`,
		)
		.bind(modelId, name, tags, updatedAt);
}

// ─── sessions ───

export function insertSessionStmt(
	db: D1Database,
	id: string,
	userAddress: string,
	bidId: string,
	provider: string,
	modelId: string,
	stake: string,
	openedAt: number,
	endsAt: number,
	updatedBlock: number,
	openTxHash: string,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR REPLACE INTO sessions (id, user_address, bid_id, provider, model_id, stake, opened_at, ends_at, closed_at, is_active, updated_block, open_tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
		)
		.bind(
			id,
			userAddress,
			bidId,
			provider,
			modelId,
			stake,
			openedAt,
			endsAt,
			updatedBlock,
			openTxHash,
		);
}

/** Wallet + provider/model pairs for a dynamic list of session ids. */
export async function getSessionParticipantsByIds(
	db: D1Database,
	ids: string[],
): Promise<SessionParticipantRow[]> {
	const ph = ids.map(() => "?").join(",");
	const r = await db
		.prepare(
			`SELECT DISTINCT user_address, provider, model_id FROM sessions WHERE id IN (${ph})`,
		)
		.bind(...ids)
		.all<SessionParticipantRow>();
	return r.results ?? [];
}

export function closeSessionStmt(
	db: D1Database,
	closedAt: number,
	updatedBlock: number,
	closeTxHash: string,
	sessionId: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE sessions SET closed_at = ?, is_active = 0, updated_block = ?, close_tx_hash = ? WHERE id = ?`,
		)
		.bind(closedAt, updatedBlock, closeTxHash, sessionId);
}

// ─── wallet_stats ───

/** Throws if wallet_stats is missing the canonical schema (probe column). */
export async function probeWalletStatsSchema(db: D1Database): Promise<void> {
	await db.prepare("SELECT active_sessions FROM wallet_stats LIMIT 1").all();
}

export async function dropWalletStatsTable(db: D1Database): Promise<void> {
	await db.exec("DROP TABLE IF EXISTS wallet_stats");
}

export async function createWalletStatsTable(db: D1Database): Promise<D1Result> {
	return db
		.prepare(`
      CREATE TABLE wallet_stats (
        wallet TEXT PRIMARY KEY,
        total_sessions INTEGER DEFAULT 0,
        active_sessions INTEGER DEFAULT 0,
        closed_sessions INTEGER DEFAULT 0,
        claimable_sessions INTEGER DEFAULT 0,
        active_stake_wei REAL DEFAULT 0,
        claimable_stake_wei REAL DEFAULT 0,
        total_historical_wei REAL DEFAULT 0,
        first_session INTEGER,
        last_session INTEGER,
        avg_duration_sec REAL,
        updated_at INTEGER
      )
    `)
		.run();
}

/** Recompute one wallet's stats from its sessions (incremental refresh). */
export async function upsertWalletStats(
	db: D1Database,
	now: number,
	wallet: string,
): Promise<D1Result> {
	return db
		.prepare(`
        INSERT OR REPLACE INTO wallet_stats (
          wallet, total_sessions, active_sessions, closed_sessions, claimable_sessions,
          active_stake_wei, claimable_stake_wei, total_historical_wei,
          first_session, last_session, avg_duration_sec, updated_at
        )
        SELECT
          user_address,
          COUNT(*),
          SUM(CASE WHEN is_active = 1 AND (ends_at = 0 OR ends_at > ?) THEN 1 ELSE 0 END),
          SUM(CASE WHEN closed_at > 0 THEN 1 ELSE 0 END),
          SUM(CASE WHEN is_active = 1 AND ends_at > 0 AND ends_at <= ? THEN 1 ELSE 0 END),
          SUM(CASE WHEN is_active = 1 AND (ends_at = 0 OR ends_at > ?) THEN CAST(stake AS REAL) ELSE 0 END),
          SUM(CASE WHEN is_active = 1 AND ends_at > 0 AND ends_at <= ? THEN CAST(stake AS REAL) ELSE 0 END),
          SUM(CAST(stake AS REAL)),
          MIN(opened_at),
          MAX(opened_at),
          AVG(CASE WHEN closed_at > 0 AND opened_at > 0 THEN closed_at - opened_at ELSE NULL END),
          ?
        FROM sessions WHERE user_address = ? GROUP BY user_address
      `)
		.bind(now, now, now, now, now, wallet)
		.run();
}

export async function clearWalletStats(db: D1Database): Promise<void> {
	await db.exec("DELETE FROM wallet_stats");
}

/** Bulk recompute of every wallet's stats from sessions (full rebuild). */
export async function insertAllWalletStats(
	db: D1Database,
	now: number,
): Promise<D1Result> {
	return db
		.prepare(`
      INSERT INTO wallet_stats (
        wallet, total_sessions, active_sessions, closed_sessions, claimable_sessions,
        active_stake_wei, claimable_stake_wei, total_historical_wei,
        first_session, last_session, avg_duration_sec, updated_at
      )
      SELECT
        user_address,
        COUNT(*),
        SUM(CASE WHEN is_active = 1 AND (ends_at = 0 OR ends_at > ?) THEN 1 ELSE 0 END),
        SUM(CASE WHEN closed_at > 0 THEN 1 ELSE 0 END),
        SUM(CASE WHEN is_active = 1 AND ends_at > 0 AND ends_at <= ? THEN 1 ELSE 0 END),
        SUM(CASE WHEN is_active = 1 AND (ends_at = 0 OR ends_at > ?) THEN CAST(stake AS REAL) ELSE 0 END),
        SUM(CASE WHEN is_active = 1 AND ends_at > 0 AND ends_at <= ? THEN CAST(stake AS REAL) ELSE 0 END),
        SUM(CAST(stake AS REAL)),
        MIN(opened_at),
        MAX(opened_at),
        AVG(CASE WHEN closed_at > 0 AND opened_at > 0 THEN closed_at - opened_at ELSE NULL END),
        ?
      FROM sessions GROUP BY user_address
    `)
		.bind(now, now, now, now, now)
		.run();
}

export async function countWalletStats(db: D1Database): Promise<CountRow | null> {
	return db.prepare("SELECT COUNT(*) as c FROM wallet_stats").first<CountRow>();
}

// ─── provider_stats ───

export async function upsertProviderStats(
	db: D1Database,
	updatedAt: number,
	provider: string,
	modelId: string,
): Promise<D1Result> {
	return db
		.prepare(`
        INSERT OR REPLACE INTO provider_stats (provider, model_id, sessions_total, sessions_active, sessions_disputed, total_stake, updated_at)
        SELECT provider, model_id, COUNT(*), SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), SUM(CASE WHEN closed_at > 0 AND close_tx_hash IS NULL THEN 1 ELSE 0 END), SUM(CAST(stake AS REAL)), ?
        FROM sessions WHERE provider = ? AND model_id = ? GROUP BY provider, model_id
      `)
		.bind(updatedAt, provider, modelId)
		.run();
}

// ─── diamond_upgrades ───

export async function createDiamondUpgradesTable(db: D1Database): Promise<D1Result> {
	return db
		.prepare(`
      CREATE TABLE IF NOT EXISTS diamond_upgrades (
        block_number INTEGER NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
        facet_changes TEXT, facet_count INTEGER DEFAULT 0, block_timestamp INTEGER,
        PRIMARY KEY (tx_hash, log_index)
      )
    `)
		.run();
}

export function insertDiamondUpgradeStmt(
	db: D1Database,
	blockNumber: number,
	txHash: string,
	logIndex: number,
	facetChanges: string,
	facetCount: number,
	blockTimestamp: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO diamond_upgrades (block_number, tx_hash, log_index, facet_changes, facet_count, block_timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(blockNumber, txHash, logIndex, facetChanges, facetCount, blockTimestamp);
}

// ─── network_economics ───

export async function upsertNetworkEconomics(
	db: D1Database,
	computeBalance: string,
	totalSupply: string,
	stakingFactor: number,
	updatedAt: number,
): Promise<D1Result> {
	return db
		.prepare(
			`INSERT OR REPLACE INTO network_economics (id, compute_balance, total_supply, staking_factor, updated_at) VALUES (1, ?, ?, ?, ?)`,
		)
		.bind(computeBalance, totalSupply, stakingFactor, updatedAt)
		.run();
}

// ─── economics_history ───

export async function insertEconomicsHistory(
	db: D1Database,
	date: string,
	computeBalance: string,
	totalSupply: string,
	stakingFactor: number,
): Promise<D1Result> {
	return db
		.prepare(
			`INSERT OR IGNORE INTO economics_history (date, compute_balance, total_mor_supply, staking_factor) VALUES (?, ?, ?, ?)`,
		)
		.bind(date, computeBalance, totalSupply, stakingFactor)
		.run();
}
