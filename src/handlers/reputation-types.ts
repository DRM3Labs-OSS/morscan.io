/** Shared row shapes for the provider-reputation handlers. */

export interface ProviderReputationRow {
	provider: string;
	model_id: string;
	success_count: number;
	dispute_count: number;
	early_termination_count: number;
	total_sessions: number;
	tps_scaled: number;
	ttft_ms: number;
}

export interface ProviderBidRow {
	provider: string;
	active_bids: number;
	retracted_bids: number;
}
