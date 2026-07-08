/**
 * Explorer core data-access layer.
 *
 * D1 queries for the fatboy blob, health/status, holders, analytics,
 * gas backfill, capacity introspection, and the admin alert log.
 * SQL strings are moved verbatim from the handlers; every function takes
 * the D1 database first. Read executors return `T[]` (`r.results ?? []`)
 * or `T | null` (`.first()`); write executors pass the D1Result through.
 */

// ─── Row shapes ───

/** Generic untyped row - queries whose handlers consume raw records. */
export type RawRow = Record<string, unknown>;

export interface SyncValueRow {
	value: string;
}

export interface SyncKeyValueRow {
	key: string;
	value: string;
}

export interface CountRow {
	c: number;
}

export interface ServingProviderRow {
	provider: string;
}

export interface EscrowSplitRow {
	serving_mor: number;
	zombie_mor: number;
}

export interface GasLifecycleRow {
	avg_eth: number;
	lifecycle_eth: number;
}

export interface AvgSessionDurationRow {
	avg_secs: number;
}

export interface HolderCountsRow {
	with_balance: number;
	meaningful: number;
	dust: number;
}

export interface HolderTotalRow {
	cnt: number;
}

export interface GasOperationStatsRow {
	operation: string;
	count: number;
	avg_eth: number;
	min_eth: number;
	max_eth: number;
	total_eth: number;
	avg_gas_used: number;
}

export interface SessionDurationStatsRow {
	total_closed: number;
	avg_duration_secs: number;
	avg_expected_duration_secs: number;
	early_terminations: number;
	disputes: number;
	avg_full_duration_secs: number;
	avg_early_duration_secs: number;
	avg_stake_mor: number;
	min_stake_mor: number;
	max_stake_mor: number;
}

export interface WalletSessionOpensRow {
	opens: number;
}

export interface WalletGasStatsRow {
	receipts: number;
	total_eth: number;
	avg_eth: number;
}

export interface AvgGasRow {
	avg_eth: number;
}

export interface WalletDurationStatsRow {
	avg_duration_secs: number;
	min_duration_secs: number;
	max_duration_secs: number;
}

// ─── Fatboy (SPA ui-init blob) ───

/** Providers with at least one active bid - drives the serving/zombie split. */
export async function selectServingProviders(
	db: D1Database,
): Promise<ServingProviderRow[]> {
	const r = await db
		.prepare(
			"SELECT DISTINCT provider FROM bids WHERE deleted_at = 0 OR deleted_at IS NULL",
		)
		.all<ServingProviderRow>();
	return r.results ?? [];
}

// Cached token price blob: use getSyncStateTokenPrices from explorer-market.ts (canonical).

/** Latest network economics row. */
export function selectLatestEconomics(db: D1Database): Promise<RawRow | null> {
	return db
		.prepare("SELECT * FROM network_economics ORDER BY rowid DESC LIMIT 1")
		.first();
}

/** Most recent providers for the fatboy provider list. */
export async function selectRecentProviders(db: D1Database): Promise<RawRow[]> {
	const r = await db
		.prepare("SELECT * FROM providers ORDER BY rowid DESC LIMIT 15")
		.all();
	return r.results ?? [];
}

/** Active (non-deleted) bids for the fatboy provider list. */
export async function selectActiveBids(db: D1Database): Promise<RawRow[]> {
	const r = await db
		.prepare(
			"SELECT * FROM bids WHERE (deleted_at = 0 OR deleted_at IS NULL) ORDER BY rowid DESC LIMIT 500",
		)
		.all();
	return r.results ?? [];
}

// Named model id/name pairs: use getNamedModelIdNames from explorer-market.ts (canonical).

/** Most recently opened sessions. */
export async function selectRecentSessions(db: D1Database): Promise<RawRow[]> {
	const r = await db
		.prepare("SELECT * FROM sessions ORDER BY opened_at DESC LIMIT 20")
		.all();
	return r.results ?? [];
}

/** Top consumer wallets by total sessions. */
export async function selectTopWalletStats(db: D1Database): Promise<RawRow[]> {
	const r = await db
		.prepare("SELECT * FROM wallet_stats ORDER BY total_sessions DESC LIMIT 10")
		.all();
	return r.results ?? [];
}

/** All-time provider leaderboard. */
export async function selectProviderLeaderboardAllTime(
	db: D1Database,
): Promise<RawRow[]> {
	const r = await db
		.prepare(
			"SELECT provider, COUNT(*) as sessions, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_now, SUM(CASE WHEN closed_at > 0 AND closeout_type = 0 THEN 1 ELSE 0 END) as successful FROM sessions GROUP BY provider ORDER BY active_now DESC, sessions DESC LIMIT 15",
		)
		.all();
	return r.results ?? [];
}

/** Provider leaderboard for sessions opened after the cutoff. */
export async function selectProviderLeaderboardSince(
	db: D1Database,
	sinceTs: number,
): Promise<RawRow[]> {
	const r = await db
		.prepare(
			"SELECT provider, COUNT(*) as sessions, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_now FROM sessions WHERE opened_at > ? GROUP BY provider ORDER BY active_now DESC, sessions DESC LIMIT 15",
		)
		.bind(sinceTs)
		.all();
	return r.results ?? [];
}

/**
 * All-time consumer-wallet leaderboard. `servingIn` is a pre-sanitized,
 * quoted IN-list of serving providers (built by the fatboy handler).
 */
export async function selectWalletLeaderboardAllTime(
	db: D1Database,
	servingIn: string,
): Promise<RawRow[]> {
	const r = await db
		.prepare(`SELECT s.user_address as wallet, COUNT(*) as total_sessions,
      SUM(CASE WHEN s.is_active = 1 AND s.provider IN (${servingIn}) THEN 1 ELSE 0 END) as serving,
      SUM(CASE WHEN s.is_active = 1 AND s.provider NOT IN (${servingIn}) THEN 1 ELSE 0 END) as zombie,
      SUM(CASE WHEN s.is_active = 1 THEN CAST(s.stake AS REAL) / 1e18 ELSE 0 END) as active_stake
      FROM sessions s
      GROUP BY s.user_address ORDER BY serving DESC, total_sessions DESC LIMIT 25`)
		.all();
	return r.results ?? [];
}

/** Consumer-wallet leaderboard for sessions opened after the cutoff. */
export async function selectWalletLeaderboardSince(
	db: D1Database,
	servingIn: string,
	sinceTs: number,
): Promise<RawRow[]> {
	const r = await db
		.prepare(`SELECT s.user_address as wallet, COUNT(*) as total_sessions,
      SUM(CASE WHEN s.is_active = 1 AND s.provider IN (${servingIn}) THEN 1 ELSE 0 END) as serving
      FROM sessions s
      WHERE s.opened_at > ? GROUP BY s.user_address ORDER BY serving DESC, total_sessions DESC LIMIT 25`)
		.bind(sinceTs)
		.all();
	return r.results ?? [];
}

/** Total provider count. */
export function countProviders(db: D1Database): Promise<CountRow | null> {
	return db.prepare("SELECT COUNT(*) as c FROM providers").first<CountRow>();
}

/** Active (non-deleted) bid count. */
export function countActiveBids(db: D1Database): Promise<CountRow | null> {
	return db
		.prepare("SELECT COUNT(*) as c FROM bids WHERE deleted_at = 0 OR deleted_at IS NULL")
		.first<CountRow>();
}

/** Active sessions whose provider is still serving (has active bids). */
export function countServingSessions(
	db: D1Database,
	servingIn: string,
): Promise<CountRow | null> {
	return db
		.prepare(`SELECT COUNT(*) as c FROM sessions s
      WHERE s.is_active = 1 AND s.provider IN (${servingIn})`)
		.first<CountRow>();
}

/** Active sessions whose provider retracted all bids (zombie). */
export function countZombieSessions(
	db: D1Database,
	servingIn: string,
): Promise<CountRow | null> {
	return db
		.prepare(`SELECT COUNT(*) as c FROM sessions s
      WHERE s.is_active = 1 AND s.provider NOT IN (${servingIn})`)
		.first<CountRow>();
}

/** Total session count. */
export function countAllSessions(db: D1Database): Promise<CountRow | null> {
	return db.prepare("SELECT COUNT(*) as c FROM sessions").first<CountRow>();
}

/** MOR in escrow split into serving (live) vs zombie (stuck). */
export function selectEscrowSplit(
	db: D1Database,
	servingIn: string,
): Promise<EscrowSplitRow | null> {
	return db
		.prepare(`SELECT
      SUM(CASE WHEN s.provider IN (${servingIn}) THEN CAST(s.stake AS REAL) / 1e18 ELSE 0 END) as serving_mor,
      SUM(CASE WHEN s.provider NOT IN (${servingIn}) THEN CAST(s.stake AS REAL) / 1e18 ELSE 0 END) as zombie_mor
      FROM sessions s
      WHERE s.is_active = 1`)
		.first<EscrowSplitRow>();
}

/** Average gas cost + open-plus-close lifecycle ETH. */
export function selectGasLifecycleStats(db: D1Database): Promise<GasLifecycleRow | null> {
	return db
		.prepare(`SELECT
      AVG(CAST(eth_cost AS REAL)) as avg_eth,
      SUM(CASE WHEN operation='open' THEN CAST(eth_cost AS REAL) ELSE 0 END) / NULLIF(SUM(CASE WHEN operation='open' THEN 1 ELSE 0 END),0)
        + SUM(CASE WHEN operation='close' THEN CAST(eth_cost AS REAL) ELSE 0 END) / NULLIF(SUM(CASE WHEN operation='close' THEN 1 ELSE 0 END),0) as lifecycle_eth
      FROM gas_costs`)
		.first<GasLifecycleRow>();
}

/** Average duration of the last 1000 closed sessions. */
export function selectAvgSessionDuration(
	db: D1Database,
): Promise<AvgSessionDurationRow | null> {
	return db
		.prepare(`SELECT AVG(closed_at - opened_at) as avg_secs FROM (
      SELECT closed_at, opened_at FROM sessions WHERE closed_at > 0 ORDER BY closed_at DESC LIMIT 1000
    )`)
		.first<AvgSessionDurationRow>();
}

/** Active session counts grouped by provider. */
export async function selectActiveSessionsByProvider(db: D1Database): Promise<RawRow[]> {
	const r = await db
		.prepare(
			"SELECT provider, COUNT(*) as active FROM sessions WHERE is_active = 1 GROUP BY provider",
		)
		.all();
	return r.results ?? [];
}

/** Active session counts grouped by bid. */
export async function selectActiveSessionsByBid(db: D1Database): Promise<RawRow[]> {
	const r = await db
		.prepare(
			"SELECT bid_id, COUNT(*) as active FROM sessions WHERE is_active = 1 GROUP BY bid_id",
		)
		.all();
	return r.results ?? [];
}

/** Session demand aggregated by model (24h/7d windows). */
export async function selectModelDemand(
	db: D1Database,
	dayCutoff: number,
	weekCutoff: number,
): Promise<RawRow[]> {
	const r = await db
		.prepare(`SELECT model_id,
      COUNT(*) as total_sessions,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_sessions,
      SUM(CASE WHEN opened_at > ? THEN 1 ELSE 0 END) as sessions_24h,
      SUM(CASE WHEN opened_at > ? THEN 1 ELSE 0 END) as sessions_7d,
      COUNT(DISTINCT user_address) as unique_users
      FROM sessions GROUP BY model_id ORDER BY sessions_24h DESC, total_sessions DESC LIMIT 20
    `)
		.bind(dayCutoff, weekCutoff)
		.all();
	return r.results ?? [];
}

/** Overwrite the cached fatboy blob. */
export function upsertFatboyCache(db: D1Database, json: string): Promise<D1Result> {
	return db
		.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('fatboy_cache', ?)")
		.bind(json)
		.run();
}

/** Read the cached fatboy blob. */
export function selectFatboyCache(db: D1Database): Promise<SyncValueRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = 'fatboy_cache'")
		.first<SyncValueRow>();
}

// ─── Health / status ───

/** Read four sync_state entries in one query (health snapshot). */
export async function selectSyncStateIn4(
	db: D1Database,
	k1: string,
	k2: string,
	k3: string,
	k4: string,
): Promise<SyncKeyValueRow[]> {
	const r = await db
		.prepare("SELECT key, value FROM sync_state WHERE key IN (?, ?, ?, ?)")
		.bind(k1, k2, k3, k4)
		.all<SyncKeyValueRow>();
	return r.results ?? [];
}

/** Read three sync_state entries in one query (sync status snapshot). */
export async function selectSyncStateIn3(
	db: D1Database,
	k1: string,
	k2: string,
	k3: string,
): Promise<SyncKeyValueRow[]> {
	const r = await db
		.prepare("SELECT key, value FROM sync_state WHERE key IN (?, ?, ?)")
		.bind(k1, k2, k3)
		.all<SyncKeyValueRow>();
	return r.results ?? [];
}

/** Staking factor + freshness timestamp for /health. */
export function selectEconomicsHealth(db: D1Database): Promise<RawRow | null> {
	return db
		.prepare("SELECT staking_factor, updated_at FROM network_economics WHERE id = 1")
		.first();
}

/** Event-cursor block written by the compute event scanner. */
export function selectLastEventBlock(db: D1Database): Promise<RawRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = 'last_event_block'")
		.first();
}

/** Most recent diamond upgrade event. */
export function selectLatestDiamondUpgrade(db: D1Database): Promise<RawRow | null> {
	return db
		.prepare(
			"SELECT block_number, tx_hash, facet_count, block_timestamp FROM diamond_upgrades ORDER BY block_number DESC LIMIT 1",
		)
		.first();
}

// Total diamond upgrade count: use countDiamondUpgrades from explorer-market.ts (canonical).

/** Chain-head block cached by the sync tick. */
export function selectCurrentBlockValue(db: D1Database): Promise<SyncValueRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = 'current_block'")
		.first<SyncValueRow>();
}

// ─── Holders ───

/**
 * Holder counts: with balance, meaningful (>= dust threshold), dust.
 * `minWei` is a numeric wei-string constant interpolated into the SQL
 * (moved verbatim from the handler).
 */
export function selectHolderCounts(
	db: D1Database,
	minWei: string,
): Promise<HolderCountsRow | null> {
	return db
		.prepare(`
      SELECT
        SUM(CASE WHEN CAST(COALESCE(mor_balance_wei,'0') AS REAL) > 0 THEN 1 ELSE 0 END) as with_balance,
        SUM(CASE WHEN CAST(COALESCE(mor_balance_wei,'0') AS REAL) >= ${minWei} THEN 1 ELSE 0 END) as meaningful,
        SUM(CASE WHEN CAST(COALESCE(mor_balance_wei,'0') AS REAL) > 0 AND CAST(COALESCE(mor_balance_wei,'0') AS REAL) < ${minWei} THEN 1 ELSE 0 END) as dust
      FROM mor_holders WHERE updated_at > 0
    `)
		.first<HolderCountsRow>();
}

/** Ranked holder page: balance desc, wallet asc tiebreak. */
export async function selectRankedHolders(
	db: D1Database,
	limit: number,
	offset: number,
): Promise<RawRow[]> {
	const r = await db
		.prepare(`
      SELECT h.wallet, h.mor_balance_wei, h.eth_balance_wei, h.has_sessions, h.last_transfer_block, h.updated_at,
        EXISTS(SELECT 1 FROM providers p WHERE p.address = h.wallet) as is_provider,
        EXISTS(SELECT 1 FROM sessions s WHERE s.user_address = h.wallet LIMIT 1) as is_consumer,
        EXISTS(SELECT 1 FROM builder_stakes bs WHERE bs.wallet = h.wallet AND CAST(bs.deposited AS REAL) > 0) as is_staker
      FROM mor_holders h
      WHERE h.updated_at > 0 AND CAST(COALESCE(h.mor_balance_wei, '0') AS REAL) > 0
      ORDER BY CAST(COALESCE(h.mor_balance_wei, '0') AS REAL) DESC, h.wallet ASC
      LIMIT ? OFFSET ?
    `)
		.bind(limit, offset)
		.all();
	return r.results ?? [];
}

/** Total wallets ever discovered (including unrefreshed). */
export function countDiscoveredHolders(db: D1Database): Promise<HolderTotalRow | null> {
	return db.prepare("SELECT COUNT(*) as cnt FROM mor_holders").first<HolderTotalRow>();
}

/**
 * Count of dust/former holders with no network participation.
 * Strictly `< minWei` so the dust set is disjoint from the meaningful set
 * (`>= minWei` on the main holders page); balance-0 former holders stay included.
 */
export function countDustHolders(
	db: D1Database,
	minWei: string,
): Promise<HolderTotalRow | null> {
	return db
		.prepare(`
      SELECT COUNT(*) as cnt FROM mor_holders h
      WHERE CAST(COALESCE(h.mor_balance_wei, '0') AS REAL) < ${minWei}
        AND h.updated_at > 0
        AND NOT EXISTS(SELECT 1 FROM providers p WHERE p.address = h.wallet)
        AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.user_address = h.wallet LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM builder_stakes bs WHERE bs.wallet = h.wallet AND CAST(bs.deposited AS REAL) > 0)
    `)
		.first<HolderTotalRow>();
}

/** Dust/former holder page, most recent transfer first (strictly `< minWei`, see countDustHolders). */
export async function selectDustHolders(
	db: D1Database,
	minWei: string,
	limit: number,
	offset: number,
): Promise<RawRow[]> {
	const r = await db
		.prepare(`
      SELECT h.wallet, h.mor_balance_wei, h.last_transfer_block, h.updated_at
      FROM mor_holders h
      WHERE CAST(COALESCE(h.mor_balance_wei, '0') AS REAL) < ${minWei}
        AND h.updated_at > 0
        AND NOT EXISTS(SELECT 1 FROM providers p WHERE p.address = h.wallet)
        AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.user_address = h.wallet LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM builder_stakes bs WHERE bs.wallet = h.wallet AND CAST(bs.deposited AS REAL) > 0)
      ORDER BY h.last_transfer_block DESC
      LIMIT ? OFFSET ?
    `)
		.bind(limit, offset)
		.all();
	return r.results ?? [];
}

// ─── Analytics (gas + session duration) ───

/** Gas cost aggregates grouped by operation. */
export async function selectGasStatsByOperation(
	db: D1Database,
): Promise<GasOperationStatsRow[]> {
	const r = await db
		.prepare(`
    SELECT
      operation,
      COUNT(*) as count,
      AVG(CAST(eth_cost AS REAL)) as avg_eth,
      MIN(CAST(eth_cost AS REAL)) as min_eth,
      MAX(CAST(eth_cost AS REAL)) as max_eth,
      SUM(CAST(eth_cost AS REAL)) as total_eth,
      AVG(gas_used) as avg_gas_used
    FROM gas_costs
    GROUP BY operation
  `)
		.all<GasOperationStatsRow>();
	return r.results ?? [];
}

/** Duration + stake stats over the last 1000 closed sessions. */
export function selectClosedSessionStats(
	db: D1Database,
): Promise<SessionDurationStatsRow | null> {
	return db
		.prepare(`
    SELECT
      COUNT(*) as total_closed,
      AVG(closed_at - opened_at) as avg_duration_secs,
      AVG(ends_at - opened_at) as avg_expected_duration_secs,
      SUM(CASE WHEN closed_at < ends_at THEN 1 ELSE 0 END) as early_terminations,
      SUM(CASE WHEN closeout_type = 1 THEN 1 ELSE 0 END) as disputes,
      AVG(CASE WHEN closed_at >= ends_at THEN closed_at - opened_at END) as avg_full_duration_secs,
      AVG(CASE WHEN closed_at < ends_at THEN closed_at - opened_at END) as avg_early_duration_secs,
      AVG(CAST(stake AS REAL)) as avg_stake_mor,
      MIN(CAST(stake AS REAL)) as min_stake_mor,
      MAX(CAST(stake AS REAL)) as max_stake_mor
    FROM (
      SELECT closed_at, opened_at, ends_at, closeout_type, stake
      FROM sessions
      WHERE closed_at > 0
      ORDER BY closed_at DESC
      LIMIT 1000
    )
  `)
		.first<SessionDurationStatsRow>();
}

/** Sessions with tx hashes that still lack a gas receipt. */
export function countPendingGasReceipts(db: D1Database): Promise<HolderTotalRow | null> {
	return db
		.prepare(`
    SELECT COUNT(*) as cnt FROM sessions
    WHERE (open_tx_hash IS NOT NULL AND open_tx_hash NOT IN (SELECT tx_hash FROM gas_costs WHERE operation = 'open'))
       OR (close_tx_hash IS NOT NULL AND close_tx_hash NOT IN (SELECT tx_hash FROM gas_costs WHERE operation = 'close'))
  `)
		.first<HolderTotalRow>();
}

// ─── Gas backfill + per-wallet gas ───

/** Cursor for the tx-hash backfill scan. */
export function selectTxBackfillBlock(db: D1Database): Promise<SyncValueRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = 'tx_backfill_block'")
		.first<SyncValueRow>();
}

/** Attach an open tx hash to a session that lacks one. */
export function updateSessionOpenTxHash(
	db: D1Database,
	txHash: string,
	sessionId: string,
): Promise<D1Result> {
	return db
		.prepare("UPDATE sessions SET open_tx_hash = ? WHERE id = ? AND open_tx_hash IS NULL")
		.bind(txHash, sessionId)
		.run();
}

/** Attach a close tx hash to a session that lacks one. */
export function updateSessionCloseTxHash(
	db: D1Database,
	txHash: string,
	sessionId: string,
): Promise<D1Result> {
	return db
		.prepare(
			"UPDATE sessions SET close_tx_hash = ? WHERE id = ? AND close_tx_hash IS NULL",
		)
		.bind(txHash, sessionId)
		.run();
}

/** Advance the tx-hash backfill cursor. */
export function upsertTxBackfillBlock(db: D1Database, block: string): Promise<D1Result> {
	return db
		.prepare(
			"INSERT OR REPLACE INTO sync_state (key, value) VALUES ('tx_backfill_block', ?)",
		)
		.bind(block)
		.run();
}

/** Session opens for one wallet. */
export function countWalletSessionOpens(
	db: D1Database,
	wallet: string,
): Promise<WalletSessionOpensRow | null> {
	return db
		.prepare("SELECT COUNT(*) as opens FROM sessions WHERE user_address = ?")
		.bind(wallet)
		.first<WalletSessionOpensRow>();
}

/** Actual gas receipts recorded for one wallet's sessions. */
export function selectWalletGasStats(
	db: D1Database,
	wallet: string,
): Promise<WalletGasStatsRow | null> {
	return db
		.prepare(`
      SELECT COUNT(*) as receipts, SUM(CAST(eth_cost AS REAL)) as total_eth, AVG(CAST(eth_cost AS REAL)) as avg_eth
      FROM gas_costs
      WHERE session_id IN (SELECT id FROM sessions WHERE user_address = ?)
    `)
		.bind(wallet)
		.first<WalletGasStatsRow>();
}

/** Network-wide average gas cost per tx. */
export function selectAvgGasPerTx(db: D1Database): Promise<AvgGasRow | null> {
	return db
		.prepare("SELECT AVG(CAST(eth_cost AS REAL)) as avg_eth FROM gas_costs")
		.first<AvgGasRow>();
}

/** Expected session duration stats for one wallet. */
export function selectWalletSessionDurationStats(
	db: D1Database,
	wallet: string,
): Promise<WalletDurationStatsRow | null> {
	return db
		.prepare(`
    SELECT AVG(ends_at - opened_at) as avg_duration_secs,
           MIN(ends_at - opened_at) as min_duration_secs,
           MAX(ends_at - opened_at) as max_duration_secs
    FROM sessions
    WHERE user_address = ? AND ends_at > opened_at
  `)
		.bind(wallet)
		.first<WalletDurationStatsRow>();
}

// ─── Capacity introspection ───

// Key caps + usage counters: use getApiKeyCaps / listUsageCounters from auth.ts (canonical).

// ─── Admin alert log ───

/** Most recent operational alerts. */
export async function selectRecentAlerts(db: D1Database): Promise<RawRow[]> {
	const r = await db
		.prepare(
			"SELECT id, ts, level, kind, message, resolved FROM alerts ORDER BY id DESC LIMIT 200",
		)
		.all();
	return r.results ?? [];
}
