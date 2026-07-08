/**
 * Compute Sync - provider + bid + model discovery pass.
 *
 * Extracted from compute-events.ts (2026-06-17) to keep both files under the
 * line budget. Behavior, DB write order, batching (chunks of 100), cache
 * invalidation and console output are byte-for-byte identical to the original.
 */

import type { Env } from "../types";
import {
	SELECTORS,
	parseBidResult,
	parseProviderResult,
	padAddress,
	parseArrayResult,
	parseModelResult,
} from "./parsers";
import { invalidateCfCache } from "../utils/cache";
import { rpcBatch } from "./compute-rpc";
import type { ComputeCtx } from "./compute-events";
import {
	getKnownProviderAddresses,
	getActiveBidCountsByProvider,
	getUnnamedBidModelIds,
	upsertProviderStmt,
	upsertBidStmt,
	upsertModelStmt,
} from "../db/sync";

/**
 * Provider + bid discovery - fetch provider details and active bids from chain.
 * Collects provider addresses from bids + sessions tables, fetches on-chain state,
 * and discovers bids for any provider missing bids in D1. Runs every tick.
 * Returns the number of bids created via discovery (added to the tick's bid count).
 */
export async function processProviderDiscovery(
	env: Env,
	rpcUrl: string,
	alchemy: string | undefined,
	toBlock: number,
	ctx: ComputeCtx,
): Promise<number> {
	let bidsCreated = 0;
	try {
		const bidProviders = await getKnownProviderAddresses(env.DB);
		const provAddresses = bidProviders.map((r) => r.provider).filter(Boolean);
		if (provAddresses.length > 0) {
			// Fetch provider details
			const provCalls = provAddresses.map((addr) => ({
				method: "eth_call",
				params: [
					{ to: env.DIAMOND_ADDRESS, data: SELECTORS.getProvider + padAddress(addr) },
					"latest",
				],
			}));
			const provResults = await rpcBatch(rpcUrl, provCalls, alchemy);
			const provInserts: D1PreparedStatement[] = [];
			for (let i = 0; i < provAddresses.length; i++) {
				const addr = provAddresses[i].toLowerCase();
				const parsed = provResults[i]
					? parseProviderResult(provResults[i] as string, addr)
					: null;
				if (!parsed) continue;
				provInserts.push(
					upsertProviderStmt(
						env.DB,
						addr,
						parsed.endpoint,
						parsed.stake,
						parsed.createdAt,
						toBlock,
					),
				);
			}
			if (provInserts.length > 0) {
				for (let i = 0; i < provInserts.length; i += 100) {
					await env.DB.batch(provInserts.slice(i, i + 100));
				}
				console.log(`[sync] PROVIDERS: ${provInserts.length} upserted`);
			}

			// Discover bids for providers that have 0 bids in D1
			const provBidCounts = await getActiveBidCountsByProvider(env.DB);
			const hasBids = new Set(provBidCounts.map((r) => r.provider));
			const missingBids = provAddresses.filter((a) => !hasBids.has(a.toLowerCase()));
			if (missingBids.length > 0) {
				// Fetch active bids for providers with no bids in D1
				const ZERO_OFFSET = "0".repeat(64);
				const LIMIT_100 = "64".padStart(64, "0"); // 100 in hex
				const bidListCalls = missingBids.map((addr) => ({
					method: "eth_call",
					params: [
						{
							to: env.DIAMOND_ADDRESS,
							data:
								SELECTORS.getProviderActiveBids +
								padAddress(addr) +
								ZERO_OFFSET +
								LIMIT_100,
						},
						"latest",
					],
				}));
				const bidListResults = await rpcBatch(rpcUrl, bidListCalls, alchemy);
				const allBidIds: string[] = [];
				for (let i = 0; i < missingBids.length; i++) {
					const bidIds = bidListResults[i]
						? parseArrayResult(bidListResults[i] as string)
						: [];
					allBidIds.push(...bidIds);
				}
				if (allBidIds.length > 0) {
					const bidDetailCalls = allBidIds.map((id) => ({
						method: "eth_call",
						params: [
							{
								to: env.DIAMOND_ADDRESS,
								data: SELECTORS.getBid + id.replace("0x", "").padStart(64, "0"),
							},
							"latest",
						],
					}));
					const bidDetailResults = await rpcBatch(rpcUrl, bidDetailCalls, alchemy);
					const bidInserts: D1PreparedStatement[] = [];
					for (let i = 0; i < allBidIds.length; i++) {
						const bid = bidDetailResults[i]
							? parseBidResult(bidDetailResults[i] as string)
							: null;
						if (!bid) continue;
						const bidId = allBidIds[i].toLowerCase();
						bidInserts.push(
							upsertBidStmt(
								env.DB,
								bidId,
								bid.provider.toLowerCase(),
								bid.modelId.toLowerCase(),
								bid.pricePerSecond,
								bid.nonce,
								bid.createdAt,
								bid.deletedAt,
								toBlock,
							),
						);
						bidsCreated++;
					}
					if (bidInserts.length > 0) {
						await env.DB.batch(bidInserts);
						console.log(
							`[sync] BID DISCOVERY: ${bidInserts.length} bids for ${missingBids.length} providers`,
						);
						// Resolve model names - collect model IDs from successful bid parses
						const discoveredModelIds = new Set<string>();
						for (let k = 0; k < allBidIds.length; k++) {
							const bid = bidDetailResults[k]
								? parseBidResult(bidDetailResults[k] as string)
								: null;
							if (bid?.modelId) discoveredModelIds.add(bid.modelId.toLowerCase());
						}
						const modelIdsToResolve = [...discoveredModelIds];
						if (modelIdsToResolve.length > 0) {
							const modelCalls = modelIdsToResolve.map((id) => ({
								method: "eth_call",
								params: [
									{
										to: env.DIAMOND_ADDRESS,
										data: SELECTORS.getModel + id.replace("0x", "").padStart(64, "0"),
									},
									"latest",
								],
							}));
							const modelResults = await rpcBatch(rpcUrl, modelCalls, alchemy);
							const modelInserts: D1PreparedStatement[] = [];
							for (let j = 0; j < modelIdsToResolve.length; j++) {
								const model = modelResults[j]
									? parseModelResult(modelResults[j] as string)
									: null;
								if (!model) continue;
								modelInserts.push(
									upsertModelStmt(
										env.DB,
										modelIdsToResolve[j],
										model.name,
										model.tags.join(","),
										toBlock,
									),
								);
							}
							if (modelInserts.length > 0) {
								await env.DB.batch(modelInserts);
								console.log(
									`[sync] MODEL DISCOVERY: ${modelInserts.length} model names resolved`,
								);
							}
						}
					}
				}
			}
		}

		// Resolve model names for any bids missing model names
		const unnamedModels = await getUnnamedBidModelIds(env.DB);
		const unnamed = unnamedModels.map((r) => r.model_id).filter(Boolean);
		if (unnamed.length > 0) {
			const modelCalls = unnamed.map((id) => ({
				method: "eth_call",
				params: [
					{
						to: env.DIAMOND_ADDRESS,
						data: SELECTORS.getModel + id.replace("0x", "").padStart(64, "0"),
					},
					"latest",
				],
			}));
			const modelResults = await rpcBatch(rpcUrl, modelCalls, alchemy);
			const modelInserts: D1PreparedStatement[] = [];
			for (let j = 0; j < unnamed.length; j++) {
				const model = modelResults[j]
					? parseModelResult(modelResults[j] as string)
					: null;
				if (!model) continue;
				modelInserts.push(
					upsertModelStmt(env.DB, unnamed[j], model.name, model.tags.join(","), toBlock),
				);
			}
			if (modelInserts.length > 0) {
				await env.DB.batch(modelInserts);
				console.log(`[sync] MODEL NAMES: ${modelInserts.length} resolved`);
			}
		}
		// Bust CF Cache for all provider detail pages + global endpoints
		const cacheKeys = provAddresses.map((a) => `v1:providers:${a.toLowerCase()}`);
		cacheKeys.push("v1:providers", "v1:bids", "v1:models:demand", "v1:reputation");
		await invalidateCfCache(cacheKeys);
	} catch (e) {
		ctx.errors.push(`Provider discovery: ${e instanceof Error ? e.message : e}`);
	}
	return bidsCreated;
}
