/**
 * createMorscanApp - the COMPOSITION FACTORY for the MorScan worker.
 *
 * MorScan is open-core (docs/architecture/providers.md). This factory is the
 * single wiring point for BOTH consumption modes:
 *
 *   (a) Standalone OSS: src/index.ts default-exports `createMorscanApp()` -
 *       the bundled reference providers, byte-for-byte today's behavior.
 *   (b) A private composition repo (the Sentry sentry/getsentry shape)
 *       imports this core as a dependency and calls
 *       `createMorscanApp({ providers: {...}, adminRoutes, scheduledTick })`
 *       to swap provider seams and register operator hooks. The composition
 *       repo owns the real wrangler config and deploys under its own name.
 *
 * The factory returns the `{ fetch, scheduled }` worker handler object. The
 * Durable Object class is re-exported here (and from src/index.ts) so any
 * entry module can satisfy the wrangler DO binding with a plain re-export.
 *
 * ONE COMPOSITION PER BUNDLE: the provider registry is resolved into a
 * module-level singleton (src/providers/index.ts) because provider lookups
 * happen deep in the call tree via getProviders(). The last createMorscanApp
 * call wins. A worker bundle composes exactly one app (its default export),
 * so this is a non-issue in practice; do not create two differently-composed
 * apps in one bundle.
 *
 * HONESTY: the factory records which provider seams were overridden and any
 * deploy identity the composition passes; /version surfaces both (the
 * `composition` field), so the live site never pretends a composed build is
 * the plain reference build.
 *
 * This file lives under src/providers/ ON PURPOSE: the whole pluggable
 * surface (seam interfaces, reference impls, registry, this factory) sits in
 * ONE folder. src/providers/README.md is the plug map; src/app.ts is only a
 * thin re-export for the `morscan/app` import path.
 */

import type { Env } from "../types";
import { setBaseUrl, signingMnemonic } from "../config";
import { configureRpcPool } from "../utils/rpc-pool";
import { handle404 } from "../handlers/ui";
import {
	isComingSoonHost,
	comingSoonPassthrough,
	comingSoonResponse,
} from "../handlers/coming-soon";
import { buildAndCacheFatboy } from "../handlers/fatboy";
import { writeMarketplaceSnapshot } from "../utils/snapshot-store";
import { handleSnapshotPrune } from "../handlers/snapshot-prune";
import { validateApiKey, validateKey } from "../utils/auth";
import { installProviders, getProviders, type Providers } from "./index";
import { handleAuthRoutes } from "../routes/auth";
import { handleUiRoutes } from "../routes/ui";
import { handlePublicRoutes } from "../routes/public";
import { handleApiRoutes } from "../routes/api";
import { notifyAlert, runAlertDetection } from "../alerts";
import {
	deleteSyncStateValue,
	getMaxSyncedHead,
	getSyncStateValue,
	putSyncStateValue,
	upsertSyncStateValue,
	pruneOldReceipts,
} from "../db/ops";
import { getModelsNeedingDescriptions } from "../db/explorer-market";
import { selectSyncStateIn3 } from "../db/explorer-core";

// Re-export what a composition repo needs, so its entry module can import
// everything from this one file and never evaluate src/index.ts (whose
// module-scope default composition would otherwise run first, harmlessly but
// pointlessly).
export { SyncCoordinator } from "../durable/SyncCoordinator";
export type { Env } from "../types";
export type { Providers } from "./index";

/** Sanitize redirect target - must be a relative path, no open redirect */
export function safeRedirect(target: string | null | undefined): string {
	// Default landing is /analytics/overview - the canonical Analytics subtab.
	// One default, not two (login used to land on /network while / sent you
	// to /analytics).
	if (!target || !target.startsWith("/") || target.startsWith("//"))
		return "/analytics/overview";
	return target;
}

export const HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	// Canonical X-Morscan-* names only (plus the x402 payment header).
	"Access-Control-Allow-Headers":
		"Content-Type, X-Morscan-Key, Authorization, X-Morscan-Wallet, X-Morscan-Ts, X-Morscan-Sig, X-Morscan-Nonce, X-Morscan-Version, X-Morscan-Staking-Wallet, X-PAYMENT",
	"Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
	"Cache-Control": "public, s-maxage=10, max-age=5",
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
};

/**
 * Optional deploy identity a composition repo passes for /version honesty:
 * the composition repo's own commit + dirtiness and the core ref it pins.
 * The reference build passes nothing and /version omits the block.
 */
export interface CompositionDeployInfo {
	/** Composition repo name (e.g. the private deployment repo). */
	name?: string;
	/** Composition repo commit sha. */
	commit?: string;
	/** Composition repo working-tree dirtiness at build time. */
	dirty?: boolean;
	/** The core ref the composition pins (e.g. a version tag). */
	coreRef?: string;
}

export interface MorscanAppOptions {
	/** Swap any provider seam. Entries not listed keep the reference impl. */
	providers?: Partial<Providers>;
	/**
	 * Optional operator routes under /admin/*. The dispatcher authenticates
	 * the caller against the AdminProvider gate BEFORE this is consulted, so
	 * every injected route is admin-gated by construction. Return null to
	 * fall through to the built-in routing (404 included).
	 */
	adminRoutes?: (
		path: string,
		request: Request,
		url: URL,
		env: Env,
	) => Promise<Response | null>;
	/**
	 * Optional maintenance tick, fired from the minute cron. Fire-and-forget
	 * and error-isolated: it can never abort or delay other scheduled work.
	 */
	scheduledTick?: (env: Env, ctx: ExecutionContext) => Promise<void>;
	/** Optional composition deploy identity, surfaced at /version. */
	composition?: CompositionDeployInfo;
}

/** The worker handler object createMorscanApp returns. */
export interface MorscanApp {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
	scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void>;
}

// Deploy identity of the active composition (module singleton, same
// one-composition-per-bundle contract as the provider registry).
let activeCompositionDeploy: CompositionDeployInfo | null = null;

/** The composition deploy identity, if the active composition passed one. */
export function getCompositionDeploy(): CompositionDeployInfo | null {
	return activeCompositionDeploy;
}

export function createMorscanApp(options: MorscanAppOptions = {}): MorscanApp {
	installProviders(options.providers);
	activeCompositionDeploy = options.composition ?? null;
	const composedAdminRoutes = options.adminRoutes;
	const composedScheduledTick = options.scheduledTick;

	return {
		async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
			setBaseUrl(env.PUBLIC_BASE_URL || "");
			configureRpcPool(env);
			const url = new URL(request.url);
			const path = url.pathname;

			if (request.method === "OPTIONS") {
				return new Response(null, { headers: HEADERS });
			}

			// Staging is retired. The apex (morscan.io) is the single live, indexable
			// origin; staging.morscan.io permanently redirects to it (same path +
			// query) so it is not a duplicate-content surface and anyone hitting the
			// old host lands on the real site.
			if (url.hostname === "staging.morscan.io") {
				return new Response(null, {
					status: 301,
					headers: {
						Location: `https://morscan.io${path}${url.search}`,
						"Cache-Control": "public, max-age=3600",
					},
				});
			}

			// Coming-soon holding page: hosts listed in COMING_SOON_HOSTS serve a
			// static page for all UI traffic. /health + brand assets stay reachable.
			if (isComingSoonHost(url.hostname, env) && !comingSoonPassthrough(path)) {
				return comingSoonResponse(env.PUBLIC_BASE_URL || url.origin);
			}

			// workers.dev lock (opt-in via LOCK_WORKERS_DEV="true"): restricts the
			// *.workers.dev origin to admin-key API access only - no UI, no demo key,
			// no login. Useful when a custom domain is the real front door and the
			// workers.dev origin should not be a bypass. Default is OPEN so the
			// GETTING_STARTED workers.dev path works out of the box.
			// `isAdminAuth` accepts `admin` + anything in MORSCAN_ADMIN_KEY_IDS.
			const isWorkersDev =
				env.LOCK_WORKERS_DEV === "true" && url.hostname.endsWith(".workers.dev");
			if (isWorkersDev) {
				const key = request.headers.get("X-Morscan-Key") || "";
				if (!key) {
					return new Response(
						JSON.stringify({ error: "workers.dev requires X-Morscan-Key" }),
						{ status: 401, headers: HEADERS },
					);
				}
				const auth = await validateApiKey(request, env);
				if (!getProviders().admin.isAdmin(auth, env)) {
					return new Response(
						JSON.stringify({ error: "workers.dev restricted to SDK key" }),
						{ status: 403, headers: HEADERS },
					);
				}
				// Fall through to API routes only - no UI, no login, no sync
				if (!path.startsWith("/mor/v1/") && path !== "/health") {
					return new Response(JSON.stringify({ error: "Not available on workers.dev" }), {
						status: 404,
						headers: HEADERS,
					});
				}
			}

			try {
				const authResult = await handleAuthRoutes(
					path,
					request.method,
					url,
					request,
					env,
				);
				if (authResult) return authResult;

				const uiResult = await handleUiRoutes(path, request, url, env, ctx);
				if (uiResult) return uiResult;

				const publicResult = await handlePublicRoutes(
					path,
					request.method,
					request,
					url,
					env,
					HEADERS,
				);
				if (publicResult) return publicResult;

				const apiResult = await handleApiRoutes(path, request, url, env, HEADERS, ctx);
				if (apiResult) return apiResult;

				// Admin alert area (page + JSON API + test-fire). Admin-key gated.
				const adminAlertsResult = await getProviders().admin.handleAlerts(
					path,
					request,
					url,
					env,
				);
				if (adminAlertsResult) return adminAlertsResult;

				// Composition-injected operator routes (the generic open-core seam; see
				// docs/architecture/providers.md). The caller is authenticated against
				// the SAME admin identity gate as the built-in admin areas BEFORE the
				// injected handler is ever consulted, so every injected route is
				// admin-gated by construction. Non-admin (or reference-build) requests
				// fall through unchanged - unknown paths keep their stock 404.
				if (composedAdminRoutes && path.startsWith("/admin/")) {
					const adminKey =
						request.headers.get("X-Morscan-Key") || url.searchParams.get("key") || "";
					if (adminKey) {
						const adminAuth = await validateKey(adminKey, env);
						if (getProviders().admin.isAdmin(adminAuth, env)) {
							const overrideResult = await composedAdminRoutes(path, request, url, env);
							if (overrideResult) return overrideResult;
						}
					}
				}

				return handle404();
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				const stack = e instanceof Error ? e.stack : undefined;
				console.error("Request error:", msg, stack);
				return new Response(
					JSON.stringify({
						error: "Internal server error",
						detail: msg,
						path: url.pathname,
					}),
					{ status: 500, headers: HEADERS },
				);
			}
		},

		async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
			setBaseUrl(env.PUBLIC_BASE_URL || "");
			configureRpcPool(env);
			const safe = (p: Promise<unknown>, label: string) =>
				p.catch((e) => console.error(`[scheduled] ${label} failed:`, e));

			// Multiplex on cron pattern (wrangler.toml → [triggers].crons).
			// Cloudflare passes the triggering cron expression via event.cron.
			const cron = event.cron || "";

			// Workstream B - marketplace CDN snapshot (every 3 min).
			// MUST stay out of the SyncCoordinator DO alarm loop (off-limits).
			if (cron === "*/3 * * * *") {
				ctx.waitUntil(
					safe(
						writeMarketplaceSnapshot(env).then((r) => {
							if (r) console.log(`[snapshot] published marketplace-${r.ts}.json`);
						}),
						"writeMarketplaceSnapshot",
					),
				);
				return;
			}

			// Workstream B - daily R2 snapshot prune (03:00 UTC).
			if (cron === "0 3 * * *") {
				ctx.waitUntil(
					safe(
						handleSnapshotPrune(env).then((r) => {
							console.log(`[snapshot-prune] deleted=${r.deleted} kept=${r.kept}`);
						}),
						"snapshotPrune",
					),
				);
				// Retention prune for provenance_receipts: caps the D1 growth from
				// per-endpoint signing (the 5s warm aggregate no longer persists).
				// 30-day rolling window; receipts still ship inline + stay verifiable.
				ctx.waitUntil(
					safe(
						pruneOldReceipts(env.DB, 30).then((n) => {
							if (n) console.log(`[provenance-prune] deleted ${n} receipts >30d`);
						}),
						"provenancePrune",
					),
				);
				// Description-gap check: freshly registered models arrive without a
				// curated description. One info alert per new batch (watermarked on
				// created_at in sync_state, so a model is reported once), surfaced
				// in /admin/alerts + any configured chat channel. Descriptions are
				// then written and applied with scripts/model-descriptions.mjs.
				ctx.waitUntil(
					safe(
						(async () => {
							const wmRow = await getSyncStateValue(env.DB, "desc_alert_watermark");
							const wm = Number(wmRow?.value) || 0;
							const missing = await getModelsNeedingDescriptions(env.DB, wm);
							if (!missing.length) return;
							const names = missing
								.slice(0, 10)
								.map((m) => String(m.name))
								.join(", ");
							const more = missing.length > 10 ? ` and ${missing.length - 10} more` : "";
							await notifyAlert(
								env,
								{
									level: "info",
									kind: "model_descriptions",
									message: `${missing.length} new model listing${missing.length === 1 ? "" : "s"} need a description: ${names}${more}. Run scripts/model-descriptions.mjs.`,
								},
								{ ctx },
							);
							const maxCreated = Math.max(
								...missing.map((m) => Number(m.created_at) || 0),
							);
							if (maxCreated > 0)
								await upsertSyncStateValue(
									env.DB,
									"desc_alert_watermark",
									String(maxCreated),
								);
						})(),
						"modelDescriptionGap",
					),
				);
				return;
			}

			// Default: existing `* * * * *` minute tick - watchdog the DO sync loop
			// (the alarm dies after every deploy), rebuild fatboy cache, chain
			// provenance receipts. Sync is owned by the DO (5s ticks); the DO's /cron
			// endpoint restarts a dead alarm and, as belt-and-suspenders, forces one
			// tick itself if the cursor is frozen - so even a totally dead DO is pulled
			// forward every minute. The outcome is logged LOUDLY (never swallowed) so a
			// stall is visible in tail logs, not hidden behind a fresh-looking head.
			const doId = env.SYNC_COORDINATOR.idFromName("main");
			ctx.waitUntil(
				safe(
					env.SYNC_COORDINATOR.get(doId)
						.fetch("http://internal/cron")
						.then((r) => r.json() as Promise<Record<string, unknown>>)
						.then((s) => {
							const gap = s.blocksBehind ?? "?";
							const age = s.lastSyncAgeSeconds ?? "?";
							if (s.alarmWasScheduled === false) {
								console.error(
									`[cron] DO alarm was DEAD - restarted. gap=${gap} blocks, lastSyncAge=${age}s`,
								);
							}
							if (s.forcedTick) {
								console.warn(
									`[cron] DO cursor frozen (no advance since last cron) - forced a sync tick. gap=${gap} blocks`,
								);
							}
							console.log(
								`[cron] sync heartbeat OK: synced=${s.syncedBlock} head=${s.liveHead} gap=${gap} lastSyncAge=${age}s alarmLive=${s.alarmWasScheduled}`,
							);
							// Alerting: consume the watchdog status (read-only) and fire alerts
							// on health-state transitions only (deduped). Never touches the DO's
							// alarm/cursor logic. Best-effort - wrapped so it cannot break sync.
							return runAlertDetection(
								env,
								{
									lastSyncAgeSeconds: (s.lastSyncAgeSeconds as number) ?? null,
									liveHead: (s.liveHead as number) ?? null,
									syncedBlock: (s.syncedBlock as number) ?? null,
									blocksBehind: (s.blocksBehind as number) ?? null,
								},
								ctx,
							);
						}),
					"SyncCoordinator/cron",
				),
			);
			ctx.waitUntil(safe(buildAndCacheFatboy(env), "buildAndCacheFatboy"));

			// Precompute the canonical network metrics (providers, bids, active/total
			// sessions, MOR staked) into the shared KV summary. These are the 4 full
			// scans of the ~113k-row sessions table (+ providers + bids) that used to
			// run on the HOT request path (/health, /teaser, the stat bar via
			// getStatBarData, og-image) on every 20s cache miss - the single largest
			// driver of D1 rows-read. Doing it here, once per minute, is now the ONLY
			// place those scans run; the request path just reads the summary (see
			// utils/metrics.ts). SEPARATE step - never touches the DO cursor or the
			// backfill grind. Numbers stay canonical (same query, less often).
			ctx.waitUntil(
				safe(
					import("../utils/metrics").then((m) => m.refreshNetworkMetrics(env)),
					"refreshNetworkMetrics",
				),
			);

			// Precompute the header market-tape data (price, staked, top provider/
			// consumer/subnets, fresh deposits, newest models) into KV, same model as
			// the metrics summary above: the tape's D1 batch runs HERE once per
			// minute and every page render reads the summary (see src/ui/ticker.ts).
			ctx.waitUntil(
				safe(
					import("../ui/ticker").then((m) => m.refreshTickerData(env)),
					"refreshTickerData",
				),
			);

			// Warehouse raw-dump (the Morpheus sense organ): ship the SAME
			// precomputed summaries (metrics KV + tape KV + fatboy modelDemand) to
			// raw_morscan.rows through the analytics seam, when a private BQ tier
			// is composed AND enabled. Zero new D1 scans; KV-stamped to ~15 min
			// (network snapshot) / daily (model batch). No-op in the OSS
			// standalone: the reference provider has no dump methods.
			ctx.waitUntil(
				safe(
					import("../sync/warehouse-dump").then((m) => m.dumpWarehousePulse(env)),
					"warehouseDump",
				),
			);

			// Record OUR own MOR price point from the on-chain Base DEX read (deduped to
			// ~1 point / 10 min inside recordPriceHistory). This builds MorScan's own
			// price series with zero external dependency and powers change24h + the
			// chart. Kept OUT of the SyncCoordinator DO alarm/cursor loop on purpose -
			// it is a pure additive write off the minute tick and cannot affect sync.
			ctx.waitUntil(
				safe(
					import("../utils/onchain-price").then((m) => m.recordPriceHistory(env)),
					"recordPriceHistory",
				),
			);

			// Historical backfill floor - DURABLE SELF-DRIVING GRIND. Advances the
			// genesis-ward frontier toward chain head so coverage converges to 100% on the
			// free tier with NO external runner. Where this used to do ONE bounded window
			// per minute (slow, and so was babysat by a fragile external bash loop that
			// died on session cycles), it now GRINDS MANY windows per tick within a wall-
			// clock budget - so the per-minute cron ALONE converges in hours and needs no
			// babysitting. It is a SEPARATE pass - it never touches the live DO cursor (see
			// docs/data-coverage.md) - and runs on the DEDICATED backfill key
			// (BACKFILL_ALCHEMY_URL, via backfillHolders -> buildBackfillEndpoints) so it
			// never competes with the live sync's key. Locked so grinds never stack.
			ctx.waitUntil(
				safe(
					(async () => {
						const LOCK = "backfill_cron_lock";
						const tickStart = Date.now();
						const now = Math.floor(event.scheduledTime / 1000);
						const lock = await getSyncStateValue(env.DB, LOCK);
						if (lock && now - parseInt(lock.value, 10) < 90) return; // a prior grind is still in flight

						// Live sync health > backfill speed. Cheap D1 read of the sync cursor: if the
						// live sync is stale (no tick in > 120s) or far behind (>= 500 blocks), SKIP
						// the grind this tick and give the RPC/DO room to recover. Backfill uses the
						// dedicated key, but this belt-and-suspenders guard also keeps the grind off
						// the shared D1 during a live-sync stall. Mirrors /health's stall thresholds.
						const hrows = await selectSyncStateIn3(
							env.DB,
							"last_block",
							"current_block",
							"last_sync_ts",
						);
						const hm = new Map(hrows.map((r) => [r.key, r.value] as const));
						const lastBlock = parseInt(hm.get("last_block") || "0", 10);
						const curBlock = parseInt(hm.get("current_block") || "0", 10) || lastBlock;
						const lastSyncTs = hm.get("last_sync_ts");
						const ageSec = lastSyncTs
							? Math.floor(Date.now() / 1000) -
								Math.floor(new Date(lastSyncTs).getTime() / 1000)
							: null;
						const behind = curBlock - lastBlock;
						if (ageSec === null || ageSec > 120 || behind >= 500) {
							console.warn(
								`[cron-backfill] live sync unhealthy (age=${ageSec}s behind=${behind}) - skipping grind this tick`,
							);
							return;
						}

						const { MOR_DEPLOY_BLOCK, HOLDER_BACKFILL_KEYS } = await import(
							"../sync/holder-coverage"
						);
						const { backfillHolders } = await import("../sync/backfill");
						const headRow = await getMaxSyncedHead(env.DB);
						const head = headRow ? parseInt(headRow.value, 10) : 0;
						const fr = await getSyncStateValue(env.DB, HOLDER_BACKFILL_KEYS.frontier);
						const frontier = fr ? parseInt(fr.value, 10) : 0;
						let from = frontier >= MOR_DEPLOY_BLOCK ? frontier + 1 : MOR_DEPLOY_BLOCK;
						if (!head || from > head) return; // fully caught up - cheap no-op, costs nothing once done

						// Grind budget: keep pulling backfill windows (each advances + persists the
						// frontier) until the wall-clock budget or the max-blocks-per-tick ceiling is
						// hit, then stop cleanly and let the NEXT minute tick resume from the
						// persisted frontier. Both env-tunable; defaults stay well under the Worker
						// CPU/subrequest limits for the paid plan.
						const budgetMs = Math.max(
							5000,
							parseInt(env.BACKFILL_TICK_BUDGET_MS || "25000", 10) || 25000,
						);
						const maxBlocks = Math.max(
							1000,
							parseInt(env.BACKFILL_MAX_BLOCKS_PER_TICK || "50000", 10) || 50000,
						);

						await putSyncStateValue(env.DB, LOCK, String(now));
						let windows = 0,
							blocks = 0;
						try {
							while (
								from <= head &&
								Date.now() - tickStart < budgetMs &&
								blocks < maxBlocks
							) {
								const r = await backfillHolders(env, from, head);
								windows++;
								blocks += Math.max(0, (r.scannedTo ?? from) - from + 1);
								if (r.errors.length) {
									// 429 / RPC error - back off cleanly, do NOT fail the tick
									console.warn(
										`[cron-backfill] backing off after window error: ${r.errors[0]}`,
									);
									break;
								}
								if (r.nextFrom == null) break; // frontier reached head - done
								from = r.nextFrom;
								if (Date.now() - tickStart < budgetMs)
									await new Promise((res) => setTimeout(res, 100)); // pace between windows
							}
							console.log(
								`[cron-backfill] grind: ${windows} window(s), ~${blocks} blocks, ${Date.now() - tickStart}ms (budget=${budgetMs}ms) frontier->${from - 1} head=${head}`,
							);
						} finally {
							await deleteSyncStateValue(env.DB, LOCK);
						}
					})(),
					"cronBackfill",
				),
			);

			// Belt-and-suspenders: every ~10 min re-derive builder subnet totals from
			// chain state (the /sync/builder-full logic). The incremental cursor is the
			// primary gap guarantee (never advances past unread blocks); this reconcile
			// ensures even an unforeseen gap self-heals within 10 minutes. Runs off the
			// minute tick so no new cron pattern is needed.
			if (new Date().getUTCMinutes() % 10 === 0) {
				ctx.waitUntil(
					safe(
						import("../sync/builder")
							.then((m) => m.syncBuilderFullState(env))
							.then(() =>
								console.log("[scheduled] builder full-state reconcile complete"),
							),
						"syncBuilderFullState",
					),
				);
			}
			// Stake-indexed caps: recompute wallet-identity key caps from live
			// builder-subnet stakes (UPDATE only on change; logs caps_change).
			ctx.waitUntil(
				safe(
					import("../utils/stake-tier").then((m) => m.refreshWalletCaps(env)),
					"refreshWalletCaps",
				),
			);
			// Composition-injected maintenance tick (the generic open-core seam;
			// the reference build registers none). Fire-and-forget and
			// error-isolated via `safe`, so it can never abort or delay any other
			// scheduled work.
			if (composedScheduledTick) {
				ctx.waitUntil(safe(composedScheduledTick(env, ctx), "composition.scheduledTick"));
			}
			const chainMnemonic = signingMnemonic(env);
			if (chainMnemonic) {
				const { chainReceipts } = await import("../utils/provenance");
				ctx.waitUntil(
					safe(
						chainReceipts(env.DB, chainMnemonic).then((result) => {
							if (result)
								console.log(`Chained ${result.count} receipts → root: ${result.root}`);
						}),
						"chainReceipts",
					),
				);
			}
		},
	};
}
