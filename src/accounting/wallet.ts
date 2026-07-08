/**
 * Wallet accounting aggregator - split out of accounting.ts to keep both files
 * within the per-file size budget. Re-exported from accounting.ts so the
 * dynamic imports in handlers resolve unchanged.
 */

import type { Env } from "../types";
import { getWalletBalances, getUserStakesOnHold } from "../utils/rpc";
import { SELECTORS, ethCallBatch, parseSessionResult } from "../sync/parsers";
import { type WalletAccounting, toClassified, weiToMor } from "./index";
import { listSessionsByWallet, fixStaleClosedSessionStmt } from "../db/explorer-sessions";
import { getSyncStateValue } from "../db/ops";

export async function buildWalletAccounting(
	env: Env,
	wallet: string,
): Promise<WalletAccounting> {
	const w = wallet.toLowerCase();
	const now = Math.floor(Date.now() / 1000);

	const [allSessions, balances, stakesOnHold, syncRow] = await Promise.all([
		listSessionsByWallet(env.DB, w),
		getWalletBalances(env, w),
		getUserStakesOnHold(env, w),
		getSyncStateValue(env.DB, "last_block"),
	]);

	const asOfBlock = syncRow ? parseInt(syncRow.value, 10) : 0;
	const sessions = allSessions.map((r) => toClassified(r, now));

	// Chain-verify expired_open sessions. D1 may have stale rows (e.g. from
	// cursor resets that skipped SessionClosed events). A batch getSession()
	// call catches these before we count them as reclaimable.
	const expiredIds = sessions.filter((s) => s.state === "expired_open").map((s) => s.id);
	let partial = false;
	let partialReason: string | null = null;
	let staleFixedCount = 0;

	if (expiredIds.length > 0) {
		const calls = expiredIds.map((id) => {
			const idHex = id.startsWith("0x") ? id.slice(2) : id;
			return `${SELECTORS.getSession}${idHex.padStart(64, "0")}`;
		});

		try {
			const results = await ethCallBatch(env, calls);
			for (let i = 0; i < results.length; i++) {
				const parsed = parseSessionResult(results[i]);
				if (parsed && parsed.closedAt > 0) {
					const session = sessions.find((s) => s.id === expiredIds[i]);
					if (session) {
						session.state = "closed";
						session.closed_at = parsed.closedAt;
						session.is_active = 0;
						staleFixedCount++;
						// Fix D1 so future reads don't need chain verification
						fixStaleClosedSessionStmt(
							env.DB,
							parsed.closedAt,
							parsed.closeoutType,
							session.id,
						)
							.run()
							.catch(() => {});
					}
				} else if (!parsed) {
					const session = sessions.find((s) => s.id === expiredIds[i]);
					if (session) {
						session.state = "unknown_partial";
						partial = true;
						partialReason = `Chain verification failed for session ${session.id.slice(0, 12)}`;
					}
				}
			}
		} catch (e) {
			partial = true;
			partialReason = `Chain verification failed for ${expiredIds.length} expired sessions: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	if (staleFixedCount > 0) {
		console.log(
			`[accounting] Fixed ${staleFixedCount} stale D1 rows (were expired_open, chain says closed)`,
		);
	}

	let stakedWei = 0n;
	let reclaimableWei = 0n;
	let lockedWei = 0n;

	const counts = {
		active_open: 0,
		expired_open: 0,
		closed: 0,
		hold_locked: 0,
		hold_withdrawable: 0,
		unknown_partial: 0,
		total: sessions.length,
	};

	for (const s of sessions) {
		const stake = BigInt(s.stake || "0");
		counts[s.state]++;

		switch (s.state) {
			case "active_open":
				stakedWei += stake;
				break;
			case "expired_open":
				reclaimableWei += stake;
				break;
			case "hold_locked":
				lockedWei += stake;
				break;
			case "hold_withdrawable":
				break;
			case "closed":
				break;
			case "unknown_partial":
				lockedWei += stake;
				partial = true;
				if (!partialReason)
					partialReason = "Session state could not be determined from projected data";
				break;
		}
	}

	const walletWei = BigInt(balances.morBalance || "0");
	const totalWei = walletWei + stakedWei + reclaimableWei + lockedWei;

	return {
		wallet: w,
		wallet_mor: weiToMor(walletWei),
		wallet_mor_wei: walletWei.toString(),
		staked_mor: weiToMor(stakedWei),
		staked_mor_wei: stakedWei.toString(),
		reclaimable_mor: weiToMor(reclaimableWei),
		reclaimable_mor_wei: reclaimableWei.toString(),
		locked_mor: weiToMor(lockedWei),
		locked_mor_wei: lockedWei.toString(),
		total_mor: weiToMor(totalWei),
		total_mor_wei: totalWei.toString(),
		eth_balance: balances.ethBalanceFormatted,
		eth_balance_wei: balances.ethBalance,
		stakes_on_hold: {
			available: stakesOnHold.availableFormatted,
			available_wei: stakesOnHold.available,
			on_hold: stakesOnHold.onHoldFormatted,
			on_hold_wei: stakesOnHold.onHold,
		},
		sessions,
		counts,
		as_of_block: asOfBlock,
		partial,
		partial_reason: partialReason,
	};
}
