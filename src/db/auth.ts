/**
 * Data-access layer: auth-plane D1 queries.
 *
 * api_keys, usage_counters, signer_attestations, ci_wallets, and the
 * builder_stakes reads that drive stake-indexed key caps. Every SQL string
 * here was moved VERBATIM from its original call site - behavior, bind order,
 * and null handling are unchanged. This is hot-path, security-sensitive code
 * (key validation, rate limiting): do not "improve" statements in place.
 */

// ─── Row shapes ───

/** Row returned when validating a raw API key (api_keys lookup by key value). */
export interface ApiKeyAuthRow {
	id: string;
	key: string;
	name: string;
	rate_limit: number;
}

/** Caps + current day/month usage for one key (joined read, one round trip). */
export interface KeyCapsUsageRow {
	daily_cap: number | null;
	monthly_cap: number | null;
	day_count: number | null;
	month_count: number | null;
}

/** signer_attestations row linking a derived signer to its staking wallet. */
export interface SignerAttestationRow {
	staking_wallet: string;
}

/** ci_wallets row (CI wallets are rate limited to the free tier). */
export interface CiWalletRow {
	name: string;
}

/** Console view of a key row: the key value plus its caps. */
export interface ApiKeyConsoleRow {
	key: string;
	rate_limit: number;
	daily_cap: number | null;
	monthly_cap: number | null;
}

/** Caps-only view of a key row. */
export interface ApiKeyCapsRow {
	rate_limit: number;
	daily_cap: number | null;
	monthly_cap: number | null;
}

/** One usage_counters row. */
export interface UsageCounterRow {
	bucket: string;
	count: number;
}

/** Key-value-only view of a key row. */
export interface ApiKeyValueRow {
	key: string;
}

/** builder_stakes deposited amount (wei-like decimal string). */
export interface BuilderStakeDepositRow {
	deposited: string;
}

/** Wallet-identity key row joined to its live builder-subnet stake. */
export interface WalletKeyStakeRow {
	id: string;
	rate_limit: number;
	daily_cap: number | null;
	monthly_cap: number | null;
	deposited: string | null;
}

// ─── api_keys (auth hot path + console) ───

/** Look up an api_keys row by its raw key value (API auth hot path). */
export async function getApiKeyByKey(
	db: D1Database,
	key: string,
): Promise<ApiKeyAuthRow | null> {
	return db
		.prepare("SELECT id, key, name, rate_limit FROM api_keys WHERE key = ?")
		.bind(key)
		.first<ApiKeyAuthRow>();
}

/**
 * Update the rough "last seen" timestamp on a key row. Callers fire-and-forget
 * this (not awaited) on the auth hot path - keep it that way.
 */
export function touchApiKeyLastUsed(
	db: D1Database,
	lastUsedAt: number,
	id: string,
): Promise<D1Result> {
	return db
		.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
		.bind(lastUsedAt, id)
		.run();
}

/**
 * One read: the key's caps + both day/month counters in a single joined query
 * (volume-cap enforcement, see utils/auth/rate-limit.ts).
 */
export async function getKeyCapsWithUsage(
	db: D1Database,
	keyId: string,
	dayBucket: string,
	monthBucket: string,
): Promise<KeyCapsUsageRow | null> {
	return db
		.prepare(`
        SELECT k.daily_cap, k.monthly_cap,
               (SELECT count FROM usage_counters WHERE key_id = ?1 AND bucket = ?2) AS day_count,
               (SELECT count FROM usage_counters WHERE key_id = ?1 AND bucket = ?3) AS month_count
        FROM api_keys k WHERE k.id = ?1
      `)
		.bind(keyId, dayBucket, monthBucket)
		.first<KeyCapsUsageRow>();
}

// ─── usage_counters (volume caps) ───

/**
 * Count one request against BOTH volume buckets: one batched UPSERT pair
 * (day then month), preserving the original batch grouping and order.
 */
export async function incrementUsageCounters(
	db: D1Database,
	keyId: string,
	dayBucket: string,
	monthBucket: string,
): Promise<D1Result[]> {
	return db.batch([
		db
			.prepare(
				"INSERT INTO usage_counters (key_id, bucket, count) VALUES (?, ?, 1) " +
					"ON CONFLICT(key_id, bucket) DO UPDATE SET count = count + 1",
			)
			.bind(keyId, dayBucket),
		db
			.prepare(
				"INSERT INTO usage_counters (key_id, bucket, count) VALUES (?, ?, 1) " +
					"ON CONFLICT(key_id, bucket) DO UPDATE SET count = count + 1",
			)
			.bind(keyId, monthBucket),
	]);
}

/** Read today's + this month's usage_counters rows for one key. */
export async function listUsageCounters(
	db: D1Database,
	keyId: string,
	dayBucket: string,
	monthBucket: string,
): Promise<UsageCounterRow[]> {
	const r = await db
		.prepare(
			"SELECT bucket, count FROM usage_counters WHERE key_id = ? AND bucket IN (?, ?)",
		)
		.bind(keyId, dayBucket, monthBucket)
		.all<UsageCounterRow>();
	return r.results ?? [];
}

// ─── signer_attestations + ci_wallets ───

/** Wallet-sig auth: resolve a derived signer address to its staking wallet. */
export async function getSignerAttestation(
	db: D1Database,
	derivedAddress: string,
): Promise<SignerAttestationRow | null> {
	return db
		.prepare("SELECT staking_wallet FROM signer_attestations WHERE derived_address = ?")
		.bind(derivedAddress)
		.first<SignerAttestationRow>();
}

/** Is this staking wallet a registered CI wallet? */
export async function getCiWallet(
	db: D1Database,
	wallet: string,
): Promise<CiWalletRow | null> {
	return db
		.prepare("SELECT name FROM ci_wallets WHERE wallet = ?")
		.bind(wallet)
		.first<CiWalletRow>();
}

// ─── api_keys (console lifecycle + caps) ───

/** Console page read: the identity's key value + caps. */
export async function getApiKeyConsoleRow(
	db: D1Database,
	id: string,
): Promise<ApiKeyConsoleRow | null> {
	return db
		.prepare("SELECT key, rate_limit, daily_cap, monthly_cap FROM api_keys WHERE id = ?")
		.bind(id)
		.first<ApiKeyConsoleRow>();
}

/** Usage endpoint read: the identity's caps only. */
export async function getApiKeyCaps(
	db: D1Database,
	id: string,
): Promise<ApiKeyCapsRow | null> {
	return db
		.prepare("SELECT rate_limit, daily_cap, monthly_cap FROM api_keys WHERE id = ?")
		.bind(id)
		.first<ApiKeyCapsRow>();
}

/** Read just the key value of an identity's key row. */
export async function getApiKeyValue(
	db: D1Database,
	id: string,
): Promise<ApiKeyValueRow | null> {
	return db
		.prepare("SELECT key FROM api_keys WHERE id = ?")
		.bind(id)
		.first<ApiKeyValueRow>();
}

/**
 * Create or rotate an identity's API key. The conflict path (rotation) only
 * replaces the key value + created_at - caps are never touched on rotate.
 */
export function upsertApiKeyWithRotation(
	db: D1Database,
	id: string,
	key: string,
	name: string,
	rateLimit: number,
	dailyCap: number | null,
	monthlyCap: number | null,
	createdAt: number,
): Promise<D1Result> {
	return db
		.prepare(
			"INSERT INTO api_keys (id, key, name, rate_limit, daily_cap, monthly_cap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at",
		)
		.bind(id, key, name, rateLimit, dailyCap, monthlyCap, createdAt)
		.run();
}

/** Auto-issue a key row on first wallet connect; no-op if the row exists. */
export function insertApiKeyIfAbsent(
	db: D1Database,
	id: string,
	key: string,
	name: string,
	rateLimit: number,
	dailyCap: number | null,
	monthlyCap: number | null,
	createdAt: number,
): Promise<D1Result> {
	return db
		.prepare(
			"INSERT INTO api_keys (id, key, name, rate_limit, daily_cap, monthly_cap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(id) DO NOTHING",
		)
		.bind(id, key, name, rateLimit, dailyCap, monthlyCap, createdAt)
		.run();
}

/** Delete an identity's key row (console revoke). */
export function deleteApiKey(db: D1Database, id: string): Promise<D1Result> {
	return db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
}

/**
 * Statement builder for re-applying stake-indexed caps to a key row. Used both
 * as a direct executor (updateApiKeyCaps) and collected into env.DB.batch by
 * the minute-cron cap sweep (utils/stake-tier.ts refreshWalletCaps).
 */
export function updateApiKeyCapsStmt(
	db: D1Database,
	rateLimit: number,
	dailyCap: number,
	monthlyCap: number,
	id: string,
): D1PreparedStatement {
	return db
		.prepare(
			"UPDATE api_keys SET rate_limit = ?, daily_cap = ?, monthly_cap = ? WHERE id = ?",
		)
		.bind(rateLimit, dailyCap, monthlyCap, id);
}

/** Re-apply stake-indexed caps to one key row right now. */
export function updateApiKeyCaps(
	db: D1Database,
	rateLimit: number,
	dailyCap: number,
	monthlyCap: number,
	id: string,
): Promise<D1Result> {
	return updateApiKeyCapsStmt(db, rateLimit, dailyCap, monthlyCap, id).run();
}

// ─── builder_stakes (stake-indexed key caps) ───

/** Live MOR deposited by one wallet on one builder subnet. */
export async function getBuilderStakeDeposit(
	db: D1Database,
	subnetId: string,
	wallet: string,
): Promise<BuilderStakeDepositRow | null> {
	return db
		.prepare("SELECT deposited FROM builder_stakes WHERE subnet_id = ? AND wallet = ?")
		.bind(subnetId, wallet)
		.first<BuilderStakeDepositRow>();
}

/**
 * Minute-cron cap sweep read: every wallet-identity key row joined to its
 * live builder-subnet stake (the address is the key id after `wallet:`).
 */
export async function listWalletKeysWithStakes(
	db: D1Database,
	subnetId: string,
): Promise<WalletKeyStakeRow[]> {
	const r = await db
		.prepare(`
    SELECT k.id, k.rate_limit, k.daily_cap, k.monthly_cap, bs.deposited
    FROM api_keys k
    LEFT JOIN builder_stakes bs ON bs.subnet_id = ?1 AND bs.wallet = substr(k.id, 8)
    WHERE k.id LIKE 'wallet:%'
  `)
		.bind(subnetId)
		.all<WalletKeyStakeRow>();
	return r.results ?? [];
}
