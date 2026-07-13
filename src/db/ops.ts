/**
 * Data-access layer: ops-plane D1 queries.
 *
 * alerts, sync_state bookkeeping, canonical network metrics, marketplace
 * snapshot reads, price history, provenance receipt storage/chaining/reads,
 * key history + service attestations, the notify list, and the D1->BQ backfill
 * page reads. Every SQL string here was moved VERBATIM from its original call
 * site - behavior, bind order, and null handling are unchanged. Flag
 * suspicious SQL in review; do not rewrite it in place.
 */

// ─── sync_state bookkeeping ──────────────────────────────────────────────────

/** One sync_state value row. */
export interface SyncStateValueRow {
	value: string;
}

/** Read one sync_state value by key. */
export async function getSyncStateValue(
	db: D1Database,
	key: string,
): Promise<SyncStateValueRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = ?")
		.bind(key)
		.first<SyncStateValueRow>();
}

/** Upsert one sync_state value (ON CONFLICT DO UPDATE form, alert state). */
export function upsertSyncStateValue(
	db: D1Database,
	key: string,
	value: string,
): Promise<D1Result> {
	return db
		.prepare(
			"INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(key, value)
		.run();
}

/** Replace one sync_state value (INSERT OR REPLACE form, cron backfill lock). */
export function putSyncStateValue(
	db: D1Database,
	key: string,
	value: string,
): Promise<D1Result> {
	return db
		.prepare("INSERT OR REPLACE INTO sync_state (key,value) VALUES (?,?)")
		.bind(key, value)
		.run();
}

/** Delete one sync_state row (cron backfill lock release). */
export function deleteSyncStateValue(db: D1Database, key: string): Promise<D1Result> {
	return db.prepare("DELETE FROM sync_state WHERE key=?").bind(key).run();
}

/** The best-known chain head: max of current_block / last_block, as a value row. */
export async function getMaxSyncedHead(
	db: D1Database,
): Promise<SyncStateValueRow | null> {
	return db
		.prepare(
			"SELECT value FROM sync_state WHERE key IN ('current_block','last_block') ORDER BY CAST(value AS INTEGER) DESC LIMIT 1",
		)
		.first<SyncStateValueRow>();
}

// ─── alerts ──────────────────────────────────────────────────────────────────

/** Insert an alert row; returns the raw D1Result so callers can read last_row_id. */
export function insertAlert(
	db: D1Database,
	ts: number,
	level: string,
	kind: string,
	message: string,
): Promise<D1Result> {
	return db
		.prepare(
			"INSERT INTO alerts (ts, level, kind, message, resolved) VALUES (?, ?, ?, ?, 0)",
		)
		.bind(ts, level, kind, message)
		.run();
}

// ─── canonical network metrics ───────────────────────────────────────────────

/** COUNT(*) result row. */
export interface CountRow {
	cnt: number;
}

/** SUM(...) result row. */
export interface SumRow {
	total: number;
}

/** Every registered provider row. */
export async function countProviders(db: D1Database): Promise<CountRow | null> {
	return db.prepare("SELECT COUNT(*) as cnt FROM providers").first<CountRow>();
}

/** Live (non-retracted) bids only. */
export async function countLiveBids(db: D1Database): Promise<CountRow | null> {
	return db
		.prepare(
			"SELECT COUNT(*) as cnt FROM bids WHERE deleted_at = 0 OR deleted_at IS NULL",
		)
		.first<CountRow>();
}

/** Sessions flagged active AND not past their on-chain end time. */
export async function countActiveSessions(
	db: D1Database,
	nowTs: number,
): Promise<CountRow | null> {
	return db
		.prepare(
			"SELECT COUNT(*) as cnt FROM sessions WHERE is_active = 1 AND (ends_at = 0 OR ends_at > ?)",
		)
		.bind(nowTs)
		.first<CountRow>();
}

/** Every session ever seen (cumulative). */
export async function countAllSessions(db: D1Database): Promise<CountRow | null> {
	return db.prepare("SELECT COUNT(*) as cnt FROM sessions").first<CountRow>();
}

/** MOR currently locked in active sessions. */
export async function sumActiveSessionStake(
	db: D1Database,
	nowTs: number,
): Promise<SumRow | null> {
	return db
		.prepare(
			"SELECT SUM(CAST(stake AS REAL) / 1e18) as total FROM sessions WHERE is_active = 1 AND (ends_at = 0 OR ends_at > ?)",
		)
		.bind(nowTs)
		.first<SumRow>();
}

/** MOR claimable: expired sessions not yet closed out. */
export async function sumClaimableSessionStake(
	db: D1Database,
	nowTs: number,
): Promise<SumRow | null> {
	return db
		.prepare(
			"SELECT SUM(CAST(stake AS REAL) / 1e18) as total FROM sessions WHERE is_active = 1 AND ends_at > 0 AND ends_at < ?",
		)
		.bind(nowTs)
		.first<SumRow>();
}

// ─── marketplace snapshot reads ──────────────────────────────────────────────

/** Slim provider read for the signed marketplace snapshot. */
export async function listSnapshotProviders(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db.prepare("SELECT address, endpoint FROM providers").all();
	return r.results ?? [];
}

/** Slim live-bid read for the signed marketplace snapshot. */
export async function listSnapshotBids(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			"SELECT bid_id, provider, model_id, price_per_second, deleted_at FROM bids WHERE (deleted_at = 0 OR deleted_at IS NULL) ORDER BY rowid DESC LIMIT 1000",
		)
		.all();
	return r.results ?? [];
}

// Named models (modelId -> name): use getNamedModelIdNames from explorer-market.ts (canonical).

// ─── price history ───────────────────────────────────────────────────────────

/** price_history timestamp row. */
export interface PriceTsRow {
	ts: number;
}

/** price_history usd row. */
export interface PriceUsdRow {
	usd: number;
}

/** The most recent recorded price point's timestamp. */
export async function getLatestPriceHistoryTs(
	db: D1Database,
): Promise<PriceTsRow | null> {
	return db
		.prepare("SELECT ts FROM price_history ORDER BY ts DESC LIMIT 1")
		.first<PriceTsRow>();
}

/** Record one price point (idempotent per ts). */
export function insertPriceHistoryPoint(
	db: D1Database,
	ts: number,
	usd: number,
	ethUsd: number,
): Promise<D1Result> {
	return db
		.prepare("INSERT OR REPLACE INTO price_history (ts, usd, eth_usd) VALUES (?, ?, ?)")
		.bind(ts, usd, ethUsd)
		.run();
}

/** The recorded price point closest to `target` within [from, to]. */
export async function getPriceHistoryPointNear(
	db: D1Database,
	from: number,
	to: number,
	target: number,
): Promise<PriceUsdRow | null> {
	return db
		.prepare(
			"SELECT usd FROM price_history WHERE ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) ASC LIMIT 1",
		)
		.bind(from, to, target)
		.first<PriceUsdRow>();
}

// ─── provenance receipt storage / chaining ───────────────────────────────────

/** Receipts not yet chained into a Merkle root (oldest first, bounded). */
export async function listUnchainedReceipts(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			"SELECT receipt_json FROM provenance_receipts WHERE chain_root IS NULL ORDER BY timestamp ASC LIMIT 500",
		)
		.all();
	return r.results ?? [];
}

/** Stamp one chunk of receipt ids with their chain root (caller chunks by 50). */
export function markReceiptsChained(
	db: D1Database,
	root: string,
	chainId: string,
	ids: unknown[],
): Promise<D1Result> {
	const placeholders = ids.map(() => "?").join(",");
	return db
		.prepare(
			`UPDATE provenance_receipts SET chain_root = ?, chain_id = ? WHERE id IN (${placeholders})`,
		)
		.bind(root, chainId, ...ids)
		.run();
}

/** Insert the service-level attestation over a Merkle root. */
export function insertServiceAttestation(
	db: D1Database,
	id: string,
	merkleRoot: string,
	receiptCount: number,
	fromTimestamp: string,
	toTimestamp: string,
	signature: string,
	publicKey: string,
): Promise<D1Result> {
	return db
		.prepare(
			`INSERT OR IGNORE INTO service_attestations (id, service, merkle_root, receipt_count, from_timestamp, to_timestamp, signature, public_key) VALUES (?, 'morscan', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, merkleRoot, receiptCount, fromTimestamp, toTimestamp, signature, publicKey)
		.run();
}

/**
 * Statement builder for storing one provenance receipt. Used as a direct
 * executor (insertProvenanceReceipt) and collected into db.batch alongside
 * row receipts by utils/provenance-store.ts.
 */
export function insertProvenanceReceiptStmt(
	db: D1Database,
	id: string,
	action: string,
	timestamp: string,
	inputHash: string,
	outputHash: string,
	publicKey: string,
	signature: string,
	receiptJson: string,
): D1PreparedStatement {
	return db
		.prepare(
			"INSERT OR IGNORE INTO provenance_receipts (id, action, timestamp, input_hash, output_hash, public_key, signature, receipt_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			id,
			action,
			timestamp,
			inputHash,
			outputHash,
			publicKey,
			signature,
			receiptJson,
		);
}

/**
 * Retention prune for provenance_receipts: delete rows older than `days`,
 * bounded to `limit` per call so it never becomes a blanket sweep. These are
 * ephemeral explorer attestations (a signed snapshot of cached chain data),
 * not durable cited claims, so a rolling window is safe and caps the unbounded
 * D1 growth from per-endpoint signing. The signed bytes still ship inline in
 * every response and stay independently verifiable at serve time.
 *
 * ISO-to-ISO comparison only (the column and the cutoff are both JS ISO-8601,
 * which sorts chronologically) - never compared against SQLite datetime().
 * Uses idx_prov_timestamp via the bounded subselect.
 */
export async function pruneOldReceipts(
	db: D1Database,
	days: number,
	limit = 25000,
): Promise<number> {
	const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
	const r = await db
		.prepare(
			"DELETE FROM provenance_receipts WHERE id IN (SELECT id FROM provenance_receipts WHERE timestamp < ? ORDER BY timestamp LIMIT ?)",
		)
		.bind(cutoffIso, limit)
		.run();
	return (r.meta?.changes as number) || 0;
}

/** Store one provenance receipt (audit trail). */
export function insertProvenanceReceipt(
	db: D1Database,
	id: string,
	action: string,
	timestamp: string,
	inputHash: string,
	outputHash: string,
	publicKey: string,
	signature: string,
	receiptJson: string,
): Promise<D1Result> {
	return insertProvenanceReceiptStmt(
		db,
		id,
		action,
		timestamp,
		inputHash,
		outputHash,
		publicKey,
		signature,
		receiptJson,
	).run();
}

/** Recent receipts filtered by action. */
export async function getProvenanceReceiptsByAction(
	db: D1Database,
	action: string,
	limit: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			"SELECT id, action, timestamp, input_hash, output_hash, public_key, signature, chain_root, chain_id FROM provenance_receipts WHERE action = ? ORDER BY timestamp DESC LIMIT ?",
		)
		.bind(action, limit)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Recent receipts across all actions. */
export async function getProvenanceReceipts(
	db: D1Database,
	limit: number,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			"SELECT id, action, timestamp, input_hash, output_hash, public_key, signature, chain_root, chain_id FROM provenance_receipts ORDER BY timestamp DESC LIMIT ?",
		)
		.bind(limit)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Receipt counts grouped by action. */
export async function getProvenanceActionCounts(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			"SELECT action, COUNT(*) as count FROM provenance_receipts GROUP BY action ORDER BY count DESC",
		)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Total receipt count. */
export async function countProvenanceReceipts(
	db: D1Database,
): Promise<{ total: number } | null> {
	return db
		.prepare("SELECT COUNT(*) as total FROM provenance_receipts")
		.first<{ total: number }>();
}

/** Receipt chain summary (last 20 chains). */
export async function getProvenanceChains(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			"SELECT chain_id, chain_root, COUNT(*) as receipt_count, MIN(timestamp) as from_ts, MAX(timestamp) as to_ts FROM provenance_receipts WHERE chain_root IS NOT NULL GROUP BY chain_id ORDER BY to_ts DESC LIMIT 20",
		)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Statement builder for one row receipt (batched by provenance-store). */
export function insertRowReceiptStmt(
	db: D1Database,
	id: string,
	receiptJson: string,
	rowKey: string,
	batchId: string,
	merkleRoot: string,
	dataType: string,
	syncedAt: string,
): D1PreparedStatement {
	return db
		.prepare(
			"INSERT OR REPLACE INTO row_receipts (id, receipt_json, row_key, batch_id, merkle_root, data_type, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(id, receiptJson, rowKey, batchId, merkleRoot, dataType, syncedAt);
}

// ─── key history + attestations (/.well-known) ───

/** One key_history row (signer key rotation ledger). */
export interface KeyHistoryRow {
	path: string;
	key: string;
	valid_from: string;
	valid_until: string | null;
	expected_valid_until: string | null;
	status: "current" | "superseded" | "compromised" | "revoked" | "retired";
	rotation_reason: string | null;
	note: string | null;
}

/** Full signer key history, current keys first. */
export async function getKeyHistory(db: D1Database): Promise<KeyHistoryRow[]> {
	const r = await db
		.prepare(
			`SELECT path, key, valid_from, valid_until, expected_valid_until, status, rotation_reason, note
     FROM key_history
     ORDER BY
       CASE status WHEN 'current' THEN 0 ELSE 1 END,
       valid_from DESC`,
		)
		.all<KeyHistoryRow>();
	return r.results ?? [];
}

/** Most recent service attestation, if the table exists. */
export async function getLatestServiceAttestation(
	db: D1Database,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare(
			"SELECT id, merkle_root, receipt_count, from_timestamp, to_timestamp, signature, public_key, created_at FROM service_attestations ORDER BY created_at DESC LIMIT 1",
		)
		.first<Record<string, unknown>>();
}

// ─── notify list ───

/** Idempotent launch-list email capture. */
export async function insertNotifyEmail(
	db: D1Database,
	email: string,
): Promise<D1Result> {
	return db
		.prepare("INSERT OR IGNORE INTO notify_list (email) VALUES (?)")
		.bind(email)
		.run();
}

/** One coming-soon launch-list capture. `source` is absent in the base schema
 * (the table is email + created_at), so it reads as undefined until/unless a
 * source column is ever added - callers coalesce it to null. */
export interface NotifyCaptureRow {
	email: string;
	created_at: string;
	source?: string | null;
}

/** Total launch-list captures. */
export async function countNotifyCaptures(
	db: D1Database,
): Promise<{ total: number } | null> {
	return db
		.prepare("SELECT COUNT(*) as total FROM notify_list")
		.first<{ total: number }>();
}

/** A page of launch-list captures, newest first (created_at is an ISO-like
 * datetime('now') string, so DESC lexicographic order is chronological). */
export async function listNotifyCaptures(
	db: D1Database,
	limit: number,
	offset: number,
): Promise<NotifyCaptureRow[]> {
	const r = await db
		.prepare(
			"SELECT email, created_at FROM notify_list ORDER BY created_at DESC, email ASC LIMIT ? OFFSET ?",
		)
		.bind(limit, offset)
		.all<NotifyCaptureRow>();
	return r.results ?? [];
}

// ─── misc explorer reads ───

/** The 50 most recent Diamond facet upgrades. */
export async function listDiamondUpgrades(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(
			"SELECT block_number, tx_hash, log_index, facet_changes, facet_count, block_timestamp FROM diamond_upgrades ORDER BY block_number DESC LIMIT 50",
		)
		.all();
	return r.results ?? [];
}

// ─── D1->BQ backfill page reads ──────────────────────────────────────────────
// Each helper keeps the original after/no-after statement pair verbatim.
// Generic <T> lets callers keep typing rows via the BQ row-builder inputs.

/** Page of sessions rows for BQ backfill (cursor: id). */
export async function listSessionsForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
	afterId?: string,
): Promise<T[]> {
	const rows = afterId
		? await db
				.prepare(
					`SELECT id, user_address, bid_id, provider, model_id, stake, opened_at, ends_at,
                closed_at, is_active, updated_block, open_tx_hash, close_tx_hash
         FROM sessions WHERE id > ? ORDER BY id ASC LIMIT ?`,
				)
				.bind(afterId, limit)
				.all<T>()
		: await db
				.prepare(
					`SELECT id, user_address, bid_id, provider, model_id, stake, opened_at, ends_at,
                closed_at, is_active, updated_block, open_tx_hash, close_tx_hash
         FROM sessions ORDER BY id ASC LIMIT ?`,
				)
				.bind(limit)
				.all<T>();
	return rows.results ?? [];
}

/** Page of bids rows for BQ backfill (cursor: bid_id). */
export async function listBidsForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
	afterId?: string,
): Promise<T[]> {
	const rows = afterId
		? await db
				.prepare(
					`SELECT bid_id, provider, model_id, price_per_second, nonce, created_at, deleted_at, updated_block
         FROM bids WHERE bid_id > ? ORDER BY bid_id ASC LIMIT ?`,
				)
				.bind(afterId, limit)
				.all<T>()
		: await db
				.prepare(
					`SELECT bid_id, provider, model_id, price_per_second, nonce, created_at, deleted_at, updated_block
         FROM bids ORDER BY bid_id ASC LIMIT ?`,
				)
				.bind(limit)
				.all<T>();
	return rows.results ?? [];
}

/** Page of economics_history rows for BQ backfill (no cursor - date order). */
export async function listEconomicsHistoryForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
): Promise<T[]> {
	const rows = await db
		.prepare(`SELECT * FROM economics_history ORDER BY date ASC LIMIT ?`)
		.bind(limit)
		.all<T>();
	return rows.results ?? [];
}

/** Page of models rows for BQ backfill (cursor: model_id). */
export async function listModelsForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
	afterId?: string,
): Promise<T[]> {
	const rows = afterId
		? await db
				.prepare(
					`SELECT model_id, name, tags, description, created_at, updated_at
         FROM models WHERE model_id > ? ORDER BY model_id ASC LIMIT ?`,
				)
				.bind(afterId, limit)
				.all<T>()
		: await db
				.prepare(
					`SELECT model_id, name, tags, description, created_at, updated_at
         FROM models ORDER BY model_id ASC LIMIT ?`,
				)
				.bind(limit)
				.all<T>();
	return rows.results ?? [];
}

/** Page of providers rows for BQ backfill (cursor: address). */
export async function listProvidersForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
	afterId?: string,
): Promise<T[]> {
	const rows = afterId
		? await db
				.prepare(
					`SELECT address, endpoint, stake, created_at, updated_block
         FROM providers WHERE address > ? ORDER BY address ASC LIMIT ?`,
				)
				.bind(afterId, limit)
				.all<T>()
		: await db
				.prepare(
					`SELECT address, endpoint, stake, created_at, updated_block
         FROM providers ORDER BY address ASC LIMIT ?`,
				)
				.bind(limit)
				.all<T>();
	return rows.results ?? [];
}

/** Page of builder_subnets rows for BQ backfill (cursor: subnet_id). */
export async function listBuilderSubnetsForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
	afterId?: string,
): Promise<T[]> {
	const rows = afterId
		? await db
				.prepare(
					`SELECT * FROM builder_subnets WHERE subnet_id > ? ORDER BY subnet_id ASC LIMIT ?`,
				)
				.bind(afterId, limit)
				.all<T>()
		: await db
				.prepare(`SELECT * FROM builder_subnets ORDER BY subnet_id ASC LIMIT ?`)
				.bind(limit)
				.all<T>();
	return rows.results ?? [];
}

/** Page of builder_stakes rows for BQ backfill (cursor: id). */
export async function listBuilderStakesForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
	afterId?: number,
): Promise<T[]> {
	const rows = afterId
		? await db
				.prepare(
					`SELECT id, subnet_id, wallet, deposited, last_deposit_at, unlock_at, created_at, updated_at
         FROM builder_stakes WHERE id > ? ORDER BY id ASC LIMIT ?`,
				)
				.bind(afterId, limit)
				.all<T>()
		: await db
				.prepare(
					`SELECT id, subnet_id, wallet, deposited, last_deposit_at, unlock_at, created_at, updated_at
         FROM builder_stakes ORDER BY id ASC LIMIT ?`,
				)
				.bind(limit)
				.all<T>();
	return rows.results ?? [];
}

/** Page of builder_events rows for BQ backfill (cursor: id). */
export async function listBuilderEventsForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
	afterId?: number,
): Promise<T[]> {
	const rows = afterId
		? await db
				.prepare(`SELECT * FROM builder_events WHERE id > ? ORDER BY id ASC LIMIT ?`)
				.bind(afterId, limit)
				.all<T>()
		: await db
				.prepare(`SELECT * FROM builder_events ORDER BY id ASC LIMIT ?`)
				.bind(limit)
				.all<T>();
	return rows.results ?? [];
}

/** Page of provider_stats rows for BQ backfill (composite provider|model cursor). */
export async function listProviderStatsForBackfill<T = Record<string, unknown>>(
	db: D1Database,
	limit: number,
	afterProvider: string,
	afterModel: string,
	hasCursor: boolean,
): Promise<T[]> {
	const rows = hasCursor
		? await db
				.prepare(
					`SELECT provider, model_id, success_count, dispute_count,
                early_termination_count, total_sessions, avg_duration_secs, updated_at
           FROM provider_stats
          WHERE (provider > ?)
             OR (provider = ? AND model_id > ?)
          ORDER BY provider ASC, model_id ASC
          LIMIT ?`,
				)
				.bind(afterProvider, afterProvider, afterModel, limit)
				.all<T>()
		: await db
				.prepare(
					`SELECT provider, model_id, success_count, dispute_count,
                early_termination_count, total_sessions, avg_duration_secs, updated_at
           FROM provider_stats
          ORDER BY provider ASC, model_id ASC
          LIMIT ?`,
				)
				.bind(limit)
				.all<T>();
	return rows.results ?? [];
}
