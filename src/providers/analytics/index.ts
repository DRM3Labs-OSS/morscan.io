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

export interface AnalyticsProvider {
	/** D1-backed network analytics aggregate (/mor/v1/analytics). */
	overview(env: Env, headers: Record<string, string>): Promise<Response>;
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
