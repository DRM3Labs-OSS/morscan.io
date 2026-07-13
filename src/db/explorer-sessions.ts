/**
 * Explorer data-access layer - sessions side.
 *
 * Session lists and aggregates, per-wallet views, wallet_stats, leaderboards,
 * provider_stats reputation reads, MOR holder counts, and the wallet-profile
 * builder-stake reads used by the j-z handlers. SQL is moved verbatim from the
 * handlers; behavior is byte-identical.
 */

// ─── Row shapes ───

export interface SessionCountRow {
	count: number;
}

export interface HolderTierCountsRow {
	with_balance: number;
	meaningful: number;
	dust: number;
}

export interface HolderTotalRow {
	total: number;
}

export interface WalletBuilderStakeRow {
	subnet_id: string;
	deposited: string;
	name: string;
}

export interface WalletAdminSubnetRow {
	subnet_id: string;
	name: string;
}

// ─── Session counts + aggregates ───

/** Total session count. */
export async function countSessions(
	db: D1Database,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare("SELECT COUNT(*) as count FROM sessions")
		.first<Record<string, unknown>>();
}

/** Count of sessions still open at `now`. */
export async function countActiveSessions(
	db: D1Database,
	now: number,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare(
			"SELECT COUNT(*) as count FROM sessions WHERE is_active = 1 AND (ends_at = 0 OR ends_at > ?)",
		)
		.bind(now)
		.first<Record<string, unknown>>();
}

/** Total stake (wei) locked in sessions still open at `now`. */
export async function sumActiveSessionStake(
	db: D1Database,
	now: number,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare(
			"SELECT SUM(CAST(stake AS REAL)) as total FROM sessions WHERE is_active = 1 AND (ends_at = 0 OR ends_at > ?)",
		)
		.bind(now)
		.first<Record<string, unknown>>();
}

/** Count + stake of expired-but-unclosed (claimable) sessions at `now`. */
export async function getClaimableSessionTotals(
	db: D1Database,
	now: number,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare(
			"SELECT COUNT(*) as count, SUM(CAST(stake AS REAL)) as total FROM sessions WHERE is_active = 1 AND ends_at > 0 AND ends_at < ?",
		)
		.bind(now)
		.first<Record<string, unknown>>();
}

/** Count of distinct consumer wallets. */
export async function countDistinctSessionWallets(
	db: D1Database,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare("SELECT COUNT(DISTINCT user_address) as count FROM sessions")
		.first<Record<string, unknown>>();
}

// ─── Session lists ───

/** One page of sessions, newest first. */
export async function getSessionsPage(
	db: D1Database,
	limit: number,
	offset: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare("SELECT * FROM sessions ORDER BY opened_at DESC LIMIT ? OFFSET ?")
		.bind(limit, offset)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** All sessions for a wallet, most recently updated first. */
export async function getWalletSessionsByBlock(
	db: D1Database,
	wallet: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare("SELECT * FROM sessions WHERE user_address = ? ORDER BY updated_block DESC")
		.bind(wallet)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** All sessions for a wallet (explicit columns), newest first. */
export async function getWalletSessionHistory(
	db: D1Database,
	wallet: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT id, user_address, provider, model_id, bid_id, stake,
           opened_at, ends_at, closed_at, closeout_type, is_active, updated_block
    FROM sessions
    WHERE user_address = ?
    ORDER BY opened_at DESC
  `)
		.bind(wallet)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/**
 * Statement builder: mark one expired-open session closed (chain-verified).
 * Returned unexecuted so callers can group statements into env.DB.batch().
 */
export function buildCloseExpiredSessionStmt(
	db: D1Database,
	closedAt: number,
	id: unknown,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE sessions
           SET is_active = 0, closed_at = CASE WHEN closed_at > 0 THEN closed_at ELSE ? END
           WHERE id = ? AND is_active = 1`,
		)
		.bind(closedAt, id);
}

// ─── Per-provider session views ───

/** A provider's 100 most recent sessions, joined with model names. */
export async function getRecentProviderSessions(
	db: D1Database,
	address: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT s.id, s.user_address, s.model_id, s.stake, s.opened_at, s.ends_at,
             s.closed_at, s.closeout_type, s.is_active, m.name as model_name
      FROM sessions s LEFT JOIN models m ON s.model_id = m.model_id
      WHERE s.provider = ?
      ORDER BY s.opened_at DESC LIMIT 100
    `)
		.bind(address)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Aggregate session summary for one provider. */
export async function getProviderSessionSummary(
	db: D1Database,
	now: number,
	address: string,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        SUM(CASE WHEN is_active = 1 AND (ends_at = 0 OR ends_at > ?) THEN 1 ELSE 0 END) as active_sessions,
        SUM(CASE WHEN closeout_type = 1 THEN 1 ELSE 0 END) as disputed_sessions,
        SUM(CASE WHEN is_active = 0 AND ends_at > 0 AND closed_at > 0 AND closed_at < ends_at THEN 1 ELSE 0 END) as early_terminated,
        SUM(CAST(stake AS REAL)) as total_stake_wei,
        AVG(CASE WHEN closed_at > 0 AND opened_at > 0 THEN (CASE WHEN ends_at > 0 AND ends_at < closed_at THEN ends_at ELSE closed_at END) - opened_at END) as avg_duration_secs,
        MIN(opened_at) as first_session,
        MAX(opened_at) as last_session
      FROM sessions WHERE provider = ?
    `)
		.bind(now, address)
		.first<Record<string, unknown>>();
}

/** Per-bid session counts for one provider (active = is_active flag, matching the rest of this module). */
export async function getProviderBidSessionCounts(
	db: D1Database,
	address: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT bid_id, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_count,
             SUM(CASE WHEN closeout_type = 0 AND closed_at > 0 THEN 1 ELSE 0 END) as success_count,
             SUM(CASE WHEN closeout_type = 1 THEN 1 ELSE 0 END) as dispute_count,
             COUNT(*) as total_count
      FROM sessions WHERE provider = ?
      GROUP BY bid_id
    `)
		.bind(address)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** A provider's 50 most recent sessions (reputation detail). */
export async function getProviderRecentSessions50(
	db: D1Database,
	provider: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT id, user_address, model_id, stake, opened_at, ends_at, closed_at,
           closeout_type, provider_withdrawn, is_active
    FROM sessions WHERE provider = ?
    ORDER BY opened_at DESC LIMIT 50
  `)
		.bind(provider)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

// ─── Per-model demand ───

/** Session totals grouped by model. */
export async function getModelSessionStats(
	db: D1Database,
	now: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT model_id, COUNT(*) as total_sessions,
             SUM(CASE WHEN is_active = 1 AND (ends_at = 0 OR ends_at > ?) THEN 1 ELSE 0 END) as active_sessions,
             COUNT(DISTINCT user_address) as unique_users,
             SUM(CAST(stake AS REAL)) as total_stake_wei
      FROM sessions WHERE model_id != '' GROUP BY model_id
      ORDER BY total_sessions DESC
    `)
		.bind(now)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Sessions per model in the last 24h. */
export async function getModelSessionCounts24h(
	db: D1Database,
	since: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			`SELECT model_id, COUNT(*) as sessions_24h FROM sessions WHERE opened_at > ? AND model_id != '' GROUP BY model_id`,
		)
		.bind(since)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Sessions per model in the last 7d. */
export async function getModelSessionCounts7d(
	db: D1Database,
	since: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			`SELECT model_id, COUNT(*) as sessions_7d FROM sessions WHERE opened_at > ? AND model_id != '' GROUP BY model_id`,
		)
		.bind(since)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Daily session counts since a cutoff. */
export async function getDailySessionStats(
	db: D1Database,
	since: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT
      date(opened_at, 'unixepoch') as day,
      COUNT(*) as sessions,
      COUNT(DISTINCT user_address) as unique_users,
      SUM(CAST(stake AS REAL)) as total_stake_wei
    FROM sessions
    WHERE opened_at > ?
    GROUP BY date(opened_at, 'unixepoch')
    ORDER BY day ASC
  `)
		.bind(since)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

// ─── Disputes ───

/** 100 most recent disputed sessions, joined with model names. */
export async function getDisputedSessions(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT
      s.id,
      s.user_address,
      s.provider,
      s.model_id,
      s.stake,
      s.opened_at,
      s.ends_at,
      s.closed_at,
      s.closeout_type,
      s.provider_withdrawn,
      m.name as model_name
    FROM sessions s
    LEFT JOIN models m ON s.model_id = m.model_id
    WHERE s.closeout_type = 1
    ORDER BY s.closed_at DESC
    LIMIT 100
  `)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

// ─── Leaderboards ───

/** Top 10 providers by total sessions, all time. */
export async function getTopProvidersAllTime(
	db: D1Database,
	now: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT
        s.provider,
        p.endpoint,
        COUNT(*) as total_sessions,
        SUM(CASE WHEN s.closed_at > 0 AND s.closeout_type = 0 THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN s.closeout_type = 1 THEN 1 ELSE 0 END) as disputed,
        SUM(CASE WHEN s.is_active = 1 AND (s.ends_at = 0 OR s.ends_at > ?) THEN 1 ELSE 0 END) as active_now,
        SUM(CAST(s.stake AS REAL)) / 1e18 as total_mor_staked,
        COUNT(DISTINCT s.user_address) as unique_users,
        COUNT(DISTINCT s.model_id) as unique_models,
        MIN(s.opened_at) as first_session,
        MAX(s.opened_at) as last_session
      FROM sessions s
      LEFT JOIN providers p ON s.provider = p.address
      WHERE s.provider IS NOT NULL AND s.provider != ''
      GROUP BY s.provider
      ORDER BY total_sessions DESC
      LIMIT 10
    `)
		.bind(now)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Top 10 providers by total sessions in the last 7 days. */
export async function getTopProvidersWeekly(
	db: D1Database,
	now: number,
	weekAgo: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT
        s.provider,
        p.endpoint,
        COUNT(*) as total_sessions,
        SUM(CASE WHEN s.closed_at > 0 AND s.closeout_type = 0 THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN s.closeout_type = 1 THEN 1 ELSE 0 END) as disputed,
        SUM(CASE WHEN s.is_active = 1 AND (s.ends_at = 0 OR s.ends_at > ?) THEN 1 ELSE 0 END) as active_now,
        SUM(CAST(s.stake AS REAL)) / 1e18 as total_mor_staked,
        COUNT(DISTINCT s.user_address) as unique_users,
        COUNT(DISTINCT s.model_id) as unique_models,
        MIN(s.opened_at) as first_session,
        MAX(s.opened_at) as last_session
      FROM sessions s
      LEFT JOIN providers p ON s.provider = p.address
      WHERE s.provider IS NOT NULL AND s.provider != '' AND s.opened_at >= ?
      GROUP BY s.provider
      ORDER BY total_sessions DESC
      LIMIT 10
    `)
		.bind(now, weekAgo)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Top 25 consumer wallets by total sessions, all time. */
export async function getTopWalletsAllTime(
	db: D1Database,
	now: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT
        s.user_address as wallet,
        COUNT(*) as total_sessions,
        SUM(CASE WHEN s.is_active = 1 AND (s.ends_at = 0 OR s.ends_at > ?) THEN 1 ELSE 0 END) as active_now,
        SUM(CASE WHEN s.closed_at > 0 AND s.closeout_type = 0 THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN s.closeout_type = 1 THEN 1 ELSE 0 END) as disputed,
        SUM(CAST(s.stake AS REAL)) / 1e18 as total_mor_staked,
        SUM(CASE WHEN s.is_active = 1 AND (s.ends_at = 0 OR s.ends_at > ?) THEN CAST(s.stake AS REAL) ELSE 0 END) / 1e18 as active_mor_staked,
        COUNT(DISTINCT s.provider) as unique_providers,
        COUNT(DISTINCT s.model_id) as unique_models,
        MIN(s.opened_at) as first_session,
        MAX(s.opened_at) as last_session
      FROM sessions s
      GROUP BY s.user_address
      ORDER BY total_sessions DESC
      LIMIT 25
    `)
		.bind(now, now)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Top 25 consumer wallets by total sessions in the last 7 days. */
export async function getTopWalletsWeekly(
	db: D1Database,
	now: number,
	weekAgo: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT
        s.user_address as wallet,
        COUNT(*) as total_sessions,
        SUM(CASE WHEN s.is_active = 1 AND (s.ends_at = 0 OR s.ends_at > ?) THEN 1 ELSE 0 END) as active_now,
        SUM(CASE WHEN s.closed_at > 0 AND s.closeout_type = 0 THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN s.closeout_type = 1 THEN 1 ELSE 0 END) as disputed,
        SUM(CAST(s.stake AS REAL)) / 1e18 as total_mor_staked,
        SUM(CASE WHEN s.is_active = 1 AND (s.ends_at = 0 OR s.ends_at > ?) THEN CAST(s.stake AS REAL) ELSE 0 END) / 1e18 as active_mor_staked,
        COUNT(DISTINCT s.provider) as unique_providers,
        COUNT(DISTINCT s.model_id) as unique_models,
        MIN(s.opened_at) as first_session,
        MAX(s.opened_at) as last_session
      FROM sessions s
      WHERE s.opened_at >= ?
      GROUP BY s.user_address
      ORDER BY total_sessions DESC
      LIMIT 25
    `)
		.bind(now, now, weekAgo)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

// ─── Reputation (provider_stats) ───

/** provider_stats rows aggregated per provider, busiest first. */
export async function getProviderStatsAggregated(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT
      provider,
      SUM(success_count) as success_count,
      SUM(dispute_count) as dispute_count,
      SUM(early_termination_count) as early_termination_count,
      SUM(total_sessions) as total_sessions,
      AVG(tps_scaled) as tps_scaled,
      AVG(ttft_ms) as ttft_ms
    FROM provider_stats
    GROUP BY provider
    ORDER BY total_sessions DESC
  `)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Per-model provider_stats rows for one provider (reputation detail). */
export async function getProviderModelStats(
	db: D1Database,
	provider: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT provider, model_id, success_count, dispute_count, early_termination_count,
           total_sessions, tps_scaled, ttft_ms
    FROM provider_stats
    WHERE provider = ?
    ORDER BY total_sessions DESC
  `)
		.bind(provider)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Per-model provider_stats rows for one provider (provider dashboard). */
export async function getProviderStatsRows(
	db: D1Database,
	address: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT model_id, success_count, dispute_count, early_termination_count,
             total_sessions, avg_duration_secs, updated_at
      FROM provider_stats WHERE provider = ?
    `)
		.bind(address)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Every provider_stats row (full marketplace rollup). */
export async function getAllProviderStats(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			`SELECT provider, model_id, success_count, dispute_count, early_termination_count, total_sessions, avg_duration_secs FROM provider_stats`,
		)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

// ─── Wallet stats ───

/** Precomputed wallet_stats rows, most active first. */
export async function getWalletStatsOrdered(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT * FROM wallet_stats ORDER BY active_sessions DESC, total_sessions DESC
  `)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

// ─── MOR holders ───

// Total mor_holders row count: use countDiscoveredHolders from explorer-core.ts (canonical).

/**
 * Holder counts split into with-balance / meaningful / dust tiers.
 * `minWei` is interpolated (not bound) exactly as the original inline SQL did;
 * callers pass a trusted constant.
 */
export async function getMorHolderTierCounts(
	db: D1Database,
	minWei: string,
): Promise<HolderTierCountsRow | null> {
	return db
		.prepare(`SELECT
        SUM(CASE WHEN CAST(COALESCE(mor_balance_wei,'0') AS REAL) > 0 THEN 1 ELSE 0 END) as with_balance,
        SUM(CASE WHEN CAST(COALESCE(mor_balance_wei,'0') AS REAL) >= ${minWei} THEN 1 ELSE 0 END) as meaningful,
        SUM(CASE WHEN CAST(COALESCE(mor_balance_wei,'0') AS REAL) > 0 AND CAST(COALESCE(mor_balance_wei,'0') AS REAL) < ${minWei} THEN 1 ELSE 0 END) as dust
      FROM mor_holders WHERE updated_at > 0`)
		.first<HolderTierCountsRow>();
}

/** Total MOR held across all indexed holders. */
export async function sumMorHolderBalance(
	db: D1Database,
): Promise<HolderTotalRow | null> {
	return db
		.prepare(
			`SELECT SUM(CAST(COALESCE(mor_balance_wei,'0') AS REAL) / 1e18) as total FROM mor_holders WHERE updated_at > 0`,
		)
		.first<HolderTotalRow>();
}

// ─── Wallet profile (builder roles) ───

/** A wallet's builder-subnet stakes, largest first. */
export async function getWalletBuilderStakes(
	db: D1Database,
	wallet: string,
): Promise<WalletBuilderStakeRow[]> {
	const r = await db
		.prepare(`
      SELECT s.subnet_id, s.deposited, COALESCE(NULLIF(n.name, ''), NULLIF(n.metadata_name, ''), s.subnet_id) AS name
      FROM builder_stakes s LEFT JOIN builder_subnets n ON n.subnet_id = s.subnet_id
      WHERE s.wallet = ? AND CAST(s.deposited AS REAL) > 0
      ORDER BY CAST(s.deposited AS REAL) DESC
    `)
		.bind(wallet)
		.all<WalletBuilderStakeRow>();
	return r.results ?? [];
}

/** Builder subnets this wallet administers. */
export async function getWalletAdminSubnets(
	db: D1Database,
	wallet: string,
): Promise<WalletAdminSubnetRow[]> {
	const r = await db
		.prepare(`
      SELECT subnet_id, COALESCE(NULLIF(name, ''), NULLIF(metadata_name, ''), subnet_id) AS name
      FROM builder_subnets WHERE LOWER(admin) = ?
    `)
		.bind(wallet)
		.all<WalletAdminSubnetRow>();
	return r.results ?? [];
}

/** Full session history for one wallet, newest first (wallet accounting). */
export async function listSessionsByWallet(
	db: D1Database,
	wallet: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare("SELECT * FROM sessions WHERE user_address = ? ORDER BY opened_at DESC")
		.bind(wallet)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Close a session D1 marked open that the chain says is closed (stale-row fix). */
export function fixStaleClosedSessionStmt(
	db: D1Database,
	closedAt: number,
	closeoutType: number,
	id: string,
): D1PreparedStatement {
	return db
		.prepare(
			"UPDATE sessions SET is_active = 0, closed_at = ?, closeout_type = ? WHERE id = ?",
		)
		.bind(closedAt, closeoutType, id);
}
