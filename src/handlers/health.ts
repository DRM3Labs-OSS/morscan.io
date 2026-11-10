/**
 * Health & Status Handlers
 *
 * /health is pure D1 reads - no RPC, no provenance signing, no WASM.
 * The SyncCoordinator writes currentBlock to sync_state on every tick;
 * we just read what it wrote. This keeps health fast and eliminates
 * the hung-RPC failure mode that caused "Stale" badges in the UI.
 *
 * One body, two audiences. The full reading goes only to a request carrying this door's
 * operator read key (X-DRM3-Ops-Key). Everyone else gets the fields public-health.allow
 * names at the repo root and nothing more: default-deny, so a field added below is private
 * until it is written down there with a reason. The full reading is cached for 3s under an
 * internal cache key (never the public URL) and leaves through ONE exit, handleHealth(),
 * which projects it per caller. Both answers are no-store and Vary on the key header, so a
 * full body can never sit in a shared cache.
 */

import allowText from "../../public-health.allow";
import { withCfCache } from "../utils/cache";
import { buildHealth } from "../utils/health-contract";
import { audienceBody } from "./health-audience";
import type { Env } from "../types";
import { MORSCAN_VERSION } from "../version";
import { BUILD_INFO } from "../build-info";
import { buildMeta } from "../utils/rpc";
import { getNetworkMetrics } from "../utils/metrics";
import {
	readAllCoverage,
	formatEta,
	MOR_DEPLOY_BLOCK,
	DIAMOND_DEPLOY_BLOCK,
	BUILDER_DEPLOY_BLOCK,
} from "../sync/holder-coverage";
import {
	selectEconomicsHealth,
	selectLastEventBlock,
	selectLatestDiamondUpgrade,
	selectSyncStateIn3,
	selectSyncStateIn4,
} from "../db/explorer-core";
import { countDiamondUpgrades } from "../db/explorer-market";
import { readBlockTimeMs, DEFAULT_BLOCK_TIME_MS, lagSeconds } from "../sync/chain-clock";
import { classifyHealth } from "./health-status";
import { selectLastBuilderEventBlock } from "../db/explorer-builder";

/** /sync/status reads "synced" within this many seconds of the head (10s reorg margin + a tick). */
const SYNCED_LAG_SECONDS = 30;

const MOR_TOKEN_ADDRESS = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";

/** The one exit for GET /health: the cached full reading, projected for this caller. */
export async function handleHealth(
	request: Request,
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	const cached = await withCfCache("health:v1", 3, () =>
		fullHealthResponse(env, headers),
	);
	const text = await cached.text();
	let full: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			full = parsed as Record<string, unknown>;
		}
	} catch {
		/* an unreadable reading serves nothing: default-deny */
	}
	const out = new Headers(headers);
	out.set("Cache-Control", "no-store");
	out.set("Vary", "X-DRM3-Ops-Key");
	const cacheMark = cached.headers.get("X-Cache");
	if (cacheMark) out.set("X-Cache", cacheMark);
	return new Response(JSON.stringify(audienceBody(request, env, full, allowText)), {
		status: cached.status,
		headers: out,
	});
}

/** The full reading, for the operator. Every field the status board and the site read. */
async function fullHealthResponse(env: Env, headers: Record<string, string>) {
	let lastBlock = 0;
	let currentBlock = 0;
	let startBlock = 42400000;
	let lastSyncTs: string | null = null;
	let providerCount = 0;
	let bidCount = 0;
	let activeSessions = 0;
	let stakingFactor: unknown = null;
	let economicsUpdatedAt: unknown = null;
	let syncError = false;

	let builderBlock = 0;
	let eventCursorBlock = 0;
	let lastDiamondUpgrade: {
		block: number;
		txHash: string;
		facetCount: number;
		timestamp: number;
	} | null = null;
	let diamondUpgradeCount = 0;
	let blockTimeMs = DEFAULT_BLOCK_TIME_MS;

	try {
		const HEALTH_TIMEOUT = 3000;
		// Provider/bid/active-session counts come from the ONE canonical metrics
		// helper so /health, /teaser, and every UI widget report identical numbers.
		const queries = Promise.all([
			selectSyncStateIn4(
				env.DB,
				"last_block",
				"start_block",
				"last_sync_ts",
				"current_block",
			),
			getNetworkMetrics(env),
			selectEconomicsHealth(env.DB),
			selectLastBuilderEventBlock(env.DB),
			selectLastEventBlock(env.DB),
			selectLatestDiamondUpgrade(env.DB).catch(() => null),
			countDiamondUpgrades(env.DB).catch(() => null),
			readBlockTimeMs(env.DB),
		]);
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Health D1 queries timed out")), HEALTH_TIMEOUT),
		);
		const [
			syncRows,
			metrics,
			econ,
			builderRow,
			eventCursorRow,
			lastUpgradeRow,
			upgradeCountRow,
			measuredBlockTimeMs,
		] = await Promise.race([queries, timeout]);
		blockTimeMs = measuredBlockTimeMs;

		const syncMap = new Map<string, string>();
		for (const row of syncRows) {
			syncMap.set(row.key, row.value);
		}
		lastBlock = parseInt(syncMap.get("last_block") || "0", 10);
		startBlock = parseInt(syncMap.get("start_block") || "42400000", 10);
		lastSyncTs = syncMap.get("last_sync_ts") || null;
		currentBlock = parseInt(syncMap.get("current_block") || "0", 10);
		if (currentBlock === 0) currentBlock = lastBlock;

		providerCount = metrics.providers;
		bidCount = metrics.bids;
		activeSessions = metrics.activeSessions;
		stakingFactor = (econ as Record<string, unknown>)?.staking_factor || null;
		economicsUpdatedAt = (econ as Record<string, unknown>)?.updated_at || null;
		builderBlock = builderRow ? parseInt(builderRow.value as string, 10) : 0;
		eventCursorBlock = eventCursorRow ? parseInt(eventCursorRow.value as string, 10) : 0;
		if (lastUpgradeRow) {
			lastDiamondUpgrade = {
				block: (lastUpgradeRow as Record<string, unknown>).block_number as number,
				txHash: (lastUpgradeRow as Record<string, unknown>).tx_hash as string,
				facetCount: (lastUpgradeRow as Record<string, unknown>).facet_count as number,
				timestamp: (lastUpgradeRow as Record<string, unknown>).block_timestamp as number,
			};
		}
		diamondUpgradeCount = upgradeCountRow?.count || 0;
	} catch {
		syncError = true;
	}

	const blocksBehind = currentBlock - lastBlock;
	const meta = buildMeta(
		lastBlock,
		currentBlock,
		startBlock,
		lastSyncTs || new Date().toISOString(),
	);

	// Historical-data coverage: real from-block per dataset + one shared, measured
	// catch-up (blocks/sec on the free RPC tier) and ETA. Drives the syncing
	// banner. Pure D1 read, so /health stays RPC-free.
	let coverage: Record<string, unknown> | null = null;
	let backfillIndexing = false;
	try {
		const cov = await readAllCoverage(env, currentBlock || lastBlock, builderBlock);
		backfillIndexing = !cov.holders.complete || !cov.sessions.complete;
		coverage = {
			indexing: backfillIndexing,
			blocksPerSec: cov.blocksPerSec,
			etaSeconds: cov.etaSeconds,
			eta: formatEta(cov.etaSeconds),
			// Overall catch-up % is the binding (earliest-floor) dataset: holders.
			pct: cov.holders.pct,
			datasets: {
				builder: {
					fromBlock: BUILDER_DEPLOY_BLOCK,
					scannedTo: cov.builder.scannedTo,
					pct: cov.builder.pct,
					complete: cov.builder.complete,
				},
				sessions: {
					fromBlock: DIAMOND_DEPLOY_BLOCK,
					scannedTo: cov.sessions.scannedTo,
					pct: cov.sessions.pct,
					complete: cov.sessions.complete,
				},
				holders: {
					fromBlock: MOR_DEPLOY_BLOCK,
					scannedTo: cov.holders.scannedTo,
					pct: cov.holders.pct,
					complete: cov.holders.complete,
				},
			},
		};
	} catch {
		/* coverage is best-effort; never fail /health for it */
	}

	const nowSeconds = Math.floor(Date.now() / 1000);
	const lastSyncEpoch = lastSyncTs
		? Math.floor(new Date(lastSyncTs).getTime() / 1000)
		: 0;
	const eventCursorAgeSeconds = lastSyncEpoch ? nowSeconds - lastSyncEpoch : null;
	const cursorBlocksBehind =
		eventCursorBlock > 0 ? currentBlock - eventCursorBlock : null;
	const lastSyncAgeSeconds = eventCursorAgeSeconds;
	// null = builder not configured.
	const builderBlocksBehind =
		builderBlock > 0 && currentBlock > 0 ? currentBlock - builderBlock : null;

	// All lag rules are in seconds of chain time (see ./health-status).
	const verdict = classifyHealth({
		syncError,
		blockTimeMs,
		lastSyncAgeSeconds,
		blocksBehind,
		builderBlocksBehind,
		cursorBlocksBehind,
	});
	const {
		status,
		syncStale,
		eventCursorStuck,
		builderStatus,
		lagSeconds,
		builderLagSeconds,
	} = verdict;

	const contracts = {
		diamond: {
			address: env.DIAMOND_ADDRESS,
			deployBlock: DIAMOND_DEPLOY_BLOCK,
			syncedBlock: lastBlock,
			blocksBehind,
			lagSeconds,
			purpose: "Session staking, provider registry, marketplace, model registry",
			upgrades: {
				totalSeen: diamondUpgradeCount,
				last: lastDiamondUpgrade,
			},
		},
		builder: {
			address: env.BUILDER_CONTRACT || null,
			deployBlock: BUILDER_DEPLOY_BLOCK,
			syncedBlock: builderBlock,
			blocksBehind: builderBlocksBehind,
			lagSeconds: builderLagSeconds,
			status: builderStatus,
			purpose: "Builder subnet staking and rewards",
		},
		mor_token: {
			address: MOR_TOKEN_ADDRESS,
			deployBlock: MOR_DEPLOY_BLOCK,
			syncedBlock: lastBlock,
			blocksBehind,
			lagSeconds,
			purpose:
				"MOR ERC-20 token - holder tracking via Transfer events (backfilled from deploy)",
		},
	};

	// Contract requires stakingFactor: number. D1 returns a REAL on the happy
	// path (identity coercion); only the error/missing-row path (null) becomes 0,
	// which keeps /health responding instead of buildHealth throwing.
	const stakingFactorNum =
		typeof stakingFactor === "number" ? stakingFactor : Number(stakingFactor) || 0;

	// Legacy top-level fields preserved verbatim for existing consumers
	// (the monitor and dashboards read several of these directly).
	const legacy: Record<string, unknown> = {
		service: "morscan",
		...meta,
		lastSyncTimestamp: lastSyncTs || new Date().toISOString(),
		lastSyncAgeSeconds,
		syncStale,
		bids: bidCount,
		economicsUpdatedAt,
		claimable_list_consistent: !eventCursorStuck,
		accounting_signal: eventCursorStuck ? "partial" : "consistent",
		blocksBehind,
		lagSeconds, // the same gap in seconds of chain time (what the status rules use)
		blockTimeMs, // measured Base block time the conversion used
		coverage, // per-dataset historical from-block + % + ETA (syncing banner reads this)
		backfillIndexing, // true while any dataset is still catching up to its deploy floor
	};

	// Canonical envelope last - buildHealth validates the MorScan metric contract
	// (syncedBlock, blocksBehind, providers, activeSessions, stakingFactor) and
	// emits metrics at the top level AND inside `extended`.
	const health: Record<string, unknown> = {
		...legacy,
		...buildHealth({
			sku: "morscan",
			status,
			product: "MorScan",
			version: MORSCAN_VERSION,
			metrics: {
				syncedBlock: lastBlock,
				blocksBehind,
				providers: providerCount,
				activeSessions,
				stakingFactor: stakingFactorNum,
			},
			extended: {
				currentBlock,
				lastSyncTs: lastSyncTs || new Date().toISOString(),
				lastSyncAgeSeconds,
				syncStale,
				bids: bidCount,
				economicsUpdatedAt,
				contracts,
				eventCursorBlock,
				eventCursorAgeSeconds,
				cursorBlocksBehind,
				eventCursorStuck,
				claimable_list_consistent: !eventCursorStuck,
				build: {
					commit: BUILD_INFO.shortCommit,
					builtAt: BUILD_INFO.builtAt,
					dirty: BUILD_INFO.dirty,
					provenance: BUILD_INFO.provenanceVersion,
				},
			},
		}),
	};

	return new Response(JSON.stringify(health), { headers });
}

export async function handleSyncStatus(env: Env, headers: Record<string, string>) {
	const rows = await selectSyncStateIn3(
		env.DB,
		"last_block",
		"current_block",
		"last_sync_ts",
	);
	const m = new Map<string, string>();
	for (const row of rows) m.set(row.key, row.value);
	const lastBlock = parseInt(m.get("last_block") || "0", 10);
	const currentBlock = parseInt(m.get("current_block") || "0", 10) || lastBlock;
	const blocksBehind = currentBlock - lastBlock;
	// Synced = within the reorg margin plus one tick of the head, in chain time.
	const lag = lagSeconds(blocksBehind, await readBlockTimeMs(env.DB)) ?? 0;

	return new Response(
		JSON.stringify({
			sku: "morscan",
			product: "MorScan",
			version: MORSCAN_VERSION,
			...buildMeta(lastBlock, currentBlock),
			lastSyncTimestamp: m.get("last_sync_ts") || null,
			lagSeconds: lag,
			status: lag <= SYNCED_LAG_SECONDS ? "synced" : "syncing",
		}),
		{ headers },
	);
}
