/**
 * Health & Status Handlers
 *
 * /health is pure D1 reads - no RPC, no provenance signing, no WASM.
 * The SyncCoordinator writes currentBlock to sync_state on every tick;
 * we just read what it wrote. This keeps health fast and eliminates
 * the hung-RPC failure mode that caused "Stale" badges in the UI.
 */

import { buildHealth } from "../utils/health-contract";
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
import { selectLastBuilderEventBlock } from "../db/explorer-builder";

const MOR_TOKEN_ADDRESS = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";

export async function handleHealth(env: Env, headers: Record<string, string>) {
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
		] = await Promise.race([queries, timeout]);

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
	const eventCursorStuck =
		eventCursorAgeSeconds !== null &&
		eventCursorAgeSeconds > 120 &&
		cursorBlocksBehind !== null &&
		cursorBlocksBehind > 30;

	// Pure wall-clock staleness. This is the ONLY reliable stall signal, because
	// both current_block AND last_block are written by the sync tick itself - when
	// sync dies they freeze together and blocksBehind stays ~0, making a dead sync
	// look healthy. lastSyncTs keeps aging against the wall clock, so age is the
	// truth. >120s => degraded, >300s => error. If lastSyncTs is missing, treat as
	// stale (we cannot prove freshness).
	const lastSyncAgeSeconds = lastSyncEpoch ? nowSeconds - lastSyncEpoch : null;
	const syncStale = lastSyncAgeSeconds === null || lastSyncAgeSeconds > 120;
	const syncVeryStale = lastSyncAgeSeconds === null || lastSyncAgeSeconds > 300;

	// Builder freshness - mirror the compute status levels so builder drift is
	// observable (the 23-min gap must never hide behind a green badge again).
	// ok < 100 blocks behind, degraded 100-500, error > 500. null = not configured.
	const builderBlocksBehind =
		builderBlock > 0 && currentBlock > 0 ? currentBlock - builderBlock : null;
	const builderStatus: "ok" | "degraded" | "error" | null =
		builderBlocksBehind === null
			? null
			: builderBlocksBehind >= 500
				? "error"
				: builderBlocksBehind >= 100
					? "degraded"
					: "ok";

	const status = syncError
		? "error"
		: syncVeryStale || blocksBehind >= 500 || builderStatus === "error"
			? "error"
			: syncStale || eventCursorStuck || builderStatus === "degraded"
				? "degraded"
				: blocksBehind >= 50
					? "degraded"
					: "ok";

	const contracts = {
		diamond: {
			address: env.DIAMOND_ADDRESS,
			deployBlock: DIAMOND_DEPLOY_BLOCK,
			syncedBlock: lastBlock,
			blocksBehind,
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
			status: builderStatus,
			purpose: "Builder subnet staking and rewards",
		},
		mor_token: {
			address: MOR_TOKEN_ADDRESS,
			deployBlock: MOR_DEPLOY_BLOCK,
			syncedBlock: lastBlock,
			blocksBehind,
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

	return new Response(
		JSON.stringify({
			sku: "morscan",
			product: "MorScan",
			version: MORSCAN_VERSION,
			...buildMeta(lastBlock, currentBlock),
			lastSyncTimestamp: m.get("last_sync_ts") || null,
			status: blocksBehind <= 1 ? "synced" : "syncing",
		}),
		{ headers },
	);
}
