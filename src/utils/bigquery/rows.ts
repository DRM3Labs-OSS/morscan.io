/**
 * BigQuery row builders - one per MorScan table.
 *
 * Shape mirrors the BQ schema in seed/bq-schema.sql. All timestamps are UNIX
 * seconds in D1 but are promoted to ISO strings on the BQ side for
 * partition/cluster friendliness.
 */

import type { BqRow } from "./client";

export function sessionRow(d1: {
	id: string;
	user_address: string;
	bid_id: string;
	provider: string;
	model_id: string;
	stake: string;
	opened_at: number;
	ends_at: number;
	closed_at: number | null;
	is_active: number;
	updated_block: number;
	open_tx_hash?: string | null;
	close_tx_hash?: string | null;
}): BqRow {
	return {
		insertId: `session:${d1.id}:${d1.updated_block}`,
		json: {
			id: d1.id,
			user_address: d1.user_address,
			bid_id: d1.bid_id,
			provider: d1.provider,
			model_id: d1.model_id,
			stake: d1.stake,
			opened_at: new Date(d1.opened_at * 1000).toISOString(),
			ends_at: d1.ends_at ? new Date(d1.ends_at * 1000).toISOString() : null,
			closed_at: d1.closed_at ? new Date(d1.closed_at * 1000).toISOString() : null,
			is_active: d1.is_active === 1,
			updated_block: d1.updated_block,
			open_tx_hash: d1.open_tx_hash || null,
			close_tx_hash: d1.close_tx_hash || null,
			observed_at: new Date().toISOString(),
		},
	};
}

export function bidRow(d1: {
	bid_id: string;
	provider: string;
	model_id: string;
	price_per_second: string;
	nonce: number;
	created_at: number;
	deleted_at: number;
	updated_block: number;
}): BqRow {
	return {
		insertId: `bid:${d1.bid_id}:${d1.updated_block}`,
		json: {
			bid_id: d1.bid_id,
			provider: d1.provider,
			model_id: d1.model_id,
			price_per_second: d1.price_per_second,
			nonce: d1.nonce,
			created_at: new Date(d1.created_at * 1000).toISOString(),
			deleted_at: d1.deleted_at ? new Date(d1.deleted_at * 1000).toISOString() : null,
			updated_block: d1.updated_block,
			observed_at: new Date().toISOString(),
		},
	};
}

export function economicsHistoryRow(d1: {
	date: string;
	staking_factor: number | string;
	compute_balance: string;
	mor_distributed: string;
	[k: string]: unknown;
}): BqRow {
	return {
		insertId: `econ:${d1.date}`,
		json: {
			...d1,
			observed_at: new Date().toISOString(),
		},
	};
}

// --- v1.31.0 additions: models, providers, builder_* dual-write -------
// Added so downstream warehouse consumers can surface human model names, detect
// newly registered providers from a real registration stream, and roll up
// builder activity over time.

export function modelRow(d1: {
	model_id: string;
	name: string | null;
	tags: string | null;
	description?: string | null;
	created_at?: number | null;
	updated_at: number;
}): BqRow {
	return {
		insertId: `model:${d1.model_id}:${d1.updated_at}`,
		json: {
			model_id: d1.model_id,
			name: d1.name || null,
			tags: d1.tags || null,
			description: d1.description ?? null,
			created_at: d1.created_at ? new Date(d1.created_at * 1000).toISOString() : null,
			updated_at: new Date(d1.updated_at * 1000).toISOString(),
			observed_at: new Date().toISOString(),
		},
	};
}

export function providerRow(d1: {
	address: string;
	endpoint: string | null;
	stake: string | null;
	created_at: number | null;
	updated_block: number | null;
}): BqRow {
	return {
		insertId: `provider:${d1.address}:${d1.updated_block || 0}`,
		json: {
			address: d1.address,
			endpoint: d1.endpoint || null,
			stake: d1.stake || "0",
			created_at: d1.created_at ? new Date(d1.created_at * 1000).toISOString() : null,
			updated_block: d1.updated_block || null,
			observed_at: new Date().toISOString(),
		},
	};
}

// Builder-plane + provider_stats row builders live in rows-builder.ts to keep
// this file within the per-file size budget. Re-exported for callers.
export {
	builderSubnetRow,
	builderStakeRow,
	builderEventRow,
	providerStatsRow,
} from "./rows-builder";
