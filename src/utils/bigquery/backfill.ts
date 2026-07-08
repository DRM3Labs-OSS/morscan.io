/**
 * D1->BQ backfill helpers - read D1 slice, ship to BQ.
 *
 * Bounded by LIMIT so a single call never runs away. Caller iterates pagination.
 */

import {
	listBidsForBackfill,
	listBuilderEventsForBackfill,
	listBuilderStakesForBackfill,
	listBuilderSubnetsForBackfill,
	listEconomicsHistoryForBackfill,
	listModelsForBackfill,
	listProviderStatsForBackfill,
	listProvidersForBackfill,
	listSessionsForBackfill,
} from "../../db/ops";
import type { Env } from "../../types";
import { insertRows, isBqEnabled } from "./client";
import {
	sessionRow,
	bidRow,
	economicsHistoryRow,
	modelRow,
	providerRow,
	builderSubnetRow,
	builderStakeRow,
	builderEventRow,
	providerStatsRow,
} from "./rows";

export async function backfillSessions(
	env: Env,
	limit: number = 500,
	afterId?: string,
): Promise<{ written: number; lastId: string | null }> {
	if (!isBqEnabled(env)) return { written: 0, lastId: null };
	const results = await listSessionsForBackfill<Parameters<typeof sessionRow>[0]>(
		env.DB,
		limit,
		afterId,
	);
	if (results.length === 0) return { written: 0, lastId: null };
	await insertRows(env, "sessions", results.map(sessionRow));
	return { written: results.length, lastId: results[results.length - 1].id };
}

export async function backfillBids(
	env: Env,
	limit: number = 500,
	afterId?: string,
): Promise<{ written: number; lastId: string | null }> {
	if (!isBqEnabled(env)) return { written: 0, lastId: null };
	const results = await listBidsForBackfill<Parameters<typeof bidRow>[0]>(
		env.DB,
		limit,
		afterId,
	);
	if (results.length === 0) return { written: 0, lastId: null };
	await insertRows(env, "bids", results.map(bidRow));
	return { written: results.length, lastId: results[results.length - 1].bid_id };
}

export async function backfillEconomicsHistory(
	env: Env,
	limit: number = 500,
): Promise<{ written: number }> {
	if (!isBqEnabled(env)) return { written: 0 };
	const results = await listEconomicsHistoryForBackfill<
		Parameters<typeof economicsHistoryRow>[0]
	>(env.DB, limit);
	if (results.length === 0) return { written: 0 };
	await insertRows(env, "economics_history", results.map(economicsHistoryRow));
	return { written: results.length };
}

export async function backfillModels(
	env: Env,
	limit: number = 500,
	afterId?: string,
): Promise<{ written: number; lastId: string | null }> {
	if (!isBqEnabled(env)) return { written: 0, lastId: null };
	const results = await listModelsForBackfill<Parameters<typeof modelRow>[0]>(
		env.DB,
		limit,
		afterId,
	);
	if (results.length === 0) return { written: 0, lastId: null };
	await insertRows(env, "models", results.map(modelRow));
	return { written: results.length, lastId: results[results.length - 1].model_id };
}

export async function backfillProviders(
	env: Env,
	limit: number = 500,
	afterId?: string,
): Promise<{ written: number; lastId: string | null }> {
	if (!isBqEnabled(env)) return { written: 0, lastId: null };
	const results = await listProvidersForBackfill<Parameters<typeof providerRow>[0]>(
		env.DB,
		limit,
		afterId,
	);
	if (results.length === 0) return { written: 0, lastId: null };
	await insertRows(env, "providers", results.map(providerRow));
	return { written: results.length, lastId: results[results.length - 1].address };
}

export async function backfillBuilderSubnets(
	env: Env,
	limit: number = 500,
	afterId?: string,
): Promise<{ written: number; lastId: string | null }> {
	if (!isBqEnabled(env)) return { written: 0, lastId: null };
	const results = await listBuilderSubnetsForBackfill<
		Parameters<typeof builderSubnetRow>[0]
	>(env.DB, limit, afterId);
	if (results.length === 0) return { written: 0, lastId: null };
	await insertRows(env, "builder_subnets", results.map(builderSubnetRow));
	return { written: results.length, lastId: results[results.length - 1].subnet_id };
}

export async function backfillBuilderStakes(
	env: Env,
	limit: number = 500,
	afterId?: number,
): Promise<{ written: number; lastId: number | null }> {
	if (!isBqEnabled(env)) return { written: 0, lastId: null };
	const results = await listBuilderStakesForBackfill<
		Parameters<typeof builderStakeRow>[0] & { id: number }
	>(env.DB, limit, afterId);
	if (results.length === 0) return { written: 0, lastId: null };
	await insertRows(env, "builder_stakes", results.map(builderStakeRow));
	return { written: results.length, lastId: results[results.length - 1].id };
}

export async function backfillBuilderEvents(
	env: Env,
	limit: number = 500,
	afterId?: number,
): Promise<{ written: number; lastId: number | null }> {
	if (!isBqEnabled(env)) return { written: 0, lastId: null };
	const results = await listBuilderEventsForBackfill<
		Parameters<typeof builderEventRow>[0]
	>(env.DB, limit, afterId);
	if (results.length === 0) return { written: 0, lastId: null };
	await insertRows(env, "builder_events", results.map(builderEventRow));
	return { written: results.length, lastId: results[results.length - 1].id };
}

/**
 * Backfill provider_stats into BQ. Paginates on the composite (provider,
 * model_id) cursor - D1 doesn't give us an autoincrement id on this table,
 * so we sort by (provider, model_id) and use a concatenated sentinel in the
 * `after` param shaped `provider|model_id`. Callers typically don't paginate
 * - provider_stats at current network scale is ~114 rows, one call covers it.
 */
export async function backfillProviderStats(
	env: Env,
	limit: number = 500,
	afterCursor?: string,
): Promise<{ written: number; lastId: string | null }> {
	if (!isBqEnabled(env)) return { written: 0, lastId: null };
	let afterProvider = "";
	let afterModel = "";
	if (afterCursor) {
		const pipe = afterCursor.indexOf("|");
		if (pipe > 0) {
			afterProvider = afterCursor.slice(0, pipe);
			afterModel = afterCursor.slice(pipe + 1);
		}
	}
	const results = await listProviderStatsForBackfill<
		Parameters<typeof providerStatsRow>[0]
	>(env.DB, limit, afterProvider, afterModel, Boolean(afterCursor));
	if (results.length === 0) return { written: 0, lastId: null };
	await insertRows(env, "provider_stats", results.map(providerStatsRow));
	const last = results[results.length - 1];
	return { written: results.length, lastId: `${last.provider}|${last.model_id}` };
}
