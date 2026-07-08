/**
 * Shared per-call RPC fallback for event-log fetching.
 *
 * Background: each sync cycle picks ONE RPC via findWorkingRpc() and reuses
 * it for every eth_getLogs call in the cycle. If that single RPC starts
 * failing mid-cycle (rate limits, timeouts) every call throws, the cycle's
 * cursor protection correctly holds - but the SAME range gets retried every
 * tick, never landing. Users see this as new sessions taking hundreds of
 * seconds to appear in the index.
 *
 * This helper widens the failure window from "1 RPC fails" to "all RPCs in
 * the pool fail" by walking the pool per call. It only throws when every
 * endpoint failed, preserving the existing per-topic catch + cursor-hold
 * semantics in callers.
 *
 * Used by sync-events.ts (compute), sync-builder.ts (subnet activity),
 * and any future event-log fetcher that wants the same resilience.
 *
 * sync-balances.ts has its own parallel-chunk fallback (different shape:
 * many small ranges in parallel, each with full-pool fallback per chunk)
 * and is intentionally not migrated to this helper.
 */

import { getLogsFromRpc, type EventLog } from "../sync/events-batch";
import { RPC_ENDPOINTS } from "../sync/parsers";

/**
 * Fetch eth_getLogs walking the full RPC pool.
 *
 * Order of attempts:
 *   1. The cycle's chosen primaryRpc (from findWorkingRpc) - almost always
 *      works on first try.
 *   2. env.RPC_URL - the configured default if it differs from primary.
 *   3. The rest of RPC_ENDPOINTS in order.
 *
 * Duplicates are removed so we never waste a round-trip. Successful fetches
 * after one or more failures emit a warn log so degraded providers are
 * visible in `wrangler tail` without paging anyone.
 *
 * Throws only if every endpoint fails. The error message lists every failure
 * so the caller's `errors[]` array gets a useful breadcrumb.
 */
export async function getLogsWithFallback(
	primaryRpc: string,
	rpcUrl: string,
	contract: string,
	topic: string,
	fromBlock: number,
	toBlock: number,
	label: string,
): Promise<EventLog[]> {
	const endpoints = Array.from(new Set([primaryRpc, rpcUrl, ...RPC_ENDPOINTS]));
	const failures: string[] = [];
	for (const ep of endpoints) {
		try {
			const result = await getLogsFromRpc(ep, contract, topic, fromBlock, toBlock);
			if (failures.length > 0) {
				console.warn(
					`[getLogsWithFallback] ${label} succeeded on ${ep} after ${failures.length} failure(s): ${failures.join("; ")}`,
				);
			}
			return result;
		} catch (e) {
			failures.push(`${ep}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	throw new Error(
		`${label}: all ${endpoints.length} RPCs failed: ${failures.join("; ")}`,
	);
}
