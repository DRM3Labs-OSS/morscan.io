/**
 * Data-access layer: the anonymous (keyless) per-IP day counter.
 *
 * A single durable ceiling for keyless API callers, separate from the per-key
 * usage_counters (which only exist for keyed callers). The IP is hashed into
 * the bucket so the raw address is never stored in D1; the row is a daily
 * staircase (`<ip-hash>|YYYY-MM-DD`) with its own reset_at, pruned by the daily
 * cron. Created at runtime on first use, so an existing database needs no
 * migration. OFF by default (ANON_DAY_CAP unset or 0) - the mechanism is armed
 * and the number is set once the usage_log read shows the real anon volume.
 */

const ANON_COUNTERS_DDL =
	"CREATE TABLE IF NOT EXISTS anon_counters (" +
	"bucket TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)";

let ensured = false;

async function ensureAnonCounters(db: D1Database): Promise<void> {
	if (ensured) return;
	await db.prepare(ANON_COUNTERS_DDL).run();
	ensured = true;
}

export interface AnonBumpResult {
	/** Running count for the day AFTER this request is charged. */
	used: number;
	/** Seconds until the day bucket resets (00:00 UTC). */
	retryAfter: number;
}

/**
 * Charge one keyless request against the IP's UTC-day budget and return the
 * running count. The INSERT ... ON CONFLICT DO UPDATE ... RETURNING is atomic
 * (D1 is single-writer), so concurrent requests from one IP cannot race past
 * the cap. Caller decides allow/deny from `used` vs the cap and fails OPEN on a
 * thrown error (a broken meter must never take the API down).
 */
export async function bumpAnonDay(
	db: D1Database,
	ipHash: string,
	now: number,
): Promise<AnonBumpResult> {
	await ensureAnonCounters(db);
	const dayStart = Math.floor(now / 86400) * 86400;
	const resetAt = dayStart + 86400;
	const row = await db
		.prepare(
			"INSERT INTO anon_counters (bucket, n, reset_at) VALUES (?1, 1, ?2) " +
				"ON CONFLICT(bucket) DO UPDATE SET n = n + 1 RETURNING n",
		)
		.bind(`${ipHash}|${dayStart}`, resetAt)
		.first<{ n: number }>();
	return { used: row?.n ?? 0, retryAfter: Math.max(1, resetAt - now) };
}

/** Prune expired anon day counters (daily cron). Returns rows deleted. */
export async function pruneAnonCounters(db: D1Database): Promise<number> {
	const r = await db
		.prepare("DELETE FROM anon_counters WHERE reset_at < unixepoch()")
		.run();
	return r.meta?.changes ?? 0;
}
