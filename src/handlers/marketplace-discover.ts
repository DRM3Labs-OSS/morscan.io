/**
 * Marketplace - historical/retracted bid discovery.
 *
 * Sessions reference bidIds; some of those bids are now retracted and gone from
 * the live bid set. This backfills them from chain via getBid.
 */

import type { Env } from "../types";
import { getSyncState, buildMeta } from "../utils/rpc";
import { RPC_ENDPOINTS } from "../sync/parsers";
import { getMissingSessionBids, upsertDiscoveredBid } from "../db/explorer-market";

export async function discoverHistoricalBids(env: Env, headers: Record<string, string>) {
	const { lastBlock, currentBlock } = await getSyncState(env);

	const missingBids = await getMissingSessionBids(env.DB);

	if (missingBids.length === 0) {
		return new Response(
			JSON.stringify({
				...buildMeta(lastBlock, currentBlock),
				message: "No missing bids to discover",
				discovered: 0,
			}),
			{ headers },
		);
	}

	const DIAMOND = env.DIAMOND_ADDRESS;
	const GET_BID_SELECTOR = "0x91704e1e";
	let discovered = 0;
	const retractedBids: Record<string, unknown>[] = [];

	for (const row of missingBids as Record<string, unknown>[]) {
		const bidId = row.bid_id as string;

		for (const rpc of RPC_ENDPOINTS) {
			try {
				const resp = await fetch(rpc, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						jsonrpc: "2.0",
						method: "eth_call",
						id: 1,
						params: [
							{
								to: DIAMOND,
								data: GET_BID_SELECTOR + bidId.replace("0x", "").padStart(64, "0"),
							},
							"latest",
						],
					}),
				});

				const data = (await resp.json()) as Record<string, unknown>;
				if (!data.result || data.result === "0x" || (data.result as string).length < 386)
					continue;

				const result = data.result as string;
				const bidProvider = `0x${result.slice(26, 66)}`.toLowerCase();
				const modelId = `0x${result.slice(66, 130)}`.toLowerCase();
				const pricePerSecond = BigInt(`0x${result.slice(130, 194)}`).toString();
				const nonce = parseInt(result.slice(194, 258), 16);
				const createdAt = parseInt(result.slice(258, 322), 16);
				const deletedAt = parseInt(result.slice(322, 386), 16);

				await upsertDiscoveredBid(
					env.DB,
					bidId.toLowerCase(),
					bidProvider,
					modelId,
					pricePerSecond,
					nonce,
					createdAt,
					deletedAt,
					currentBlock,
				);

				discovered++;
				if (deletedAt > 0)
					retractedBids.push({ bidId, provider: bidProvider, modelId, deletedAt });
				break;
			} catch (_e) {
				/* try next RPC endpoint */
			}
		}
	}

	return new Response(
		JSON.stringify({
			...buildMeta(lastBlock, currentBlock),
			message: `Discovered ${discovered} historical bids`,
			discovered,
			retractedBids,
		}),
		{ headers },
	);
}
