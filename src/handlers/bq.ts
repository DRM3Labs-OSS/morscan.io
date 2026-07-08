/**
 * BQ admin endpoints: status + backfill.
 *
 * Dual-write is enabled via `BIGQUERY_ENABLED=true` + a service-account
 * secret. While enabled, the sync writes to both D1 and BQ. The backfill
 * endpoints seed BQ from existing D1 rows so the tables have the historical
 * record without waiting for natural churn.
 */

import type { Env } from "../types";
import {
	backfillBids,
	backfillBuilderEvents,
	backfillBuilderStakes,
	backfillBuilderSubnets,
	backfillEconomicsHistory,
	backfillModels,
	backfillProviders,
	backfillProviderStats,
	backfillSessions,
	isBqEnabled,
} from "../utils/bigquery";

export async function handleBqStatus(
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	const enabled = isBqEnabled(env);
	const projectId = env.BIGQUERY_PROJECT_ID || null;
	const datasetId = env.BIGQUERY_DATASET_ID || null;
	const hasKey = !!env.BIGQUERY_SERVICE_ACCOUNT_KEY;
	return new Response(
		JSON.stringify({
			enabled,
			projectId,
			datasetId,
			hasServiceAccountKey: hasKey,
			note: enabled
				? "BQ dual-write is active. Sync writes to both D1 and BQ; reads still go to D1 until Phase 2."
				: "BQ dual-write is NOT active. Set BIGQUERY_ENABLED=true plus BIGQUERY_SERVICE_ACCOUNT_KEY secret.",
		}),
		{ headers },
	);
}

/**
 * POST /mor/v1/bq/backfill?table=sessions&limit=500&after=<id>
 * Reads up to `limit` rows from D1 and writes them to BQ. Returns lastId
 * for pagination. Callers loop until `written=0`.
 */
export async function handleBqBackfill(
	request: Request,
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	if (!isBqEnabled(env)) {
		return new Response(JSON.stringify({ error: "BQ not enabled" }), {
			status: 400,
			headers,
		});
	}
	const url = new URL(request.url);
	const table = url.searchParams.get("table") || "sessions";
	const limit = Math.min(
		parseInt(url.searchParams.get("limit") || "500", 10) || 500,
		500,
	);
	const after = url.searchParams.get("after") || undefined;

	try {
		if (table === "sessions") {
			const r = await backfillSessions(env, limit, after);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		if (table === "bids") {
			const r = await backfillBids(env, limit, after);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		if (table === "economics_history") {
			const r = await backfillEconomicsHistory(env, limit);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		if (table === "models") {
			const r = await backfillModels(env, limit, after);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		if (table === "providers") {
			const r = await backfillProviders(env, limit, after);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		if (table === "builder_subnets") {
			const r = await backfillBuilderSubnets(env, limit, after);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		if (table === "builder_stakes") {
			const afterNum = after ? parseInt(after, 10) : undefined;
			const r = await backfillBuilderStakes(env, limit, afterNum);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		if (table === "builder_events") {
			const afterNum = after ? parseInt(after, 10) : undefined;
			const r = await backfillBuilderEvents(env, limit, afterNum);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		if (table === "provider_stats") {
			const r = await backfillProviderStats(env, limit, after);
			return new Response(JSON.stringify({ table, ...r }), { headers });
		}
		return new Response(JSON.stringify({ error: `unknown table: ${table}` }), {
			status: 400,
			headers,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "backfill failed";
		return new Response(JSON.stringify({ error: msg }), { status: 500, headers });
	}
}
