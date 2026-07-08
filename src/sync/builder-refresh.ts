/**
 * Builder subnet on-chain refresher.
 *
 * Refreshes deposited/rewards/metadata/admin for all known subnets via batched
 * eth_calls. Never deletes subnet rows - on-chain events are the source of
 * truth for subnet existence.
 */

import type { Env } from "../types";
import { RPC_ENDPOINTS } from "./parsers";
import {
	BUILDER_SELECTORS,
	parseSubnetsData,
	parseSubnetMetadata,
	parseSubnetStruct,
	padBytes32,
} from "./builder-parsers";
import {
	getAllSubnetAdmins,
	updateSubnetDataMetaAdminStmt,
	updateSubnetDataMetaStmt,
	updateSubnetDataAdminStmt,
	updateSubnetDataStmt,
} from "../db/sync-builder";

/**
 * Refresh on-chain data for all known subnets.
 *
 * Subnets are discovered via SubnetCreated events (event sync layer). This only
 * refreshes their deposited/rewards/metadata/admin from subnetsData().
 */
export async function refreshSubnetData(env: Env): Promise<void> {
	if (!env.BUILDER_CONTRACT) return;

	const rows = await getAllSubnetAdmins(env.DB);
	if (!rows.length) {
		console.log("[syncBuilder] No subnets in DB - nothing to refresh");
		return;
	}

	console.log(`[syncBuilder] Refreshing on-chain data for ${rows.length} subnets`);

	const now = Math.floor(Date.now() / 1000);
	const subnetIds = rows.map((r) => r.subnet_id);
	const needsAdmin = new Set(rows.filter((r) => !r.admin).map((r) => r.subnet_id));
	const endpoints = [...RPC_ENDPOINTS, env.RPC_URL, env.ALCHEMY_FALLBACK_URL].filter(
		Boolean,
	) as string[];

	// 3 calls per subnet: data, metadata, struct (admin) - keep batch manageable.
	const CHUNK = 8;
	const allStmts: D1PreparedStatement[] = [];

	for (let i = 0; i < subnetIds.length; i += CHUNK) {
		const chunk = subnetIds.slice(i, i + CHUNK);
		let nextId = 0;

		const dataIds: number[] = [];
		const dataCalls = chunk.map((id) => {
			const callId = nextId++;
			dataIds.push(callId);
			return {
				jsonrpc: "2.0",
				method: "eth_call",
				id: callId,
				params: [
					{
						to: env.BUILDER_CONTRACT,
						data: `${BUILDER_SELECTORS.subnetsData}${padBytes32(id)}`,
					},
					"latest",
				],
			};
		});
		const metaIds: number[] = [];
		const metaCalls = chunk.map((id) => {
			const callId = nextId++;
			metaIds.push(callId);
			return {
				jsonrpc: "2.0",
				method: "eth_call",
				id: callId,
				params: [
					{
						to: env.BUILDER_CONTRACT,
						data: `${BUILDER_SELECTORS.subnetsMetadata}${padBytes32(id)}`,
					},
					"latest",
				],
			};
		});
		const structIds: number[] = [];
		const structCalls: Array<Record<string, unknown>> = [];
		chunk.forEach((id) => {
			if (needsAdmin.has(id)) {
				const callId = nextId++;
				structIds.push(callId);
				structCalls.push({
					jsonrpc: "2.0",
					method: "eth_call",
					id: callId,
					params: [
						{
							to: env.BUILDER_CONTRACT,
							data: `${BUILDER_SELECTORS.subnets}${padBytes32(id)}`,
						},
						"latest",
					],
				});
			} else {
				structIds.push(-1); // no call needed
			}
		});

		const batchCalls = [...dataCalls, ...metaCalls, ...structCalls];
		let batchResults: Array<{ id: number; result?: string }> | null = null;
		for (const rpc of endpoints) {
			try {
				const resp = await fetch(rpc, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(batchCalls),
					signal: AbortSignal.timeout(15000),
				});
				if (!resp.ok) continue;
				batchResults = (await resp.json()) as Array<{ id: number; result?: string }>;
				break;
			} catch {}
		}
		if (!batchResults) continue;

		const resultMap = new Map<number, string>();
		for (const r of batchResults) {
			if (r.result) resultMap.set(r.id, r.result);
		}

		for (let j = 0; j < chunk.length; j++) {
			const id = chunk[j];
			const data = parseSubnetsData(resultMap.get(dataIds[j]) || "0x");
			const meta = parseSubnetMetadata(resultMap.get(metaIds[j]) || "0x");

			let adminUpdate = "";
			let claimAdminUpdate = "";
			let nameUpdate = "";
			let minDepUpdate = "";
			let lockUpdate = 0;
			if (structIds[j] >= 0) {
				const subnet = parseSubnetStruct(resultMap.get(structIds[j]) || "0x");
				if (subnet) {
					adminUpdate = subnet.admin;
					claimAdminUpdate = subnet.claimAdmin;
					if (subnet.name) nameUpdate = subnet.name;
					minDepUpdate = subnet.minimalDeposit;
					lockUpdate = subnet.withdrawLockPeriod;
				}
			}

			const hasMeta = meta.name || meta.description || meta.url || meta.logo;
			const hasAdmin = adminUpdate !== "";

			const base = {
				totalStaked: data.totalStaked,
				pendingRewards: data.pendingRewards,
				updatedAt: now,
				subnetId: id,
			};
			const metaFields = {
				metadataName: meta.name,
				metadataDescription: meta.description,
				metadataUrl: meta.url,
				metadataLogo: meta.logo,
			};
			const adminFields = {
				admin: adminUpdate,
				claimAdmin: claimAdminUpdate,
				name: nameUpdate,
				minimalDeposit: minDepUpdate,
				withdrawLockPeriod: lockUpdate,
			};

			if (hasMeta && hasAdmin) {
				allStmts.push(
					updateSubnetDataMetaAdminStmt(env.DB, {
						...base,
						...metaFields,
						...adminFields,
					}),
				);
			} else if (hasMeta) {
				allStmts.push(updateSubnetDataMetaStmt(env.DB, { ...base, ...metaFields }));
			} else if (hasAdmin) {
				allStmts.push(updateSubnetDataAdminStmt(env.DB, { ...base, ...adminFields }));
			} else {
				allStmts.push(updateSubnetDataStmt(env.DB, base));
			}
		}
	}

	for (let j = 0; j < allStmts.length; j += 100) {
		await env.DB.batch(allStmts.slice(j, j + 100));
	}

	console.log(
		`[syncBuilder] Refresh complete - ${subnetIds.length} subnets updated (${needsAdmin.size} admin backfills)`,
	);
}
