/**
 * Marketplace Handlers - Providers & Bids.
 *
 * The full-marketplace rollup lives in marketplace-all.ts; bid discovery lives
 * in marketplace-discover.ts. Both are re-exported here so existing imports
 * (`from '../handlers/marketplace'`) keep working.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { getSyncState, buildMeta } from "../utils/rpc";
import { signResponse, signBatchResponse } from "../utils/provenance";
import { getAllProviders, getAllBidsWithModels } from "../db/explorer-market";

export { handleAll } from "./marketplace-all";
export { discoverHistoricalBids } from "./marketplace-discover";

export async function handleProviders(env: Env, headers: Record<string, string>) {
	const { lastBlock, currentBlock } = await getSyncState(env);
	const result = await getAllProviders(env.DB);

	const providers: Record<string, unknown>[] = result.map(
		(p: Record<string, unknown>) => ({
			address: p.address,
			endpoint: p.endpoint,
			stake: p.stake,
			updatedBlock: p.updated_block,
		}),
	);

	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock),
		total: providers.length,
		providers,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const batch = signBatchResponse("blockchain.providers", providers, mnemonic);
		if (batch) {
			for (let i = 0; i < providers.length; i++)
				providers[i]._receipt = batch.receiptIds[i];
			responseData._provenance = {
				service: "morscan",
				producer: "morscan/providers",
				receipt_count: batch.receiptIds.length,
				merkle_root: batch.merkleRoot,
			};
		}
		const aggregateReceipt = await signResponse(
			"blockchain.providers",
			{ endpoint: "/mor/v1/providers", syncedBlock: lastBlock },
			{ total: providers.length },
			mnemonic,
			env.DB,
		);
		if (aggregateReceipt)
			responseData._provenance_aggregate = JSON.parse(aggregateReceipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}

export async function handleBids(env: Env, headers: Record<string, string>) {
	const { lastBlock, currentBlock } = await getSyncState(env);
	// Join with models table for human-readable names from on-chain ModelRegistry.
	const result = await getAllBidsWithModels(env.DB);

	const bids: Record<string, unknown>[] = result.map((b: Record<string, unknown>) => {
		const priceWei = BigInt((b.price_per_second as string) || "0");
		const priceMorDay = Number(priceWei * 86400n) / 1e18;
		const tags = b.model_tags ? (b.model_tags as string).split(",") : [];
		return {
			bidId: b.bid_id,
			provider: b.provider,
			modelId: b.model_id,
			model: b.model_name || null,
			tags,
			pricePerSecond: b.price_per_second,
			priceMorPerDay: priceMorDay.toFixed(6),
			priceMorPerWeek: (priceMorDay * 7).toFixed(6),
			updatedBlock: b.updated_block,
		};
	});

	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock),
		total: bids.length,
		bids,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const batch = signBatchResponse("blockchain.bids", bids, mnemonic);
		if (batch) {
			for (let i = 0; i < bids.length; i++) bids[i]._receipt = batch.receiptIds[i];
			responseData._provenance = {
				service: "morscan",
				producer: "morscan/bids",
				receipt_count: batch.receiptIds.length,
				merkle_root: batch.merkleRoot,
			};
		}
		const aggregateReceipt = await signResponse(
			"blockchain.bids",
			{ endpoint: "/mor/v1/bids", syncedBlock: lastBlock },
			{ total: bids.length },
			mnemonic,
			env.DB,
		);
		if (aggregateReceipt)
			responseData._provenance_aggregate = JSON.parse(aggregateReceipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}
