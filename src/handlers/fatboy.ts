/**
 * Fatboy - single JSON blob with everything the SPA needs.
 *
 * Internal name: fatboy. Public endpoint: /mor/v1/ui-init.
 * NOT documented in OpenAPI. Infrastructure for the SPA only.
 *
 * Pre-built every cron cycle (buildAndCacheFatboy). On request,
 * reads the cached blob (1 D1 read). All-or-nothing: partial
 * builds never overwrite a good cache.
 */

import type { Env } from "../types";
import { getSyncState } from "../utils/rpc";
import {
	countActiveBids,
	countAllSessions,
	countProviders,
	countServingSessions,
	countZombieSessions,
	selectActiveBids,
	selectActiveSessionsByBid,
	selectActiveSessionsByProvider,
	selectAvgSessionDuration,
	selectEscrowSplit,
	selectFatboyCache,
	selectGasLifecycleStats,
	selectLatestEconomics,
	selectModelDemand,
	selectNewestModels,
	selectNewestProviders,
	selectNewestSubnets,
	selectProviderLeaderboardAllTime,
	selectProviderLeaderboardSince,
	selectRecentProviders,
	selectRecentSessions,
	selectServingProviders,
	selectTopWalletStats,
	selectWalletLeaderboardAllTime,
	selectWalletLeaderboardSince,
	upsertFatboyCache,
} from "../db/explorer-core";
import { getNamedModelIdNames, getSyncStateTokenPrices } from "../db/explorer-market";

const _JSON_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

/** Build the full fatboy JSON from D1. ~20 parallel queries. */
export async function buildFatboy(env: Env): Promise<Record<string, unknown>> {
	const nowTs = Math.floor(Date.now() / 1000);

	// Compute the serving-provider set ONCE. `SELECT DISTINCT provider FROM bids` scanned
	// the full bids table and was repeated 5x in the queries below on every fatboy build
	// (~every 60s) - the top D1 read cost. Providers are 0x hex addresses from chain;
	// sanitized to [0-9a-fx] and inlined as an IN-list (no user input, injection-safe).
	// Empty (no active bids) -> "''": IN matches nothing, NOT IN matches all - same
	// semantics as the old LEFT JOIN sp.provider IS (NOT) NULL.
	const servingRows = await selectServingProviders(env.DB);
	const servingIn =
		servingRows
			.map((r) => `'${String(r.provider).replace(/[^0-9a-zA-Zx]/g, "")}'`)
			.join(",") || "''";

	const [
		syncState,
		priceRow,
		econRow,
		providerRows,
		bidRows,
		modelRows,
		sessionRows,
		walletRows,
		provLbAll,
		provLbWeek,
		walLbAll,
		walLbWeek,
		provCount,
		bidCount,
		servingCount,
		notServingCount,
		totalCount,
		escrowSplit,
		gasRow,
		durationRow,
		activeByProvider,
		activeByBid,
		modelDemandRows,
		newProviders,
		newModels,
		newSubnets,
	] = await Promise.all([
		getSyncState(env),
		getSyncStateTokenPrices(env.DB),
		selectLatestEconomics(env.DB),
		selectRecentProviders(env.DB),
		selectActiveBids(env.DB),
		getNamedModelIdNames(env.DB),
		selectRecentSessions(env.DB),
		selectTopWalletStats(env.DB),
		selectProviderLeaderboardAllTime(env.DB),
		selectProviderLeaderboardSince(env.DB, nowTs - 604800),
		// Consumer wallets: serving = is_active AND provider has bids. Precompute serving_providers to avoid O(n*m) EXISTS.
		selectWalletLeaderboardAllTime(env.DB, servingIn),
		selectWalletLeaderboardSince(env.DB, servingIn, nowTs - 604800),
		countProviders(env.DB),
		countActiveBids(env.DB),
		// Serving = is_active AND provider has at least one active bid (LEFT JOIN instead of EXISTS)
		countServingSessions(env.DB, servingIn),
		// Not serving = is_active AND provider has NO active bids (LEFT JOIN IS NULL instead of NOT EXISTS)
		countZombieSessions(env.DB, servingIn),
		countAllSessions(env.DB),
		// MOR in escrow: split serving (live) vs zombie (stuck) - LEFT JOIN instead of EXISTS
		selectEscrowSplit(env.DB, servingIn),
		// Gas + session duration stats (inlined from analytics)
		selectGasLifecycleStats(env.DB),
		selectAvgSessionDuration(env.DB),
		selectActiveSessionsByProvider(env.DB),
		selectActiveSessionsByBid(env.DB),
		// Model demand: aggregate sessions by model across all providers
		selectModelDemand(env.DB, nowTs - 86400, nowTs - 604800),
		// Newcomers: newest arrivals by on-chain created_at (tiny tables)
		selectNewestProviders(env.DB),
		selectNewestModels(env.DB),
		selectNewestSubnets(env.DB),
	]);

	// Parse cached values
	let price: Record<string, unknown> | null = null;
	try {
		if (priceRow) price = JSON.parse(priceRow.value);
	} catch {}

	const lifecycleEth = gasRow?.lifecycle_eth || 0;
	const avgDurMins = durationRow?.avg_secs ? Math.round(durationRow.avg_secs / 60) : 0;
	const gas = {
		gas: { perSessionLifecycle: { avgEth: lifecycleEth } },
		sessions: { avgDurationMins: avgDurMins },
	};

	const e = econRow as Record<string, number> | null;
	const economics = e
		? {
				computeBalance:
					e.compute_balance > 1e15
						? Math.floor(e.compute_balance / 1e18)
						: e.compute_balance,
				totalMorSupply:
					(e.total_supply || e.total_mor_supply || 0) > 1e15
						? Math.floor((e.total_supply || e.total_mor_supply || 0) / 1e18)
						: e.total_supply || e.total_mor_supply || 0,
				stakingFactor: e.staking_factor,
				todaysBudget:
					e.todays_budget > 1e15 ? Math.floor(e.todays_budget / 1e18) : e.todays_budget,
			}
		: {};

	// Model name lookup
	const models: Record<string, string> = {};
	for (const m of modelRows as Array<Record<string, string>>) models[m.model_id] = m.name;

	// Active sessions per provider and per bid
	const activePerProvider: Record<string, number> = {};
	for (const r of activeByProvider as Array<Record<string, string | number>>)
		activePerProvider[r.provider as string] = r.active as number;
	const activePerBid: Record<string, number> = {};
	for (const r of activeByBid as Array<Record<string, string | number>>)
		activePerBid[r.bid_id as string] = r.active as number;

	// Group bids by provider, attach active session counts
	const bidsByProvider: Record<string, Array<Record<string, unknown>>> = {};
	for (const b of bidRows) {
		if (!bidsByProvider[b.provider as string]) bidsByProvider[b.provider as string] = [];
		const pps = parseFloat((b.price_per_second as string) || "0") / 1e18;
		const morDay = pps * 86400;
		const morHour = pps * 3600;
		const sf = (econRow as Record<string, number> | null)?.staking_factor || 0.00315;
		const hourlyStake = sf > 0 && morHour > 0 ? Math.ceil(morHour / sf) : 0;
		bidsByProvider[b.provider as string].push({
			...b,
			active_sessions: activePerBid[b.bid_id as string] || 0,
			morPerDay: morDay < 1 ? morDay.toFixed(4) : morDay.toFixed(2),
			hourlyStake,
		});
	}

	// Build provider list with bids + active counts, sorted by active sessions
	const providers = providerRows
		.map((p: Record<string, unknown>) => ({
			...p,
			bids: (bidsByProvider[p.address as string] || []).sort(
				(a: Record<string, unknown>, b: Record<string, unknown>) =>
					((b.active_sessions as number) || 0) - ((a.active_sessions as number) || 0),
			),
			bidCount: (bidsByProvider[p.address as string] || []).length,
			activeSessions: activePerProvider[p.address as string] || 0,
		}))
		.sort((a, b) => (b.activeSessions as number) - (a.activeSessions as number));

	return {
		economics,
		sync: {
			currentBlock: syncState.currentBlock,
			syncedBlock: syncState.lastBlock,
			blocksBehind: Math.max(0, syncState.currentBlock - syncState.lastBlock),
		},
		price: price
			? {
					usd: (price.mor as Record<string, unknown>)?.usd || price.usd || 0,
					change24h:
						(price.mor as Record<string, unknown>)?.change24h || price.change24h || 0,
					marketCap:
						(price.mor as Record<string, unknown>)?.marketCap || price.marketCap || 0,
				}
			: {},
		providers,
		leaderboard: {
			providers: { allTime: provLbAll, weekly: provLbWeek },
			wallets: { allTime: walLbAll, weekly: walLbWeek },
		},
		consumers: { wallets: walletRows, sessions: sessionRows },
		newcomers: { providers: newProviders, models: newModels, subnets: newSubnets },
		models,
		modelDemand: modelDemandRows.map((m: Record<string, unknown>) => ({
			modelId: m.model_id,
			name: models[m.model_id as string] || null,
			totalSessions: m.total_sessions,
			activeSessions: m.active_sessions,
			sessions24h: m.sessions_24h,
			sessions7d: m.sessions_7d,
			uniqueUsers: m.unique_users,
		})),
		gas: gas || {},
		stats: {
			providers: provCount?.c || 0,
			models: bidCount?.c || 0,
			serving: servingCount?.c || 0, // Sessions where provider has active bids
			zombie: notServingCount?.c || 0, // Sessions where provider retracted all bids
			totalSessions: totalCount?.c || 0,
			morServing: Math.floor(escrowSplit?.serving_mor || 0), // MOR in active sessions
			morZombie: Math.floor(escrowSplit?.zombie_mor || 0), // MOR stuck in zombie sessions
		},
		builtAt: nowTs,
	};
}

/** Build fatboy and cache in sync_state. All-or-nothing. */
export async function buildAndCacheFatboy(env: Env): Promise<void> {
	try {
		const data = await buildFatboy(env);
		await upsertFatboyCache(env.DB, JSON.stringify(data));
	} catch (e) {
		console.error("Fatboy build failed (keeping last good cache):", e);
	}
}

/** Public endpoint: /mor/v1/ui-init - reads cached blob, falls back to live build. */
export async function handleUiInit(
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	// Try cached first (1 D1 read)
	try {
		const row = await selectFatboyCache(env.DB);
		if (row) return new Response(row.value, { headers });
	} catch {}

	// Cache miss - build live
	const data = await buildFatboy(env);
	return new Response(JSON.stringify(data), { headers });
}
