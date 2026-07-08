/**
 * Sync & Admin Routes
 */

import { countProviders, getMaxSyncedHead, getSyncStateValue } from "../db/ops";
import type { Env } from "../types";
import { sync, initSync } from "../sync/compute";
import { discoverHistoricalBids } from "../handlers/marketplace";
import { backfillTxHashes } from "../handlers/analytics";

export async function handleSyncRoute(
	path: string,
	url: URL,
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	if (path === "/trigger-sync") {
		try {
			const result = await sync(env);
			const count = await countProviders(env.DB);
			return new Response(
				JSON.stringify({ success: true, providerCount: count?.cnt, syncResult: result }),
				{ headers },
			);
		} catch (e: unknown) {
			console.error("Sync error:", e);
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ status: 500, headers },
			);
		}
	}

	if (path === "/sync/events") {
		try {
			const result = await sync(env);
			return new Response(JSON.stringify({ success: true, ...result }), { headers });
		} catch (e: unknown) {
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ headers },
			);
		}
	}

	if (path === "/sync/reset-events") {
		try {
			const blockParam = url.searchParams.get("block");
			const block = blockParam ? parseInt(blockParam, 10) : undefined;
			if (block !== undefined && (!Number.isFinite(block) || block < 0)) {
				return new Response(JSON.stringify({ error: "Invalid block number" }), {
					status: 400,
					headers,
				});
			}
			await initSync(env, block);
			const result = await sync(env);
			return new Response(
				JSON.stringify({
					success: true,
					resetTo: block || "current-100",
					syncResult: result,
				}),
				{ headers },
			);
		} catch (e: unknown) {
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ headers },
			);
		}
	}

	if (path === "/sync/backfill-tx") {
		return await backfillTxHashes(env, headers);
	}

	// Historical backfill: throttled archive-RPC re-scan of an explicit
	// [from,to] block range. SAFE by design - it upserts events idempotently and
	// NEVER moves the live cursor (last_event_block), so the live forward sync
	// keeps running at head and the site stays fresh. Bounded per call by
	// BACKFILL_MAX_CHUNKS_PER_RUN; resume via the returned `nextFrom`.
	// Requires an archive-capable RPC (Alchemy) - see docs/DEPENDENCIES.md.
	if (path === "/sync/backfill") {
		const from = parseInt(url.searchParams.get("from") || "", 10);
		const to = parseInt(url.searchParams.get("to") || "", 10);
		if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
			return new Response(
				JSON.stringify({
					error: "Provide ?from=<block>&to=<block> with 0 <= from <= to",
				}),
				{ status: 400, headers },
			);
		}
		try {
			const { backfillRange } = await import("../sync/backfill");
			const result = await backfillRange(env, from, to);
			return new Response(JSON.stringify({ success: true, ...result }), { headers });
		} catch (e: unknown) {
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ status: 500, headers },
			);
		}
	}

	// Holder-history DISCOVERY backfill: throttled, resumable re-scan of MOR
	// Transfer events from MOR_DEPLOY_BLOCK forward, so mor_holders includes every
	// wallet that held MOR before the live indexer started (the undercount fix).
	// `from` defaults to the persisted frontier+1 (resume); pass ?from=<deploy> to
	// (re)start the campaign from the token deploy block. `to` defaults to head.
	if (path === "/sync/backfill-holders") {
		try {
			const { MOR_DEPLOY_BLOCK, HOLDER_BACKFILL_KEYS } = await import(
				"../sync/holder-coverage"
			);
			const { backfillHolders } = await import("../sync/backfill");
			const headRow = await getMaxSyncedHead(env.DB);
			const head = headRow ? parseInt(headRow.value, 10) : 0;
			let from = parseInt(url.searchParams.get("from") || "", 10);
			if (!Number.isFinite(from)) {
				const fr = await getSyncStateValue(env.DB, HOLDER_BACKFILL_KEYS.frontier);
				const frontier = fr ? parseInt(fr.value, 10) : 0;
				from = frontier >= MOR_DEPLOY_BLOCK ? frontier + 1 : MOR_DEPLOY_BLOCK;
			}
			const to = Number.isFinite(parseInt(url.searchParams.get("to") || "", 10))
				? parseInt(url.searchParams.get("to") as string, 10)
				: head;
			if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
				return new Response(JSON.stringify({ error: "Bad range", from, to, head }), {
					status: 400,
					headers,
				});
			}
			const result = await backfillHolders(env, from, to);
			return new Response(JSON.stringify({ success: true, head, ...result }), {
				headers,
			});
		} catch (e: unknown) {
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ status: 500, headers },
			);
		}
	}

	// Idempotent balanceOf sweep: recomputes exact current balances (matches
	// Basescan) for the stalest N holders. Resume by calling repeatedly.
	if (path === "/sync/holder-balances") {
		try {
			const { refreshStaleHolderBalances } = await import("../sync/compute-events");
			const limit = Math.min(
				1000,
				Math.max(1, parseInt(url.searchParams.get("limit") || "150", 10) || 150),
			);
			const result = await refreshStaleHolderBalances(env, limit);
			return new Response(JSON.stringify({ success: true, limit, ...result }), {
				headers,
			});
		} catch (e: unknown) {
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ status: 500, headers },
			);
		}
	}

	if (path === "/sync/discover-bids") {
		try {
			return await discoverHistoricalBids(env, headers);
		} catch (e: unknown) {
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ headers },
			);
		}
	}

	if (path === "/sync/builder-events") {
		try {
			const { syncBuilderEvents } = await import("../sync/builder");
			const result = await syncBuilderEvents(env);
			return new Response(JSON.stringify({ success: true, ...result }), { headers });
		} catch (e: unknown) {
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ status: 500, headers },
			);
		}
	}

	if (path === "/sync/builder-full") {
		try {
			const { syncBuilderFullState } = await import("../sync/builder");
			await syncBuilderFullState(env);
			return new Response(JSON.stringify({ success: true, status: "ok" }), { headers });
		} catch (e: unknown) {
			return new Response(
				JSON.stringify({
					success: false,
					error: e instanceof Error ? e.message : String(e),
				}),
				{ status: 500, headers },
			);
		}
	}

	if (path.startsWith("/sync/coordinator")) {
		const id = env.SYNC_COORDINATOR.idFromName("main");
		const stub = env.SYNC_COORDINATOR.get(id);
		const action = path.split("/").pop() || "status";
		const doResp = await stub.fetch(`http://internal/${action}`);
		const data = await doResp.json();
		return new Response(JSON.stringify(data), { headers });
	}

	return new Response(JSON.stringify({ error: "Unknown sync route" }), {
		status: 404,
		headers,
	});
}
