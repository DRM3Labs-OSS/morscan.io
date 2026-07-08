/**
 * Analytics - gas-cost backfill + per-wallet gas estimation.
 */

import { type Env, EVENTS } from "../types";
import { getCurrentBlock } from "../utils/rpc";
import {
	countWalletSessionOpens,
	selectAvgGasPerTx,
	selectTxBackfillBlock,
	selectWalletGasStats,
	selectWalletSessionDurationStats,
	updateSessionCloseTxHash,
	updateSessionOpenTxHash,
	upsertTxBackfillBlock,
} from "../db/explorer-core";

/**
 * Backfill tx hashes for historical sessions by scanning events.
 * Call /sync/backfill-tx to run. Processes ~5000 blocks per call.
 */
export async function backfillTxHashes(
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	const stateRow = await selectTxBackfillBlock(env.DB);

	const diamondAddress = env.DIAMOND_ADDRESS;
	const SESSION_OPENED = EVENTS.SESSION_OPENED;
	const SESSION_CLOSED = EVENTS.SESSION_CLOSED;

	const currentBlock = await getCurrentBlock(env);
	const startBlock = stateRow ? parseInt(stateRow.value, 10) : currentBlock - 30000;
	const endBlock = Math.min(startBlock + 5000, currentBlock);

	let updated = 0;

	// Use publicnode - llamarpc silently returns empty on large ranges.
	const backfillRpc = "https://base-rpc.publicnode.com";
	try {
		const openResp = await fetch(backfillRpc, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "eth_getLogs",
				params: [
					{
						address: diamondAddress,
						topics: [SESSION_OPENED],
						fromBlock: `0x${startBlock.toString(16)}`,
						toBlock: `0x${endBlock.toString(16)}`,
					},
				],
			}),
		});
		const openData = (await openResp.json()) as {
			result?: Array<{ topics: string[]; transactionHash: string }>;
		};
		if (openData.result) {
			for (const log of openData.result) {
				await updateSessionOpenTxHash(env.DB, log.transactionHash, log.topics[2]);
				updated++;
			}
		}

		const closeResp = await fetch(backfillRpc, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "eth_getLogs",
				params: [
					{
						address: diamondAddress,
						topics: [SESSION_CLOSED],
						fromBlock: `0x${startBlock.toString(16)}`,
						toBlock: `0x${endBlock.toString(16)}`,
					},
				],
			}),
		});
		const closeData = (await closeResp.json()) as {
			result?: Array<{ topics: string[]; transactionHash: string }>;
		};
		if (closeData.result) {
			for (const log of closeData.result) {
				await updateSessionCloseTxHash(env.DB, log.transactionHash, log.topics[2]);
				updated++;
			}
		}
	} catch (e) {
		console.error("Backfill error:", e);
	}

	await upsertTxBackfillBlock(env.DB, String(endBlock));

	return new Response(
		JSON.stringify({
			fromBlock: startBlock,
			toBlock: endBlock,
			currentBlock,
			txHashesUpdated: updated,
			remaining: currentBlock - endBlock,
			pctComplete: (((endBlock - (currentBlock - 130000)) / 130000) * 100).toFixed(1),
		}),
		{ headers },
	);
}

/**
 * GET /mor/v1/wallet/:wallet/gas - Per-wallet gas cost estimation.
 *
 * Each session lifecycle ≈ 3 on-chain transactions (open + close + restake).
 * Most sessions expire without a close event, so we estimate totalTx = opens × 3.
 */
export async function handleWalletGas(
	env: Env,
	wallet: string,
	headers: Record<string, string>,
): Promise<Response> {
	const walletLower = wallet.toLowerCase();

	const [sessionCount, walletGas, avgGas] = await Promise.all([
		countWalletSessionOpens(env.DB, walletLower),
		selectWalletGasStats(env.DB, walletLower),
		selectAvgGasPerTx(env.DB),
	]);

	const opens = sessionCount?.opens || 0;
	const estimatedTx = opens * 3;
	const avgEthPerTx = walletGas?.avg_eth || avgGas?.avg_eth || 0.0000036;
	const estimatedTotalEth = estimatedTx * avgEthPerTx;
	const actualTotalEth = walletGas?.total_eth || 0;
	const actualReceipts = walletGas?.receipts || 0;

	const durationStats = await selectWalletSessionDurationStats(env.DB, walletLower);

	const avgDurationMins = durationStats?.avg_duration_secs
		? Math.round(durationStats.avg_duration_secs / 60)
		: 0;
	const restakesPerDay = durationStats?.avg_duration_secs
		? Math.round((86400 / durationStats.avg_duration_secs) * 10) / 10
		: 0;
	const dailyGasEth = restakesPerDay * 3 * avgEthPerTx;

	return new Response(
		JSON.stringify({
			wallet: walletLower,
			sessionOpens: opens,
			estimatedTransactions: estimatedTx,
			estimatedTotalEth: parseFloat(estimatedTotalEth.toFixed(8)),
			actual: {
				receipts: actualReceipts,
				totalEth: parseFloat(actualTotalEth.toFixed(8)),
			},
			avgEthPerTx: parseFloat(avgEthPerTx.toFixed(8)),
			session: {
				avgDurationMins,
				restakesPerDay,
				estimatedDailyGasEth: parseFloat(dailyGasEth.toFixed(8)),
			},
			note: "Estimated from sessionOpens × 3 (open + close + restake per cycle). Actual receipts available where tx hashes are backfilled.",
		}),
		{ headers },
	);
}
