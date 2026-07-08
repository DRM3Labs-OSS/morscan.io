/**
 * Stake-indexed capacity tiers.
 *
 * The capacity model: connect a wallet for a free bottom-tier API key, then
 * stake MOR on the MorScan builder subnet on Base and capacity follows your
 * live stake. Monthly volume is the anchored good; the per-minute burst limit
 * is abuse protection, not the product.
 *
 *   unstaked (connected wallet): 60/min, 2,000/day, 40,000/month
 *   staked:  burst/min = max(60, min(10000, 3 * MOR))
 *            monthly   = MOR * requests-per-MOR bracket (rises with stake)
 *            daily     = 5% of monthly
 *
 * Brackets (requests per MOR per month):
 *   < 100 MOR   -> free volume caps (2,000/day, 40,000/month)
 *   >= 100 MOR  -> 1,000
 *   >= 500 MOR  -> 1,500
 *   >= 2,500    -> 2,000
 *   >= 10,000   -> 2,500
 *
 * Wallet identities are api_keys rows with id `wallet:<lowercased address>`.
 * Caps are written onto the row (rate_limit = burst, daily_cap, monthly_cap)
 * on wallet verify and re-checked by the minute cron, so a stake change lands
 * within a minute or two.
 */

import {
	getBuilderStakeDeposit,
	listWalletKeysWithStakes,
	updateApiKeyCapsStmt,
} from "../db/auth";
import type { Env } from "../types";

/** The MorScan builder subnet on Base. Stake here for capacity (see /stake). */
export const MORSCAN_SUBNET_ID =
	"0xe100f9d7c463008e46887113fa14bc0ba9caaf90d4465835795f53ebe5056059";

export interface Caps {
	burst: number; // requests per minute
	daily: number; // requests per UTC day
	monthly: number; // requests per UTC calendar month
}

/** Connected-wallet bottom tier (unstaked). */
export const CONNECTED_CAPS: Caps = { burst: 60, daily: 2000, monthly: 40000 };

/** Burst scaling: requests/min per MOR staked. */
export const BURST_PER_MOR = 3;

/** Burst ceiling: staked burst never exceeds this many requests/min. */
export const BURST_MAX = 10000;

/** The daily volume cap is this fraction of the monthly cap. */
export const DAILY_FRACTION_OF_MONTHLY = 0.05;

/** Free volume defaults, used when a key row has NULL daily/monthly caps. */
export const FREE_VOLUME: { daily: number; monthly: number } = {
	daily: 2000,
	monthly: 40000,
};

/** Map a live MOR stake to capacity caps. */
export function capsForStake(mor: number): Caps {
	const m = Number.isFinite(mor) && mor > 0 ? mor : 0;
	if (m <= 0) return { ...CONNECTED_CAPS };
	// Floor at the connected tier so a small stake can never LOWER your burst.
	const burst = Math.max(
		CONNECTED_CAPS.burst,
		Math.min(BURST_MAX, Math.floor(BURST_PER_MOR * m)),
	);
	if (m < 100) return { burst, daily: FREE_VOLUME.daily, monthly: FREE_VOLUME.monthly };
	const perMor = m >= 10000 ? 2500 : m >= 2500 ? 2000 : m >= 500 ? 1500 : 1000;
	const monthly = Math.floor(m * perMor);
	const daily = Math.floor(monthly * DAILY_FRACTION_OF_MONTHLY);
	return { burst, daily, monthly };
}

/** Live MOR staked by `wallet` on the MorScan subnet (0 when absent). */
export async function stakeMorFor(env: Env, wallet: string): Promise<number> {
	const row = await getBuilderStakeDeposit(
		env.DB,
		MORSCAN_SUBNET_ID,
		wallet.toLowerCase(),
	).catch(() => null);
	return weiToMor(row?.deposited);
}

function weiToMor(wei: string | null | undefined): number {
	// Amounts in builder_stakes are wei-like decimal strings (see builder-shared.ts).
	try {
		return Number(BigInt(wei || "0")) / 1e18;
	} catch {
		return 0;
	}
}

/**
 * Minute-cron sweep: one cheap join from wallet-identity key rows to
 * builder_stakes (the address is the key id after the `wallet:` prefix),
 * recompute caps, UPDATE only the rows whose caps actually changed (and log
 * each change).
 */
export async function refreshWalletCaps(env: Env): Promise<void> {
	const rows = await listWalletKeysWithStakes(env.DB, MORSCAN_SUBNET_ID);

	const updates: D1PreparedStatement[] = [];
	for (const r of rows) {
		const stakeMor = weiToMor(r.deposited);
		const caps = capsForStake(stakeMor);
		if (
			r.rate_limit !== caps.burst ||
			r.daily_cap !== caps.daily ||
			r.monthly_cap !== caps.monthly
		) {
			console.log(
				JSON.stringify({
					t: "caps_change",
					keyId: r.id,
					stakeMor,
					from: { burst: r.rate_limit, daily: r.daily_cap, monthly: r.monthly_cap },
					to: caps,
				}),
			);
			updates.push(
				updateApiKeyCapsStmt(env.DB, caps.burst, caps.daily, caps.monthly, r.id),
			);
		}
	}
	if (updates.length) await env.DB.batch(updates);
}
