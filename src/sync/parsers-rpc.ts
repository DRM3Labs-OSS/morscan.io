/**
 * Sync RPC Helpers
 *
 * Function selectors, the fallback RPC endpoint pool, and batched eth_call
 * infrastructure with multi-endpoint failover.
 */

import type { Env } from "../types";

// Function selectors (keccak256 of function signature, first 4 bytes)
export const SELECTORS = {
	getActiveProviders: "0xd5472642",
	getProvider: "0x55f21eb7",
	getProviderActiveBids: "0xaf5b77ca",
	getBid: "0x91704e1e",
	getBidId: "0x747ddd5b",
	getProviderSessions: "0x87bced7d",
	getSession: "0x39b240bd",
	getModel: "0x21e7c498",
	getComputeBalance: "0x61ce471a",
	totalMORSupply: "0x6d0cfe5a",
	getTodaysBudget: "0x40005965",
};

// RPC endpoints to try (in order). The pool guards against the silent-stall
// failure mode where every endpoint errors at once: the cursor holds
// correctly but never recovers until an endpoint responds, so breadth is the
// safety net. Endpoints are probed for eth_getLogs support over multi-
// hundred-block ranges (some public RPCs cap at 10 blocks per call, useless
// for catch-up scenarios).
export const RPC_ENDPOINTS = [
	"https://base.llamarpc.com",
	"https://base-rpc.publicnode.com",
	"https://base.drpc.org",
	"https://1rpc.io/base",
	"https://mainnet.base.org",
	"https://base.gateway.tenderly.co",
	"https://base.meowrpc.com",
	"https://base-mainnet.public.blastapi.io",
	"https://base.blockpi.network/v1/rpc/public",
	"https://endpoints.omniatech.io/v1/base/mainnet/public",
	"https://base-pokt.nodies.app",
];

export interface RpcResponse {
	jsonrpc: string;
	id: number;
	result?: string;
	error?: { message: string; code?: number };
}

// Helper to make eth_call with fallback RPCs (free RPCs first, Alchemy last)
export async function ethCall(env: Env, data: string): Promise<string> {
	const endpoints = [...RPC_ENDPOINTS, env.RPC_URL, env.ALCHEMY_FALLBACK_URL].filter(
		Boolean,
	) as string[];

	for (const rpc of endpoints) {
		try {
			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "eth_call",
					id: 1,
					params: [{ to: env.DIAMOND_ADDRESS, data }, "latest"],
				}),
			});
			const result = (await resp.json()) as RpcResponse;

			if (result.error) {
				console.error(`RPC ${rpc} error:`, result.error.message || result.error);
				continue; // Try next RPC
			}

			if (result.result) {
				// success
				return result.result;
			}
		} catch (e) {
			console.error(`RPC ${rpc} fetch error:`, e);
		}
	}

	console.error("All RPCs failed for call:", data.slice(0, 20));
	return "0x";
}

// Batch multiple eth_calls into one HTTP request (free RPCs first, Alchemy last)
export async function ethCallBatch(env: Env, calls: string[]): Promise<string[]> {
	const endpoints = [...RPC_ENDPOINTS, env.RPC_URL, env.ALCHEMY_FALLBACK_URL].filter(
		Boolean,
	) as string[];

	for (const rpc of endpoints) {
		try {
			const batch = calls.map((data, i) => ({
				jsonrpc: "2.0",
				method: "eth_call",
				id: i + 1,
				params: [{ to: env.DIAMOND_ADDRESS, data }, "latest"],
			}));

			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(batch),
			});

			const results = (await resp.json()) as RpcResponse[];

			if (!Array.isArray(results)) {
				console.error(`RPC ${rpc} batch error: not an array`);
				continue;
			}

			// Map-based lookup - no mutation of results array
			const resultMap = new Map<number, string>();
			let hasErrors = false;
			for (const r of results) {
				if (r.error) {
					hasErrors = true;
					break;
				}
				resultMap.set(r.id, r.result || "0x");
			}
			if (hasErrors) {
				console.error(`RPC ${rpc} batch had errors`);
				continue;
			}

			// batch success
			return calls.map((_, i) => resultMap.get(i + 1) || "0x");
		} catch (e) {
			console.error(`RPC ${rpc} batch fetch error:`, e);
		}
	}

	console.error("All RPCs failed for batch");
	return calls.map(() => "0x");
}

// Batch eth_call helper for reconciliation paths where "RPC failed" must not
// be confused with a real on-chain zero result.
export async function ethCallBatchChecked(
	env: Env,
	calls: string[],
	timeoutMs = 10000,
): Promise<string[] | null> {
	const endpoints = Array.from(
		new Set(
			[...RPC_ENDPOINTS, env.RPC_URL, env.ALCHEMY_FALLBACK_URL].filter((u): u is string =>
				Boolean(u),
			),
		),
	);

	for (const rpc of endpoints) {
		try {
			const batch = calls.map((data, i) => ({
				jsonrpc: "2.0",
				method: "eth_call",
				id: i + 1,
				params: [{ to: env.DIAMOND_ADDRESS, data }, "latest"],
			}));

			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(batch),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!resp.ok) {
				console.error(`RPC ${rpc} batch HTTP error: ${resp.status}`);
				continue;
			}

			const results = (await resp.json()) as RpcResponse[];
			if (!Array.isArray(results)) {
				console.error(`RPC ${rpc} checked batch error: not an array`);
				continue;
			}

			const resultMap = new Map<number, string>();
			let hasErrors = false;
			for (const r of results) {
				if (r.error || typeof r.result !== "string") {
					hasErrors = true;
					break;
				}
				resultMap.set(r.id, r.result);
			}
			if (hasErrors || resultMap.size !== calls.length) {
				console.error(`RPC ${rpc} checked batch had errors or missing results`);
				continue;
			}

			return calls.map((_, i) => resultMap.get(i + 1) as string);
		} catch (e) {
			console.error(`RPC ${rpc} checked batch fetch error:`, e);
		}
	}

	console.error("All RPCs failed for checked batch");
	return null;
}
