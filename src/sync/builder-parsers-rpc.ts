/**
 * Builder Staking RPC - selectors + eth_call against the BuildersV4 contract.
 *
 * Selectors computed via keccak256, confirmed against on-chain tx 0x3b71...bfd3.
 */

import type { Env } from "../types";
import { RPC_ENDPOINTS, type RpcResponse } from "./parsers";

// BuildersV4 function selectors
export const BUILDER_SELECTORS = {
	subnets: "0x02e30f9a",
	subnetsData: "0xfc601bd7",
	usersData: "0x996cb7c3",
	allSubnetsData: "0x2b929f36",
	allSubnetsDataV4: "0x9155756f",
	getCurrentSubnetsRewards: "0x29c1746c",
	getCurrentSubnetRewards: "0xd3668d59",
	getSubnetId: "0xe1324916",
	minimalWithdrawLockPeriod: "0xc7a74add",
	version: "0x54fd4d50",
	subnetsMetadata: "0x4058218f",
};

/** eth_call targeting the Builder contract (not Diamond) */
export async function ethCallBuilder(env: Env, data: string): Promise<string> {
	const contract = env.BUILDER_CONTRACT;
	if (!contract) throw new Error("BUILDER_CONTRACT not configured");

	const endpoints = [env.RPC_URL, ...RPC_ENDPOINTS];
	for (const rpc of endpoints) {
		try {
			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "eth_call",
					id: 1,
					params: [{ to: contract, data }, "latest"],
				}),
			});
			const result = (await resp.json()) as RpcResponse;
			if (result.error) {
				console.error(`[builderRPC] ${rpc} error:`, result.error);
				continue;
			}
			if (result.result) return result.result;
		} catch (e) {
			console.error(`[builderRPC] ${rpc} fetch error:`, e);
		}
	}
	throw new Error("All RPCs failed for builder contract");
}
