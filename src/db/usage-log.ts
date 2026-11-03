/**
 * Data-access layer: the first-party usage instrument.
 *
 * usage_log is the ONE place an operator can see the traffic the per-key
 * usage_counters never see: human page reads (the serving key), anonymous and
 * machine API callers, and crawlers. One row per non-asset request, written
 * fire-and-forget OFF the response path (never awaited on a render) and pruned
 * to a rolling window by the daily cron.
 *
 * It stores NO raw IP and NO raw key. `credential` is a class tag only
 * ('demo' | 'key:<hash-prefix>' | 'x402' | null for anonymous); country and
 * colo are Cloudflare's coarse edge geo. `weight` is the sample divisor in
 * force when the row was written (1 = every request logged), so a read recovers
 * true-ish volume with SUM(weight). The table is created at runtime on first
 * use, so an existing database needs no migration. Disclosed in the privacy
 * policy as a bounded server-side usage log that sets no cookie.
 */

/** One usage_log row (the operator read shape). */
export interface UsageLogRow {
	ts: number;
	path: string;
	method: string | null;
	credential: string | null;
	country: string | null;
	colo: string | null;
	ua: string | null;
	weight: number;
}

const USAGE_LOG_DDL =
	"CREATE TABLE IF NOT EXISTS usage_log (" +
	"id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, path TEXT NOT NULL, " +
	"method TEXT, credential TEXT, country TEXT, colo TEXT, ua TEXT, " +
	"weight INTEGER NOT NULL DEFAULT 1)";

const USAGE_LOG_INDEX = "CREATE INDEX IF NOT EXISTS idx_usage_log_ts ON usage_log (ts)";

// The table is created lazily, once per isolate. A failed create is swallowed
// here and surfaces as a failed insert (which logUsage also swallows) - the
// instrument must never add latency to, or fail, a real request.
let ensured = false;

/** Create usage_log + its index if absent. Idempotent; runs once per isolate. */
export async function ensureUsageLog(db: D1Database): Promise<void> {
	if (ensured) return;
	await db.batch([db.prepare(USAGE_LOG_DDL), db.prepare(USAGE_LOG_INDEX)]);
	ensured = true;
}

/**
 * Append one usage row. Call ONLY via ctx.waitUntil - this is off the response
 * path. Ensures the table exists on first use. path is clamped to 200 chars and
 * ua to 180; neither IP nor the raw key is ever passed in.
 */
export async function logUsage(
	db: D1Database,
	u: {
		path: string;
		method: string | null;
		credential: string | null;
		country: string | null;
		colo: string | null;
		ua: string | null;
		weight: number;
	},
): Promise<void> {
	await ensureUsageLog(db);
	await db
		.prepare(
			"INSERT INTO usage_log (ts, path, method, credential, country, colo, ua, weight) " +
				"VALUES (unixepoch(), ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
		)
		.bind(
			u.path.slice(0, 200),
			u.method,
			u.credential,
			u.country,
			u.colo,
			u.ua ? u.ua.slice(0, 180) : null,
			u.weight,
		)
		.run();
}

/** Prune usage_log to the rolling retention window (daily cron). Returns rows deleted. */
export async function pruneUsageLog(
	db: D1Database,
	retentionDays: number,
): Promise<number> {
	const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 14;
	const r = await db
		.prepare("DELETE FROM usage_log WHERE ts < unixepoch() - ?1 * 86400")
		.bind(days)
		.run();
	return r.meta?.changes ?? 0;
}
