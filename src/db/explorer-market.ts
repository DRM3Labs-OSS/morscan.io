/**
 * Explorer data-access layer - market side.
 *
 * Providers, bids, models, price/sync_state cache rows, network economics,
 * builder aggregates, and diamond upgrades used by the marketplace handlers.
 * SQL is moved verbatim from the handlers; behavior is byte-identical.
 * Notify list / provenance / key-history reads live in ops.ts.
 */

// ─── Row shapes ───

export interface SyncStateValueRow {
	value: string;
}

export interface CountRow {
	count: number;
}

export interface CntRow {
	cnt: number;
}

export interface ModelIdNameRow {
	model_id: string;
	name: string;
}

export interface ProviderEndpointStakeRow {
	endpoint: string;
	stake: string;
}

export interface PriceHistoryRow {
	ts: number;
	usd: number;
}

export interface SubnetNameRow {
	name: string | null;
}

// ─── Providers ───

/** All provider rows (marketplace list + full rollup). */
export async function getAllProviders(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db.prepare("SELECT * FROM providers").all<Record<string, unknown>>();
	return r.results ?? [];
}

/** One provider row by (lowercased) address. */
export async function getProviderByAddress(
	db: D1Database,
	address: string,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare("SELECT * FROM providers WHERE address = ?")
		.bind(address)
		.first<Record<string, unknown>>();
}

/** Provider endpoint + stake for the wallet profile. */
export async function getProviderEndpointStake(
	db: D1Database,
	address: string,
): Promise<ProviderEndpointStakeRow | null> {
	return db
		.prepare("SELECT endpoint, stake FROM providers WHERE address = ?")
		.bind(address)
		.first<ProviderEndpointStakeRow>();
}

/** Count of a provider's live (non-deleted) bids. */
export async function countActiveBidsForProvider(
	db: D1Database,
	address: string,
): Promise<CntRow | null> {
	return db
		.prepare(
			"SELECT COUNT(*) as cnt FROM bids WHERE provider = ? AND (deleted_at = 0 OR deleted_at IS NULL)",
		)
		.bind(address)
		.first<CntRow>();
}

// ─── Bids ───

/** Every bid joined with model names, newest first. */
export async function getAllBidsWithModels(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT b.*, m.name as model_name, m.tags as model_tags
    FROM bids b
    LEFT JOIN models m ON b.model_id = m.model_id
    ORDER BY b.updated_block DESC
  `)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Active (non-deleted) bids joined with model names. */
export async function getActiveBidsWithModels(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`SELECT b.*, m.name as model_name, m.tags as model_tags FROM bids b
      LEFT JOIN models m ON b.model_id = m.model_id WHERE b.deleted_at = 0 OR b.deleted_at IS NULL`)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Retracted bids joined with model names, most recently deleted first. */
export async function getRetractedBidsWithModels(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`SELECT b.*, m.name as model_name, m.tags as model_tags FROM bids b
      LEFT JOIN models m ON b.model_id = m.model_id WHERE b.deleted_at > 0 ORDER BY b.deleted_at DESC`)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** A provider's active bids joined with model names. */
export async function getProviderActiveBidsWithModels(
	db: D1Database,
	address: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT b.*, m.name as model_name, m.tags as model_tags
      FROM bids b LEFT JOIN models m ON b.model_id = m.model_id
      WHERE b.provider = ? AND (b.deleted_at = 0 OR b.deleted_at IS NULL)
    `)
		.bind(address)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** A provider's retracted bids joined with model names (most recent 50). */
export async function getProviderRetractedBidsWithModels(
	db: D1Database,
	address: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT b.*, m.name as model_name, m.tags as model_tags
      FROM bids b LEFT JOIN models m ON b.model_id = m.model_id
      WHERE b.provider = ? AND b.deleted_at > 0
      ORDER BY b.deleted_at DESC LIMIT 50
    `)
		.bind(address)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Session-referenced bid ids missing from the bids table (discovery backfill). */
export async function getMissingSessionBids(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT DISTINCT s.bid_id, s.provider
    FROM sessions s
    LEFT JOIN bids b ON s.bid_id = b.bid_id
    WHERE b.bid_id IS NULL AND s.bid_id IS NOT NULL AND s.bid_id != ''
    LIMIT 100
  `)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Upsert one bid discovered from chain. */
export async function upsertDiscoveredBid(
	db: D1Database,
	bidId: string,
	provider: string,
	modelId: string,
	pricePerSecond: string,
	nonce: number,
	createdAt: number,
	deletedAt: number,
	updatedBlock: number,
): Promise<D1Result> {
	return db
		.prepare(`
          INSERT OR REPLACE INTO bids (bid_id, provider, model_id, price_per_second, nonce, created_at, deleted_at, updated_block)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
		.bind(
			bidId,
			provider,
			modelId,
			pricePerSecond,
			nonce,
			createdAt,
			deletedAt,
			updatedBlock,
		)
		.run();
}

/** Per-model bid supply stats: count, price spread, provider count. */
export async function getBidStatsByModel(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
      SELECT model_id, COUNT(*) as bid_count,
             MIN(CAST(price_per_second AS REAL)) as min_price,
             MAX(CAST(price_per_second AS REAL)) as max_price,
             AVG(CAST(price_per_second AS REAL)) as avg_price,
             COUNT(DISTINCT provider) as provider_count
      FROM bids WHERE (deleted_at = 0 OR deleted_at IS NULL) AND model_id != ''
      GROUP BY model_id
    `)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Per-model market tape row: cheapest active ask now + cheapest ask as of a
 * past cutoff (both from on-chain bid lifecycle timestamps), provider count.
 * Feeds the scrolling header ticker; models with the deepest supply first. */
export interface TickerModelRow {
	model_id: string;
	name: string | null;
	min_price: number | null;
	min_price_then: number | null;
	provider_count: number;
	bid_count: number;
}

export async function getTickerModels(
	db: D1Database,
	cutoffUnixSec: number,
	limit = 24,
): Promise<TickerModelRow[]> {
	const r = await db
		.prepare(`
      SELECT b.model_id, m.name,
             MIN(CAST(b.price_per_second AS REAL)) as min_price,
             COUNT(DISTINCT b.provider) as provider_count,
             COUNT(*) as bid_count,
             (SELECT MIN(CAST(p.price_per_second AS REAL)) FROM bids p
                WHERE p.model_id = b.model_id AND p.created_at <= ?1
                  AND (p.deleted_at = 0 OR p.deleted_at IS NULL OR p.deleted_at > ?1)
             ) as min_price_then
      FROM bids b LEFT JOIN models m ON m.model_id = b.model_id
      WHERE (b.deleted_at = 0 OR b.deleted_at IS NULL) AND b.model_id != ''
      GROUP BY b.model_id, m.name
      ORDER BY provider_count DESC, bid_count DESC, min_price ASC
      LIMIT ?2
    `)
		.bind(cutoffUnixSec, limit)
		.all<TickerModelRow>();
	return r.results ?? [];
}

/** Active/retracted bid counts per provider. */
export async function countBidsByProvider(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT
      provider,
      COUNT(CASE WHEN deleted_at = 0 THEN 1 END) as active_bids,
      COUNT(CASE WHEN deleted_at > 0 THEN 1 END) as retracted_bids
    FROM bids
    GROUP BY provider
  `)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** All of a provider's bids (active + retracted) for the reputation detail. */
export async function getProviderBids(
	db: D1Database,
	provider: string,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT bid_id, model_id, price_per_second, created_at, deleted_at
    FROM bids WHERE provider = ?
  `)
		.bind(provider)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

// ─── Models ───

/** Every model row, alphabetical. */
export async function getModelsOrderedByName(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare("SELECT * FROM models ORDER BY name")
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Name + description for one model id. */
export async function getModelById(
	db: D1Database,
	modelId: string,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare("SELECT name, description FROM models WHERE model_id = ?")
		.bind(modelId)
		.first<Record<string, unknown>>();
}

/** Upsert a model name/description, preserving the original created_at. */
export async function upsertModel(
	db: D1Database,
	modelId: string,
	name: string,
	description: string,
	now: number,
): Promise<D1Result> {
	return db
		.prepare(`
    INSERT OR REPLACE INTO models (model_id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, COALESCE((SELECT created_at FROM models WHERE model_id = ?), ?), ?)
  `)
		.bind(modelId, name, description, modelId, now, now)
		.run();
}

/** model_id -> name pairs for every model. */
export async function getModelIdNames(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		// Newest first: the landing search index takes the FIRST N matches, and a
		// just-registered model (Kimi K3, 2026-07-17) is exactly what people search
		// for - unordered table order buried it behind years-old siblings.
		.prepare("SELECT model_id, name FROM models ORDER BY created_at DESC")
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** model_id, name, tags for every model. */
export async function getModelIdNameTags(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare("SELECT model_id, name, tags FROM models")
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** model_id -> name pairs, named models only. */
export async function getNamedModelIdNames(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare("SELECT model_id, name FROM models WHERE name IS NOT NULL")
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Names for a specific set of model ids (dynamic IN list, ids lowercased). */
export async function getModelNamesByIds(
	db: D1Database,
	modelIds: string[],
): Promise<ModelIdNameRow[]> {
	const placeholders = modelIds.map(() => "?").join(",");
	const r = await db
		.prepare(`SELECT model_id, name FROM models WHERE model_id IN (${placeholders})`)
		.bind(...modelIds.map((id) => id.toLowerCase()))
		.all<ModelIdNameRow>();
	return r.results ?? [];
}

// ─── Economics ───

/** The singleton network economics row. */
export async function getNetworkEconomics(
	db: D1Database,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare("SELECT * FROM network_economics WHERE id = 1")
		.first<Record<string, unknown>>();
}

/** Last 30 economics history rows, newest first. */
export async function getEconomicsHistoryDesc(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare("SELECT * FROM economics_history ORDER BY date DESC LIMIT 30")
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

/** Full economics history (key columns), oldest first. */
export async function getEconomicsHistoryAsc(
	db: D1Database,
): Promise<Record<string, unknown>[]> {
	const r = await db
		.prepare(`
    SELECT date, staking_factor, compute_balance, total_mor_supply
    FROM economics_history
    ORDER BY date ASC
  `)
		.all<Record<string, unknown>>();
	return r.results ?? [];
}

// ─── Price + sync_state cache rows ───

/** Cached token price blob (sync_state key 'token_prices'). */
export async function getSyncStateTokenPrices(
	db: D1Database,
): Promise<SyncStateValueRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = 'token_prices'")
		.first<SyncStateValueRow>();
}

/** Write the cached token price blob. */
export async function setSyncStateTokenPrices(
	db: D1Database,
	value: string,
): Promise<D1Result> {
	return db
		.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('token_prices', ?)")
		.bind(value)
		.run();
}

/** Cached MOR circulating supply (sync_state key 'mor_circulating_supply'). */
export async function getSyncStateCirculatingSupply(
	db: D1Database,
): Promise<SyncStateValueRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = 'mor_circulating_supply'")
		.first<SyncStateValueRow>();
}

/** Write the cached MOR circulating supply. */
export async function setSyncStateCirculatingSupply(
	db: D1Database,
	value: string,
): Promise<D1Result> {
	return db
		.prepare(
			"INSERT OR REPLACE INTO sync_state (key, value) VALUES ('mor_circulating_supply', ?)",
		)
		.bind(value)
		.run();
}

/** Cached CoinGecko 90-day chart baseline (sync_state key 'mor_price_chart'). */
export async function getSyncStatePriceChart(
	db: D1Database,
): Promise<SyncStateValueRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = 'mor_price_chart'")
		.first<SyncStateValueRow>();
}

/** Write the cached chart baseline. */
export async function setSyncStatePriceChart(
	db: D1Database,
	value: string,
): Promise<D1Result> {
	return db
		.prepare(
			"INSERT OR REPLACE INTO sync_state (key, value) VALUES ('mor_price_chart', ?)",
		)
		.bind(value)
		.run();
}

/** Our own recorded on-chain price points since a cutoff, ascending. */
export async function getPriceHistorySince(
	db: D1Database,
	cutoff: number,
): Promise<PriceHistoryRow[]> {
	const r = await db
		.prepare(
			"SELECT ts, usd FROM price_history WHERE ts >= ? AND usd > 0 ORDER BY ts ASC",
		)
		.bind(cutoff)
		.all<PriceHistoryRow>();
	return r.results ?? [];
}

// Pre-built fatboy SPA blob: use selectFatboyCache from explorer-core.ts (canonical).

/** Last synced block (sync_state key 'last_block'). */
export async function getSyncStateLastBlock(
	db: D1Database,
): Promise<SyncStateValueRow | null> {
	return db
		.prepare("SELECT value FROM sync_state WHERE key = 'last_block'")
		.first<SyncStateValueRow>();
}

// ─── Builder aggregates ───

/** Builder global stats blob (literal key). */
export async function getBuilderGlobalStats(
	db: D1Database,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare("SELECT value FROM builder_sync_state WHERE key = 'global_stats'")
		.first<Record<string, unknown>>();
}

// Builder sync-state value by key: use getBuilderSyncStateValue from sync-builder.ts (canonical).

/** Total builder subnet count. */
export async function countBuilderSubnets(db: D1Database): Promise<CntRow | null> {
	return db.prepare("SELECT COUNT(*) as cnt FROM builder_subnets").first<CntRow>();
}

/** Display name for one builder subnet. */
export async function getBuilderSubnetName(
	db: D1Database,
	subnetId: string,
): Promise<SubnetNameRow | null> {
	return db
		.prepare("SELECT name FROM builder_subnets WHERE subnet_id = ?")
		.bind(subnetId)
		.first<SubnetNameRow>();
}

// ─── Diamond upgrades ───

/** Most recent diamond upgrade event. */
export async function getLatestDiamondUpgrade(
	db: D1Database,
): Promise<Record<string, unknown> | null> {
	return db
		.prepare(
			"SELECT block_number, block_timestamp, facet_count FROM diamond_upgrades ORDER BY block_number DESC LIMIT 1",
		)
		.first<Record<string, unknown>>();
}

/** Total diamond upgrade count. */
export async function countDiamondUpgrades(db: D1Database): Promise<CountRow | null> {
	return db.prepare("SELECT COUNT(*) as count FROM diamond_upgrades").first<CountRow>();
}
