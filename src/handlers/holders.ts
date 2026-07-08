/**
 * MOR Token Holders - ranked by balance
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { getSyncState, buildMeta } from "../utils/rpc";
import { signResponse } from "../utils/provenance";
import { readHolderCoverage, formatEta } from "../sync/holder-coverage";
import {
	countDiscoveredHolders,
	countDustHolders,
	selectDustHolders,
	selectHolderCounts,
	selectRankedHolders,
} from "../db/explorer-core";

export async function handleHolders(env: Env, headers: Record<string, string>, url: URL) {
	try {
		const { lastBlock, currentBlock, lastSyncTs } = await getSyncState(env);

		// Hard caps, server-enforced: max 100 rows per page, max page depth 1000.
		const page = Math.min(
			1000,
			Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1),
		);
		const limit = Math.min(
			100,
			Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100),
		);
		const offset = (page - 1) * limit;

		// Basescan-honest holder = any wallet with a positive MOR balance. We only
		// count wallets whose balance has actually been computed (updated_at > 0);
		// a newly discovered wallet whose balanceOf has not been refreshed yet is
		// NOT counted as a fake zero. Dust threshold = 0.01 MOR.
		const MIN_WEI = "10000000000000000"; // 0.01 MOR
		const counts = await selectHolderCounts(env.DB, MIN_WEI);

		// Balance-desc, wallet-asc tiebreak = a single stable global order, so
		// pagination slices never overlap or reorder across pages.
		const holdersResult = await selectRankedHolders(env.DB, limit, offset);

		const total = counts?.with_balance || 0;
		const meaningful = counts?.meaningful || 0;
		const dust = counts?.dust || 0;
		const holders = holdersResult.map((h: Record<string, unknown>, i: number) => {
			const morWei = BigInt((h.mor_balance_wei as string) || "0");
			const ethWei = BigInt((h.eth_balance_wei as string) || "0");
			return {
				// Continuous global rank across pages: offset by page, so page 2 starts
				// at limit+1 (not 1 again). Immune to any client-side re-sort.
				rank: offset + i + 1,
				wallet: h.wallet,
				morBalance: (Number(morWei) / 1e18).toFixed(2),
				morBalanceWei: h.mor_balance_wei,
				ethBalance: (Number(ethWei) / 1e18).toFixed(4),
				hasSessions: h.has_sessions === 1,
				isProvider: h.is_provider === 1,
				isConsumer: h.is_consumer === 1,
				isStaker: h.is_staker === 1,
				lastTransferBlock: h.last_transfer_block,
				updatedAt: h.updated_at,
			};
		});

		const totalDiscovered = await countDiscoveredHolders(env.DB);
		const cov = await readHolderCoverage(env, currentBlock || lastBlock);

		const responseData: Record<string, unknown> = {
			...buildMeta(lastBlock, currentBlock, undefined, lastSyncTs),
			total, // Basescan-honest: wallets with balance > 0
			meaningfulHolders: meaningful, // balance >= 0.01 MOR
			dustHolders: dust, // 0 < balance < 0.01 MOR
			totalDiscovered: totalDiscovered?.cnt || 0,
			basescanReference: 14548, // Basescan MOR holder count at time of writing (target)
			// Honest coverage: we are re-scanning MOR history from the token deploy
			// block. Until this reaches ~100% the count above is still climbing.
			coverage: {
				indexing: !cov.complete,
				fromBlock: cov.fromBlock,
				scannedTo: cov.scannedTo,
				headBlock: cov.headBlock,
				pct: cov.pct,
				blocksRemaining: cov.blocksRemaining,
				blocksPerSec: cov.blocksPerSec,
				etaSeconds: cov.etaSeconds,
				eta: formatEta(cov.etaSeconds),
			},
			backfill: {
				// legacy shape kept for existing consumers
				scannedBlock: cov.scannedTo,
				targetBlock: cov.headBlock,
				done: cov.complete,
				pct: Math.round(cov.pct),
			},
			holders,
			pagination: {
				page,
				limit,
				offset,
				totalPages: Math.ceil(total / limit),
			},
		};

		const mnemonic = signingMnemonic(env);
		if (mnemonic) {
			const receipt = await signResponse(
				"blockchain.holders",
				{ endpoint: "/mor/v1/holders", syncedBlock: lastBlock, page, limit },
				{ total, totalDiscovered: totalDiscovered?.cnt || 0, returned: holders.length },
				mnemonic,
				env.DB,
			);
			if (receipt) responseData._provenance_aggregate = JSON.parse(receipt);
		}

		return new Response(JSON.stringify(responseData), { headers });
	} catch (e) {
		console.error("[handleHolders] Error:", e);
		return new Response(
			JSON.stringify({
				total: 0,
				holders: [],
				message: "MOR holders data is being indexed. Check back in a few minutes.",
				pagination: { page: 1, limit: 100, totalPages: 0 },
			}),
			{ headers },
		);
	}
}

/**
 * Dust wallets - balance > 0 but < 0.01 MOR, plus former holders (balance = 0 but updated).
 * Strictly below the threshold: a wallet at exactly 0.01 MOR is meaningful (>= MIN_WEI
 * on the main holders page) and never appears here too.
 */
const MIN_WEI_DUST = "10000000000000000"; // 0.01 MOR

export async function handleDustHolders(
	env: Env,
	headers: Record<string, string>,
	url: URL,
) {
	try {
		const { lastBlock, currentBlock, lastSyncTs } = await getSyncState(env);

		// Hard caps, server-enforced: max 100 rows per page, max page depth 1000.
		const page = Math.min(
			1000,
			Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1),
		);
		const limit = Math.min(
			100,
			Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100),
		);
		const offset = (page - 1) * limit;

		// Previous holders: dust balance AND no network participation
		const countResult = await countDustHolders(env.DB, MIN_WEI_DUST);

		const holdersResult = await selectDustHolders(env.DB, MIN_WEI_DUST, limit, offset);

		const total = countResult?.cnt || 0;
		const holders = holdersResult.map((h: Record<string, unknown>, i: number) => {
			return {
				rank: offset + i + 1, // continuous across pages
				wallet: h.wallet,
				morBalanceWei: h.mor_balance_wei,
				lastTransferBlock: h.last_transfer_block,
				updatedAt: h.updated_at,
			};
		});

		const responseData: Record<string, unknown> = {
			...buildMeta(lastBlock, currentBlock, undefined, lastSyncTs),
			total,
			holders,
			pagination: { page, limit, totalPages: Math.ceil(total / limit) },
		};

		const mnemonic = signingMnemonic(env);
		if (mnemonic) {
			const receipt = await signResponse(
				"blockchain.holders.dust",
				{ endpoint: "/mor/v1/holders/dust", syncedBlock: lastBlock, page, limit },
				{ total, returned: holders.length },
				mnemonic,
				env.DB,
			);
			if (receipt) responseData._provenance_aggregate = JSON.parse(receipt);
		}

		return new Response(JSON.stringify(responseData), { headers });
	} catch (e) {
		console.error("[handleDustHolders] Error:", e);
		return new Response(
			JSON.stringify({
				total: 0,
				holders: [],
				pagination: { page: 1, limit: 100, totalPages: 0 },
			}),
			{ headers },
		);
	}
}
