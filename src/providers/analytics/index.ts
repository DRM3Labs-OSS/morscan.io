/**
 * AnalyticsProvider - the open-core seam for analytics + warehouse reads.
 *
 * The interface covers what the analytics + BQ handlers do today. The bundled
 * REFERENCE impl reproduces TODAY's behavior EXACTLY:
 *
 *   - overview: the D1-backed /mor/v1/analytics aggregate (gas + session stats).
 *   - BQ: the existing dual-write status + backfill endpoints, which are OFF by
 *     default (BIGQUERY_ENABLED=false). The OSS standalone path is D1-only,
 *     which is already the live default; BQ is an optional producer-side tier.
 *
 * A PRIVATE analytics provider could implement warehouse-backed analytics
 * behind this same interface and be injected at src/providers/index.ts, without
 * changing what any endpoint returns. Precedent: Grafana OSS + Enterprise.
 */

import type { Env } from "../../types";
import { handleAnalytics } from "../../handlers/analytics";
import { handleBqBackfill, handleBqStatus } from "../../handlers/bq";
import { isBqEnabled } from "../../utils/bigquery";

/** One observation for the OPTIONAL warehouse raw-dump seam. Mirrors the
 * private tier's dump-row contract structurally so the OSS side never imports
 * a private type. */
export interface AnalyticsDumpInput {
	/** e.g. "network", "session", "model", "provider", "price". */
	kind: string;
	/** Natural id within the kind. */
	id: string;
	/** The raw observation, as-is. */
	payload: Record<string, unknown>;
	/** When the event happened (unix seconds, ISO string, or Date). */
	eventAt?: number | string | Date;
	/** Chain block for the observation, when the row carries one. */
	block?: number | null;
}

export interface AnalyticsProvider {
	/** D1-backed network analytics aggregate (/mor/v1/analytics). */
	overview(env: Env, headers: Record<string, string>): Promise<Response>;
	/** OPTIONAL warehouse raw-dump seam: is the dump path live? A private
	 * warehouse tier implements these; the OSS reference omits them, so the
	 * dump call site (src/sync/warehouse-dump.ts) is a standalone no-op. */
	dumpEnabled?(env: Env): boolean;
	/** OPTIONAL fire-and-forget batched dump of raw observations. Never throws. */
	dumpSafe?(env: Env, inputs: AnalyticsDumpInput[]): Promise<void>;
	/** Is the optional BigQuery dual-write / archive tier enabled? */
	bqEnabled(env: Env): boolean;
	/** BQ dual-write status (/mor/v1/bq/status). */
	bqStatus(env: Env, headers: Record<string, string>): Promise<Response>;
	/** BQ backfill from D1 (/mor/v1/bq/backfill, admin-gated). */
	bqBackfill(
		request: Request,
		env: Env,
		headers: Record<string, string>,
	): Promise<Response>;
}

/**
 * Bundled REFERENCE AnalyticsProvider. Thin, behavior-preserving delegation to
 * the existing D1 analytics + optional-BQ handlers (they stay the single
 * definition of each concern); this object is the injection seam.
 */
export const referenceAnalyticsProvider: AnalyticsProvider = {
	overview(env, headers) {
		return handleAnalytics(env, headers);
	},
	bqEnabled(env) {
		return isBqEnabled(env);
	},
	bqStatus(env, headers) {
		return handleBqStatus(env, headers);
	},
	bqBackfill(request, env, headers) {
		return handleBqBackfill(request, env, headers);
	},
};
