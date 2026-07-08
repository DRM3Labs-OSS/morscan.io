/**
 * BigQuery row builders - builder-plane + provider_stats tables.
 * Split out of rows.ts to keep each file under the size budget; re-exported
 * from rows.ts so importers are unaffected.
 */

import type { BqRow } from "./client";

export function builderSubnetRow(d1: {
	subnet_id: string;
	name: string | null;
	admin: string | null;
	claim_admin?: string | null;
	minimal_deposit: string | null;
	withdraw_lock_period: number | null;
	total_deposited: string | null;
	pending_rewards: string | null;
	staker_count: string | null;
	metadata_name?: string | null;
	metadata_description?: string | null;
	metadata_url?: string | null;
	metadata_logo?: string | null;
	chain?: string | null;
	created_at: number | null;
	updated_at: number | null;
}): BqRow {
	// `updated_at` provides the natural cache-bust for repeated observations;
	// if it's null, fall back to current time so repeated writes still distinguish.
	const stamp = d1.updated_at || Math.floor(Date.now() / 1000);
	return {
		insertId: `builder_subnet:${d1.subnet_id}:${stamp}`,
		json: {
			subnet_id: d1.subnet_id,
			name: d1.name || null,
			admin: d1.admin || null,
			claim_admin: d1.claim_admin ?? null,
			minimal_deposit: d1.minimal_deposit || "0",
			withdraw_lock_period: d1.withdraw_lock_period || null,
			total_deposited: d1.total_deposited || "0",
			pending_rewards: d1.pending_rewards || "0",
			staker_count: d1.staker_count || "0",
			metadata_name: d1.metadata_name || null,
			metadata_description: d1.metadata_description || null,
			metadata_url: d1.metadata_url || null,
			metadata_logo: d1.metadata_logo || null,
			chain: d1.chain || null,
			created_at: d1.created_at ? new Date(d1.created_at * 1000).toISOString() : null,
			updated_at: d1.updated_at ? new Date(d1.updated_at * 1000).toISOString() : null,
			observed_at: new Date().toISOString(),
		},
	};
}

export function builderStakeRow(d1: {
	subnet_id: string;
	wallet: string;
	deposited: string | null;
	last_deposit_at: number | null;
	unlock_at: number | null;
	created_at: number | null;
	updated_at: number | null;
}): BqRow {
	const stamp = d1.updated_at || d1.last_deposit_at || Math.floor(Date.now() / 1000);
	return {
		insertId: `builder_stake:${d1.subnet_id}:${d1.wallet}:${stamp}`,
		json: {
			subnet_id: d1.subnet_id,
			wallet: d1.wallet,
			deposited: d1.deposited || "0",
			last_deposit_at: d1.last_deposit_at
				? new Date(d1.last_deposit_at * 1000).toISOString()
				: null,
			unlock_at: d1.unlock_at ? new Date(d1.unlock_at * 1000).toISOString() : null,
			created_at: d1.created_at ? new Date(d1.created_at * 1000).toISOString() : null,
			updated_at: d1.updated_at ? new Date(d1.updated_at * 1000).toISOString() : null,
			observed_at: new Date().toISOString(),
		},
	};
}

export function builderEventRow(d1: {
	id: number;
	event_type: string;
	subnet_id: string;
	wallet: string | null;
	amount: string | null;
	tx_hash: string | null;
	block_number: number | null;
	block_timestamp: number | null;
	log_index: number | null;
}): BqRow {
	// (tx_hash, log_index) is the canonical on-chain identity for an event.
	// Fall back to D1's autoincrement id if log_index is null (backfill edge case).
	const uniq =
		d1.log_index !== null ? `${d1.tx_hash || "notx"}:${d1.log_index}` : `row:${d1.id}`;
	return {
		insertId: `builder_event:${uniq}`,
		json: {
			event_type: d1.event_type,
			subnet_id: d1.subnet_id,
			wallet: d1.wallet || null,
			amount: d1.amount || null,
			tx_hash: d1.tx_hash || null,
			block_number: d1.block_number || null,
			block_timestamp: d1.block_timestamp
				? new Date(d1.block_timestamp * 1000).toISOString()
				: null,
			log_index: d1.log_index ?? null,
			observed_at: new Date().toISOString(),
		},
	};
}

// --- v1.33.0: provider_stats dual-write ---
// Per-provider per-model reputation snapshot. D1 rewrites this table on
// every sync tick (DELETE + INSERT in refreshProviderStats). BQ acts as
// a historical archive - each observed_at snapshot lets Signals pull
// "reputation trend for provider X over the last N weeks" without
// extra bookkeeping. Append-only on the BQ side; `updated_at` captures
// the D1-side computation time, `observed_at` captures the BQ write time.

export function providerStatsRow(d1: {
	provider: string;
	model_id: string;
	success_count: number;
	dispute_count: number;
	early_termination_count: number;
	total_sessions: number;
	avg_duration_secs: number;
	updated_at: number;
}): BqRow {
	return {
		insertId: `provider_stat:${d1.provider}:${d1.model_id}:${d1.updated_at}`,
		json: {
			provider: d1.provider,
			model_id: d1.model_id,
			success_count: d1.success_count,
			dispute_count: d1.dispute_count,
			early_termination_count: d1.early_termination_count,
			total_sessions: d1.total_sessions,
			avg_duration_secs: d1.avg_duration_secs,
			updated_at: new Date(d1.updated_at * 1000).toISOString(),
			observed_at: new Date().toISOString(),
		},
	};
}
