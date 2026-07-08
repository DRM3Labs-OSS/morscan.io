/**
 * Canonical session ledger and wallet accounting.
 *
 * Every handler that needs session state or MOR buckets reads from here.
 * One classifier, one aggregator, one shape.
 */

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

export type SessionState =
	| "active_open"
	| "expired_open"
	| "closed"
	| "hold_locked"
	| "hold_withdrawable"
	| "unknown_partial";

export interface ClassifiedSession {
	id: string;
	user_address: string;
	provider: string;
	model_id: string;
	bid_id: string;
	stake: string;
	opened_at: number;
	ends_at: number;
	closed_at: number;
	is_active: number;
	closeout_type: number;
	provider_withdrawn: string;
	updated_block: number;
	open_tx_hash?: string;
	close_tx_hash?: string;
	state: SessionState;
}

export function classifySession(row: Record<string, unknown>, now: number): SessionState {
	const isActive = (row.is_active as number) === 1;
	const closedAt = (row.closed_at as number) || 0;
	const endsAt = (row.ends_at as number) || 0;
	const providerWithdrawn = String(row.provider_withdrawn || "0");

	if (!isActive && closedAt > 0) {
		if (providerWithdrawn === "1") return "hold_withdrawable";
		return "closed";
	}

	if (!isActive && closedAt === 0) {
		return "unknown_partial";
	}

	if (isActive && endsAt > 0 && endsAt < now) {
		return "expired_open";
	}

	if (isActive) {
		return "active_open";
	}

	return "unknown_partial";
}

export function toClassified(
	row: Record<string, unknown>,
	now: number,
): ClassifiedSession {
	return {
		id: String(row.id || ""),
		user_address: String(row.user_address || ""),
		provider: String(row.provider || ""),
		model_id: String(row.model_id || ""),
		bid_id: String(row.bid_id || ""),
		stake: String(row.stake || "0"),
		opened_at: (row.opened_at as number) || 0,
		ends_at: (row.ends_at as number) || 0,
		closed_at: (row.closed_at as number) || 0,
		is_active: (row.is_active as number) || 0,
		closeout_type: (row.closeout_type as number) || 0,
		provider_withdrawn: String(row.provider_withdrawn || "0"),
		updated_block: (row.updated_block as number) || 0,
		open_tx_hash: row.open_tx_hash ? String(row.open_tx_hash) : undefined,
		close_tx_hash: row.close_tx_hash ? String(row.close_tx_hash) : undefined,
		state: classifySession(row, now),
	};
}

// ---------------------------------------------------------------------------
// Wallet accounting object
// ---------------------------------------------------------------------------

export interface WalletAccounting {
	wallet: string;
	wallet_mor: string;
	wallet_mor_wei: string;
	staked_mor: string;
	staked_mor_wei: string;
	reclaimable_mor: string;
	reclaimable_mor_wei: string;
	locked_mor: string;
	locked_mor_wei: string;
	total_mor: string;
	total_mor_wei: string;
	eth_balance: string;
	eth_balance_wei: string;
	stakes_on_hold: {
		available: string;
		available_wei: string;
		on_hold: string;
		on_hold_wei: string;
	};
	sessions: ClassifiedSession[];
	counts: {
		active_open: number;
		expired_open: number;
		closed: number;
		hold_locked: number;
		hold_withdrawable: number;
		unknown_partial: number;
		total: number;
	};
	as_of_block: number;
	partial: boolean;
	partial_reason: string | null;
}

export function weiToMor(wei: bigint): string {
	return (Number(wei) / 1e18).toFixed(4);
}

// buildWalletAccounting lives in accounting-wallet.ts (size budget); re-export.
export { buildWalletAccounting } from "./wallet";

// ---------------------------------------------------------------------------
// Audit helper - prints canonical accounting for a wallet
// ---------------------------------------------------------------------------

export function formatAudit(a: WalletAccounting): string {
	const lines = [
		`WALLET ACCOUNTING AUDIT`,
		`wallet:      ${a.wallet}`,
		`as_of_block: ${a.as_of_block}`,
		`partial:     ${a.partial}${a.partial_reason ? ` (${a.partial_reason})` : ""}`,
		``,
		`BUCKETS`,
		`  wallet:      ${a.wallet_mor} MOR`,
		`  staked:      ${a.staked_mor} MOR  (${a.counts.active_open} active sessions)`,
		`  reclaimable: ${a.reclaimable_mor} MOR  (${a.counts.expired_open} expired sessions)`,
		`  locked:      ${a.locked_mor} MOR  (${a.counts.hold_locked + a.counts.unknown_partial} sessions)`,
		`  total:       ${a.total_mor} MOR`,
		``,
		`INVARIANT CHECK`,
		`  wallet + staked + reclaimable + locked = total`,
		`  ${a.wallet_mor} + ${a.staked_mor} + ${a.reclaimable_mor} + ${a.locked_mor} = ${a.total_mor}`,
		``,
		`COUNTS`,
		`  active_open:       ${a.counts.active_open}`,
		`  expired_open:      ${a.counts.expired_open}`,
		`  closed:            ${a.counts.closed}`,
		`  hold_locked:       ${a.counts.hold_locked}`,
		`  hold_withdrawable: ${a.counts.hold_withdrawable}`,
		`  unknown_partial:   ${a.counts.unknown_partial}`,
		`  total:             ${a.counts.total}`,
		``,
		`SESSIONS`,
	];
	for (const s of a.sessions.filter(
		(s) => s.state !== "closed" && s.state !== "hold_withdrawable",
	)) {
		const mor = (Number(BigInt(s.stake)) / 1e18).toFixed(2);
		lines.push(
			`  ${s.id.slice(0, 18)}... ${s.state.padEnd(18)} ${mor.padStart(10)} MOR  provider=${s.provider.slice(0, 12)}...`,
		);
	}
	return lines.join("\n");
}
