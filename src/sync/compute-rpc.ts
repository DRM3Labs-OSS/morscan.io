/**
 * Compute Sync - RPC plumbing
 *
 * Endpoint ordering (Alchemy first, free RPCs as fallback), the single-call
 * `rpc` helper and the JSON-RPC batch helper used by the projector.
 *
 * Split out of compute.ts (2026-06-17). compute.ts re-exports nothing from here
 * directly - these are internal helpers shared with compute-stats.ts / the
 * projector. Behavior is byte-for-byte identical to the original inline code.
 */

import type { Env } from "../types";
import { RPC_ENDPOINTS } from "./parsers";
import { getRpcPool } from "../utils/rpc-pool";

export const RPC_TIMEOUT = 15000;

export interface LogEntry {
	address: string;
	topics: string[];
	data: string;
	blockNumber: string;
	transactionHash: string;
	logIndex: string;
}

// 2026-04-27: Alchemy FIRST, free RPCs as fallback. Free RPCs may fail from
// Cloudflare Workers for certain methods. Standard eth_getLogs on Alchemy is
// NOT the expensive alchemy_getTransactionReceipts.
export function buildEndpoints(envUrl: string, alchemyUrl?: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const u of [alchemyUrl, envUrl, ...RPC_ENDPOINTS]) {
		if (u && !seen.has(u)) {
			seen.add(u);
			result.push(u);
		}
	}
	return result;
}

// Free public Base endpoints that serve WIDE getLogs ranges (2000+ blocks) on
// recent blocks with no auth. First in the backfill order so a recent catch-up
// sends one wide getLogs instead of ~120 ten-block calls against the free-tier
// Alchemy cap. Not deep-archive: on very old ranges they can return empty, so
// the archive Alchemy keys stay right behind them as the correctness fallback.
const BACKFILL_WIDE_PEERS = [
	"https://base.gateway.tenderly.co",
	"https://mainnet.base.org",
];

// Backfill endpoint order: wide-range free peers FIRST (recent catch-up flies),
// then the DEDICATED backfill Alchemy key (archive, for any deep range), then
// the live key, then public peers. Live sync (rpc/buildEndpoints) is unchanged.
export function buildBackfillEndpoints(env: Env): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const u of [
		...BACKFILL_WIDE_PEERS,
		env.BACKFILL_ALCHEMY_URL,
		env.ALCHEMY_FALLBACK_URL,
		env.RPC_URL,
		...RPC_ENDPOINTS,
	]) {
		if (u && !seen.has(u)) {
			seen.add(u);
			result.push(u);
		}
	}
	return result;
}

let _endpoints: string[] | null = null;
export function getEndpoints(env: Env): string[] {
	if (!_endpoints) _endpoints = buildEndpoints(env.RPC_URL, env.ALCHEMY_FALLBACK_URL);
	return _endpoints;
}

export async function rpc(
	envUrl: string,
	method: string,
	params: unknown[],
	alchemyUrl?: string,
): Promise<unknown> {
	// Single calls go through the drm3-rpc-pool WASM failover pool (free Base peers,
	// health-aware load spreading). Falls back to the legacy sequential loop only
	// if the pool errors. With RPC_POOL_ENABLED="false" the same call() surface is
	// a plain fetch to RPC_URL (no WASM initialized) - see src/utils/rpc-pool.ts.
	const pool = getRpcPool(envUrl, alchemyUrl);
	if (pool) {
		try {
			return await pool.call(method, params);
		} catch (e) {
			console.error(
				`[sync] rpc-pool ${method} failed, falling back: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	const endpoints = buildEndpoints(envUrl, alchemyUrl);
	for (const url of endpoints) {
		try {
			const resp = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", method, id: 1, params }),
				signal: AbortSignal.timeout(RPC_TIMEOUT),
			});
			const data = (await resp.json()) as Record<string, unknown>;
			if (data.error) {
				console.error(
					`[sync] RPC ${url.split("/")[2]} ${method}: ${(data.error as Record<string, unknown>).message}`,
				);
				continue;
			}
			return data.result;
		} catch (e) {
			console.error(
				`[sync] RPC ${url.split("/")[2]} ${method}: ${e instanceof Error ? e.message : e}`,
			);
		}
	}
	throw new Error(`All RPCs failed for ${method}`);
}

export async function rpcBatch(
	envUrl: string,
	calls: Array<{ method: string; params: unknown[] }>,
	alchemyUrl?: string,
): Promise<unknown[]> {
	if (calls.length === 0) return [];
	const endpoints = buildEndpoints(envUrl, alchemyUrl);
	const batch = calls.map((c, i) => ({
		jsonrpc: "2.0",
		method: c.method,
		id: i + 1,
		params: c.params,
	}));
	for (const url of endpoints) {
		try {
			const resp = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(batch),
				signal: AbortSignal.timeout(RPC_TIMEOUT),
			});
			const results = (await resp.json()) as Array<Record<string, unknown>>;
			if (!Array.isArray(results)) {
				console.error(`[sync] RPC ${url.split("/")[2]} batch: not array`);
				continue;
			}
			const map = new Map<number, unknown>();
			let hasErrors = false;
			for (const r of results) {
				if (r.error) {
					hasErrors = true;
					break;
				}
				map.set(r.id as number, r.result);
			}
			if (hasErrors) {
				console.error(`[sync] RPC ${url.split("/")[2]} batch: has errors`);
				continue;
			}
			return calls.map((_, i) => map.get(i + 1));
		} catch (e) {
			console.error(
				`[sync] RPC ${url.split("/")[2]} batch: ${e instanceof Error ? e.message : e}`,
			);
		}
	}
	// No endpoint served the JSON-RPC batch array - free public RPCs commonly
	// reject batch requests ("not array"). Fall back to individual calls (each
	// routed through the failover pool), bounded concurrency, so MorScan still
	// completes on the free tier.
	console.warn(
		`[sync] batch unsupported on all endpoints; falling back to ${calls.length} individual calls`,
	);
	const out: unknown[] = new Array(calls.length);
	const CONCURRENCY = 8;
	for (let i = 0; i < calls.length; i += CONCURRENCY) {
		const slice = calls.slice(i, i + CONCURRENCY);
		const settled = await Promise.all(
			slice.map((c) =>
				rpc(envUrl, c.method, c.params, alchemyUrl).catch(() => undefined),
			),
		);
		for (let j = 0; j < settled.length; j++) out[i + j] = settled[j];
	}
	return out;
}
