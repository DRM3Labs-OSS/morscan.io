/**
 * Sync engine data-access layer - builder + holder side.
 *
 * Every inline SQL string from the builder sync files (src/sync/builder*.ts)
 * and the MOR holder queries (src/sync/compute-events.ts) lives here verbatim.
 * Compute-side queries live in sync.ts.
 *
 * Two function shapes:
 *   - async executors: run the query and return typed rows
 *   - *Stmt builders: return a bound D1PreparedStatement for env.DB.batch()
 */

// Shared row shapes (raw D1 rows).
export interface BuilderSyncStateValueRow {
	value: string;
}

export interface SubnetDepositRow {
	total_deposited: string;
}

export interface SubnetAdminRow {
	subnet_id: string;
	admin: string;
}

export interface BuilderEventAmountRow {
	event_type: string;
	amount: string;
}

/** Raw builder_stakes row (SELECT *). Mirrors builderStakeRow()'s input shape. */
export interface BuilderStakeRow {
	subnet_id: string;
	wallet: string;
	deposited: string | null;
	last_deposit_at: number | null;
	unlock_at: number | null;
	created_at: number | null;
	updated_at: number | null;
}

export interface HolderWalletRow {
	wallet: string;
}

/** Common on-chain refresh fields (builder-refresh update variants). */
export interface SubnetRefreshBase {
	totalStaked: string;
	pendingRewards: string;
	updatedAt: number;
	subnetId: string;
}

export interface SubnetRefreshMeta {
	metadataName: string;
	metadataDescription: string;
	metadataUrl: string;
	metadataLogo: string;
}

export interface SubnetRefreshAdmin {
	admin: string;
	claimAdmin: string;
	name: string;
	minimalDeposit: string;
	withdrawLockPeriod: number;
}

// ─── builder_sync_state ───

export async function getBuilderSyncStateValue(
	db: D1Database,
	key: string,
): Promise<BuilderSyncStateValueRow | null> {
	return db
		.prepare("SELECT value FROM builder_sync_state WHERE key = ?")
		.bind(key)
		.first<BuilderSyncStateValueRow>();
}

export async function setBuilderSyncState(
	db: D1Database,
	key: string,
	value: string,
): Promise<D1Result> {
	return db
		.prepare("INSERT OR REPLACE INTO builder_sync_state (key, value) VALUES (?, ?)")
		.bind(key, value)
		.run();
}

// ─── builder_subnets ───

/** Full upsert from a parsed SubnetCreated event struct. */
export function upsertSubnetFromCreatedEventStmt(
	db: D1Database,
	subnetId: string,
	name: string,
	admin: string,
	claimAdmin: string,
	minimalDeposit: string,
	withdrawLockPeriod: number,
	createdAt: number,
	updatedAt: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO builder_subnets (subnet_id, name, admin, claim_admin, minimal_deposit, withdraw_lock_period, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(subnet_id) DO UPDATE SET
             name = CASE WHEN excluded.name != '' THEN excluded.name ELSE builder_subnets.name END,
             admin = CASE WHEN excluded.admin != '' THEN excluded.admin ELSE builder_subnets.admin END,
             claim_admin = excluded.claim_admin,
             minimal_deposit = excluded.minimal_deposit,
             withdraw_lock_period = excluded.withdraw_lock_period,
             updated_at = excluded.updated_at`,
		)
		.bind(
			subnetId,
			name,
			admin,
			claimAdmin,
			minimalDeposit,
			withdrawLockPeriod,
			createdAt,
			updatedAt,
		);
}

/** Bare shell row so a subnet seen only via a stake event still exists. */
export function insertSubnetShellStmt(
	db: D1Database,
	subnetId: string,
	createdAt: number,
	updatedAt: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO builder_subnets (subnet_id, name, admin, created_at, updated_at) VALUES (?, '', '', ?, ?)`,
		)
		.bind(subnetId, createdAt, updatedAt);
}

export async function getFundedSubnetDeposits(
	db: D1Database,
): Promise<SubnetDepositRow[]> {
	const r = await db
		.prepare(
			`SELECT total_deposited FROM builder_subnets WHERE total_deposited IS NOT NULL AND total_deposited != '0'`,
		)
		.all<SubnetDepositRow>();
	return r.results ?? [];
}

/** Idempotent-by-catch migration: throws if the column already exists. */
export async function addSubnetChainColumn(db: D1Database): Promise<D1Result> {
	return db
		.prepare("ALTER TABLE builder_subnets ADD COLUMN chain TEXT DEFAULT NULL")
		.run();
}

export function upsertSubnetFromGoldskyStmt(
	db: D1Database,
	subnetId: string,
	name: string,
	admin: string,
	totalDeposited: string,
	stakerCount: number,
	minimalDeposit: string,
	withdrawLockPeriod: number,
	metadataName: string,
	metadataDescription: string,
	metadataUrl: string,
	metadataLogo: string,
	chain: string,
	createdAt: number,
	updatedAt: number,
): D1PreparedStatement {
	return db
		.prepare(`INSERT INTO builder_subnets (subnet_id, name, admin, total_deposited, pending_rewards, staker_count, minimal_deposit, withdraw_lock_period, metadata_name, metadata_description, metadata_url, metadata_logo, chain, created_at, updated_at)
            VALUES (?, ?, ?, ?, '0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(subnet_id) DO UPDATE SET
              name = CASE WHEN excluded.name != '' THEN excluded.name ELSE builder_subnets.name END,
              admin = CASE WHEN excluded.admin != '' THEN excluded.admin ELSE builder_subnets.admin END,
              total_deposited = excluded.total_deposited,
              staker_count = excluded.staker_count,
              minimal_deposit = CASE WHEN excluded.minimal_deposit != '0' THEN excluded.minimal_deposit ELSE builder_subnets.minimal_deposit END,
              withdraw_lock_period = CASE WHEN excluded.withdraw_lock_period > 0 THEN excluded.withdraw_lock_period ELSE builder_subnets.withdraw_lock_period END,
              metadata_name = CASE WHEN excluded.metadata_name != '' THEN excluded.metadata_name ELSE builder_subnets.metadata_name END,
              metadata_description = CASE WHEN excluded.metadata_description != '' THEN excluded.metadata_description ELSE builder_subnets.metadata_description END,
              metadata_url = CASE WHEN excluded.metadata_url != '' THEN excluded.metadata_url ELSE builder_subnets.metadata_url END,
              metadata_logo = CASE WHEN excluded.metadata_logo != '' THEN excluded.metadata_logo ELSE builder_subnets.metadata_logo END,
              chain = excluded.chain,
              updated_at = excluded.updated_at`)
		.bind(
			subnetId,
			name,
			admin,
			totalDeposited,
			stakerCount,
			minimalDeposit,
			withdrawLockPeriod,
			metadataName,
			metadataDescription,
			metadataUrl,
			metadataLogo,
			chain,
			createdAt,
			updatedAt,
		);
}

export async function getAllSubnetAdmins(db: D1Database): Promise<SubnetAdminRow[]> {
	const r = await db
		.prepare("SELECT subnet_id, admin FROM builder_subnets")
		.all<SubnetAdminRow>();
	return r.results ?? [];
}

/** On-chain refresh: deposits/rewards + metadata + admin/struct fields. */
export function updateSubnetDataMetaAdminStmt(
	db: D1Database,
	p: SubnetRefreshBase & SubnetRefreshMeta & SubnetRefreshAdmin,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE builder_subnets SET total_deposited = CASE WHEN ? != '0' THEN ? ELSE total_deposited END, pending_rewards = ?, metadata_name = ?, metadata_description = ?, metadata_url = ?, metadata_logo = ?, admin = ?, claim_admin = ?, name = CASE WHEN ? != '' THEN ? ELSE name END, minimal_deposit = CASE WHEN ? != '0' THEN ? ELSE minimal_deposit END, withdraw_lock_period = CASE WHEN ? > 0 THEN ? ELSE withdraw_lock_period END, updated_at = ? WHERE subnet_id = ?`,
		)
		.bind(
			p.totalStaked,
			p.totalStaked,
			p.pendingRewards,
			p.metadataName,
			p.metadataDescription,
			p.metadataUrl,
			p.metadataLogo,
			p.admin,
			p.claimAdmin,
			p.name,
			p.name,
			p.minimalDeposit,
			p.minimalDeposit,
			p.withdrawLockPeriod,
			p.withdrawLockPeriod,
			p.updatedAt,
			p.subnetId,
		);
}

/** On-chain refresh: deposits/rewards + metadata only. */
export function updateSubnetDataMetaStmt(
	db: D1Database,
	p: SubnetRefreshBase & SubnetRefreshMeta,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE builder_subnets SET total_deposited = CASE WHEN ? != '0' THEN ? ELSE total_deposited END, pending_rewards = ?, metadata_name = ?, metadata_description = ?, metadata_url = ?, metadata_logo = ?, updated_at = ? WHERE subnet_id = ?`,
		)
		.bind(
			p.totalStaked,
			p.totalStaked,
			p.pendingRewards,
			p.metadataName,
			p.metadataDescription,
			p.metadataUrl,
			p.metadataLogo,
			p.updatedAt,
			p.subnetId,
		);
}

/** On-chain refresh: deposits/rewards + admin/struct fields only. */
export function updateSubnetDataAdminStmt(
	db: D1Database,
	p: SubnetRefreshBase & SubnetRefreshAdmin,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE builder_subnets SET total_deposited = CASE WHEN ? != '0' THEN ? ELSE total_deposited END, pending_rewards = ?, admin = ?, claim_admin = ?, name = CASE WHEN ? != '' THEN ? ELSE name END, minimal_deposit = CASE WHEN ? != '0' THEN ? ELSE minimal_deposit END, withdraw_lock_period = CASE WHEN ? > 0 THEN ? ELSE withdraw_lock_period END, updated_at = ? WHERE subnet_id = ?`,
		)
		.bind(
			p.totalStaked,
			p.totalStaked,
			p.pendingRewards,
			p.admin,
			p.claimAdmin,
			p.name,
			p.name,
			p.minimalDeposit,
			p.minimalDeposit,
			p.withdrawLockPeriod,
			p.withdrawLockPeriod,
			p.updatedAt,
			p.subnetId,
		);
}

/** On-chain refresh: deposits/rewards only. */
export function updateSubnetDataStmt(
	db: D1Database,
	p: SubnetRefreshBase,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE builder_subnets SET total_deposited = CASE WHEN ? != '0' THEN ? ELSE total_deposited END, pending_rewards = ?, updated_at = ? WHERE subnet_id = ?`,
		)
		.bind(p.totalStaked, p.totalStaked, p.pendingRewards, p.updatedAt, p.subnetId);
}

// ─── builder_stakes ───

/** Deposit touch: create-or-stamp the stake row (deposited recomputed later). */
export function upsertStakeOnDepositStmt(
	db: D1Database,
	subnetId: string,
	wallet: string,
	nowEpoch: number,
): D1PreparedStatement {
	return db
		.prepare(`
        INSERT INTO builder_stakes (subnet_id, wallet, deposited, last_deposit_at, created_at, updated_at)
        VALUES (?, ?, '0', ?, ?, ?)
        ON CONFLICT(subnet_id, wallet) DO UPDATE SET
          last_deposit_at = ?,
          updated_at = ?
      `)
		.bind(subnetId, wallet, nowEpoch, nowEpoch, nowEpoch, nowEpoch, nowEpoch);
}

export function touchStakeStmt(
	db: D1Database,
	updatedAt: number,
	subnetId: string,
	wallet: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE builder_stakes SET updated_at = ? WHERE subnet_id = ? AND wallet = ?`,
		)
		.bind(updatedAt, subnetId, wallet);
}

export async function setStakeDeposited(
	db: D1Database,
	deposited: string,
	subnetId: string,
	wallet: string,
): Promise<D1Result> {
	return db
		.prepare("UPDATE builder_stakes SET deposited = ? WHERE subnet_id = ? AND wallet = ?")
		.bind(deposited, subnetId, wallet)
		.run();
}

/**
 * Fetch stake rows for a dynamic list of (subnet_id, wallet) pairs.
 * Chunked at 40 pairs (80 bind params) per query so a large pair list never
 * exceeds D1's ~100 bind-parameter limit; results are merged across chunks.
 */
export async function getStakesByPairs(
	db: D1Database,
	pairs: string[][],
): Promise<BuilderStakeRow[]> {
	const CHUNK = 40;
	const rows: BuilderStakeRow[] = [];
	for (let i = 0; i < pairs.length; i += CHUNK) {
		const chunk = pairs.slice(i, i + CHUNK);
		const conditions = chunk.map(() => "(subnet_id = ? AND wallet = ?)").join(" OR ");
		const params = chunk.flat();
		const r = await db
			.prepare(`SELECT * FROM builder_stakes WHERE ${conditions}`)
			.bind(...params)
			.all<BuilderStakeRow>();
		rows.push(...(r.results ?? []));
	}
	return rows;
}

// ─── builder_events ───

/** Idempotent dedup index - re-seen events collide on this UNIQUE key. */
export async function ensureBuilderEventsDedupIndex(db: D1Database): Promise<void> {
	await db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_builder_events_dedup ON builder_events (tx_hash, log_index, event_type)",
	);
}

export function insertBuilderEventStmt(
	db: D1Database,
	eventType: string,
	subnetId: string,
	wallet: string,
	amount: string,
	txHash: string,
	blockNumber: number,
	logIndex: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO builder_events (event_type, subnet_id, wallet, amount, tx_hash, block_number, log_index) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(eventType, subnetId, wallet, amount, txHash, blockNumber, logIndex);
}

/** Deposit/withdraw history for one stake (recompute input). */
export async function getStakeFlowEvents(
	db: D1Database,
	subnetId: string,
	wallet: string,
): Promise<BuilderEventAmountRow[]> {
	const r = await db
		.prepare(
			"SELECT event_type, amount FROM builder_events WHERE subnet_id = ? AND wallet = ? AND event_type IN ('deposit', 'withdraw')",
		)
		.bind(subnetId, wallet)
		.all<BuilderEventAmountRow>();
	return r.results ?? [];
}

// ─── mor_holders ───

/** Holder discovery: insert with updated_at = 0 (balance not yet computed). */
export function upsertMorHolderStmt(
	db: D1Database,
	wallet: string,
	lastTransferBlock: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO mor_holders (wallet, last_transfer_block, updated_at) VALUES (?, ?, 0) ON CONFLICT (wallet) DO UPDATE SET last_transfer_block = MAX(excluded.last_transfer_block, mor_holders.last_transfer_block)`,
		)
		.bind(wallet, lastTransferBlock);
}

export function updateHolderBalancesStmt(
	db: D1Database,
	morBalanceWei: string,
	ethBalanceWei: string,
	updatedAt: number,
	wallet: string,
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE mor_holders SET mor_balance_wei = ?, eth_balance_wei = ?, updated_at = ? WHERE wallet = ?`,
		)
		.bind(morBalanceWei, ethBalanceWei, updatedAt, wallet);
}

/** Index that makes the "stalest holders first" balance sweep cheap. */
export async function ensureMorHoldersUpdatedIndex(db: D1Database): Promise<void> {
	await db.exec(
		"CREATE INDEX IF NOT EXISTS idx_mor_holders_updated ON mor_holders(updated_at)",
	);
}

/** Stalest holders first (updated_at ASC, never-computed wallets lead). */
export async function getStalestHolderWallets(
	db: D1Database,
	limit: number,
): Promise<HolderWalletRow[]> {
	const r = await db
		.prepare("SELECT wallet FROM mor_holders ORDER BY updated_at ASC LIMIT ?")
		.bind(limit)
		.all<HolderWalletRow>();
	return r.results ?? [];
}
