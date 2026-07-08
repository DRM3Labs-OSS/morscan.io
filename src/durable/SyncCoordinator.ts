/**
 * SyncCoordinator - Durable Object for real-time sync
 *
 * Drives the eth_getLogs sync loop (src/sync/compute.ts) on an alarm tick:
 * sessions, bids, and MOR transfers from Diamond/token logs, plus builder
 * sync and economics refresh.
 */

import type { Env } from "../types";
import { getCurrentBlock } from "../utils/rpc";
import { configureRpcPool } from "../utils/rpc-pool";
import { sync, syncEconomics } from "../sync/compute";
import { syncBuilderEvents } from "../sync/builder";
import { handleAll } from "../handlers/marketplace";
import { handleDailySessions } from "../handlers/provider-detail";
import { handlePriceChart } from "../handlers/price";
import { handleLeaderboard } from "../handlers/leaderboard";
import { handleModelDemand } from "../handlers/provider-detail";
import { warmKvCache } from "../utils/cache";
import { getSyncStatePair } from "../db/sync";

// Watchdog budget. If more than this elapses between two SUCCESSFUL alarm ticks
// the loop was stalled (a killed alarm after a deploy, a hung sync, etc). The
// alarm self-detects this, logs a stall-recovery event, and the very tick that
// notices is itself the catch-up. Kept well under the "never stall past ~1-2min"
// requirement so a stall is caught and healed inside the budget.
const STALL_THRESHOLD_MS = 90_000;

// Minimum head-to-cursor gap (in blocks) before the cron will force a sync tick.
// Steady-state lag is the ~5-block confirmation buffer; this keeps the cron from
// forcing redundant ticks when we are genuinely caught up and the chain is quiet.
const CRON_FORCE_GAP = 15;

export class SyncCoordinator implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private consecutiveFailures = 0;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		// The DO runs in its own isolate, so the RPC_POOL_ENABLED sovereignty
		// switch must be pinned here too (the worker entrypoints pin their own).
		configureRpcPool(env);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// /cron owns its own alarm-liveness check (it must observe whether the alarm
		// was dead BEFORE anything reschedules it). ensureRunning would mask that,
		// so skip the auto-start for the cron path only.
		if (url.pathname !== "/cron") {
			await this.ensureRunning();
		}

		if (url.pathname === "/start") {
			await this.scheduleAlarm();
			return new Response(JSON.stringify({ status: "started", nextAlarm: "5s" }));
		}
		if (url.pathname === "/stop") {
			await this.state.storage.deleteAlarm();
			return new Response(JSON.stringify({ status: "stopped" }));
		}
		if (url.pathname === "/status") {
			const lastSync = await this.state.storage.get("lastSync");
			const syncCount = (await this.state.storage.get("syncCount")) || 0;
			const lastTickMs = (await this.state.storage.get("lastTickMs")) as
				| number
				| undefined;
			const alarm = await this.state.storage.getAlarm();
			return new Response(
				JSON.stringify({
					lastSync,
					syncCount,
					nextAlarm: alarm ? new Date(alarm).toISOString() : null,
					running: alarm !== null,
					lastTickAgeSeconds: lastTickMs
						? Math.floor((Date.now() - lastTickMs) / 1000)
						: null,
				}),
			);
		}
		// Cron watchdog: idempotent restart-if-dead + advance-if-stale. Returns a
		// rich status so the minute cron can log the outcome loudly (never swallow).
		if (url.pathname === "/cron") {
			const status = await this.cronTick();
			return new Response(JSON.stringify(status));
		}
		if (url.pathname === "/trigger") {
			const result = await this.runSync();
			return new Response(JSON.stringify(result));
		}
		return new Response(JSON.stringify({ error: "Unknown path" }), { status: 404 });
	}

	async alarm(): Promise<void> {
		// 1) ALWAYS reschedule the next alarm FIRST - before any await that could
		//    throw or hang. This is the core self-heal guarantee: a thrown sync, a
		//    hung RPC, or an exception anywhere below can NEVER kill the loop,
		//    because the next alarm is already durably committed. (Previously the
		//    reschedule ran at the END, so a sync that never returned silently
		//    killed the loop until the cron happened to restart it - the exact
		//    recovery-path bug behind the ~1h stall.)
		try {
			await this.scheduleAlarm();
		} catch (e) {
			console.error("[SyncCoordinator] Failed to reschedule (top):", e);
		}

		// 2) Watchdog: how long since the last SUCCESSFUL tick? If we blew past the
		//    budget the loop was stalled (killed alarm, hung sync). Log a
		//    stall-recovery event so the gap is observable in logs - this very tick
		//    is the catch-up (runSync's cursor is gap-proof and chunks the backlog).
		try {
			const lastTickMs = (await this.state.storage.get("lastTickMs")) as
				| number
				| undefined;
			if (lastTickMs && Date.now() - lastTickMs > STALL_THRESHOLD_MS) {
				console.warn(
					`[SyncCoordinator] STALL-RECOVERY: ${Math.floor((Date.now() - lastTickMs) / 1000)}s since last successful tick - forcing catch-up`,
				);
			}
		} catch {
			/* watchdog is best-effort; never let it block the tick */
		}

		// 3) Run the sync body. Wrapped so any throw is logged but cannot prevent
		//    the next alarm (already scheduled in step 1).
		try {
			const result = await this.runSync();
			this.consecutiveFailures = result.success ? 0 : this.consecutiveFailures + 1;
		} catch (e) {
			this.consecutiveFailures++;
			console.error("[SyncCoordinator] Alarm sync error:", e);
		}
	}

	private async scheduleAlarm(): Promise<void> {
		const baseDelay = 5000;
		const delay =
			this.consecutiveFailures === 0
				? baseDelay
				: Math.min(baseDelay * 2 ** this.consecutiveFailures, 60000);
		if (this.consecutiveFailures > 0) {
			console.log(
				`[SyncCoordinator] Backing off: ${delay}ms (${this.consecutiveFailures} failures)`,
			);
		}
		await this.state.storage.setAlarm(Date.now() + delay);
	}

	private async ensureRunning(): Promise<void> {
		const alarm = await this.state.storage.getAlarm();
		if (!alarm) {
			console.log("[SyncCoordinator] Auto-starting sync loop");
			await this.scheduleAlarm();
		}
	}

	/** Read the sync cursor + wall-clock freshness straight from D1. */
	private async readSyncState(): Promise<{
		lastBlock: number;
		lastSyncTs: string | null;
	}> {
		const rows = await getSyncStatePair(this.env.DB, "last_block", "last_sync_ts");
		const map = new Map<string, string>();
		for (const row of rows) map.set(row.key, row.value);
		return {
			lastBlock: parseInt(map.get("last_block") || "0", 10),
			lastSyncTs: map.get("last_sync_ts") || null,
		};
	}

	/**
	 * Cron watchdog - called every minute by scheduled(). Three guarantees:
	 *   (a) if the DO alarm is not actually scheduled (deploys kill it), restart it;
	 *   (b) return rich status so the cron logs success/failure + block gap loudly;
	 *   (c) belt-and-suspenders: if syncedBlock has NOT advanced since the last cron
	 *       run and there is a real head gap, the alarm loop is effectively dead even
	 *       though this fetch works - force ONE sync tick so a totally dead DO still
	 *       gets pulled forward every minute.
	 * Deadness is judged off syncedBlock advancement + a LIVE chain head (not the
	 * D1 current_block, which freezes together with the cursor when sync dies).
	 */
	private async cronTick(): Promise<Record<string, unknown>> {
		// (a) Was the alarm actually scheduled? Observe BEFORE we touch it.
		const existingAlarm = await this.state.storage.getAlarm();
		const alarmWasScheduled = existingAlarm !== null;
		if (!alarmWasScheduled) {
			await this.scheduleAlarm();
		}

		const before = await this.readSyncState();
		const prevSeen = ((await this.state.storage.get("cronLastSeenBlock")) as number) || 0;
		const advanced = before.lastBlock > prevSeen;

		// Live head so the gap is truthful even when the D1 current_block is frozen.
		let liveHead = 0;
		try {
			liveHead = await getCurrentBlock(this.env);
		} catch {
			/* head unknown */
		}
		const gap = liveHead > 0 ? liveHead - before.lastBlock : 0;

		// (c) Force a tick if the cursor is frozen (not advanced since last cron) and
		//     a real gap remains. prevSeen>0 avoids forcing on the very first cron.
		let forcedTick = false;
		if (prevSeen > 0 && !advanced && gap > CRON_FORCE_GAP) {
			forcedTick = true;
			try {
				await this.runSync();
			} catch (e) {
				console.error("[SyncCoordinator] cron forced tick failed:", e);
			}
		}

		const after = await this.readSyncState();
		await this.state.storage.put("cronLastSeenBlock", after.lastBlock);

		const lastSyncAgeSeconds = after.lastSyncTs
			? Math.floor((Date.now() - Date.parse(after.lastSyncTs)) / 1000)
			: null;

		return {
			alarmWasScheduled,
			forcedTick,
			advanced,
			syncedBlock: after.lastBlock,
			liveHead,
			blocksBehind: liveHead > 0 ? liveHead - after.lastBlock : null,
			lastSyncAgeSeconds,
		};
	}

	private async runSync(): Promise<Record<string, unknown>> {
		const startTime = Date.now();

		try {
			const syncCount = ((await this.state.storage.get("syncCount")) as number) || 0;
			// Builder every 2nd tick (~10s) so steady-state freshness stays well under
			// 60s. The builder cursor is gap-proof (never advances past unread blocks)
			// and internally chunks a backlog, so a stale cursor heals in one or two
			// ticks rather than drifting.
			const runBuilder = syncCount % 2 === 0;
			const runEconomics = syncCount % 12 === 0;

			const promises: [Promise<unknown>, Promise<unknown>, Promise<unknown>] = [
				sync(this.env),
				runBuilder ? syncBuilderEvents(this.env) : Promise.resolve(null),
				runEconomics ? syncEconomics(this.env) : Promise.resolve(null),
			];

			const [computeResult, builderResult, _econResult] =
				await Promise.allSettled(promises);

			const result =
				computeResult.status === "fulfilled"
					? (computeResult.value as Record<string, unknown>)
					: { errors: [String((computeResult as PromiseRejectedResult).reason)] };
			const builderRes =
				builderResult.status === "fulfilled" ? builderResult.value : null;
			if (builderResult.status === "rejected")
				console.error("[SyncCoordinator] Builder failed:", builderResult.reason);

			const nextSyncCount = syncCount + 1;
			await this.state.storage.put("syncCount", nextSyncCount);
			// Watchdog heartbeat: the loop reached a completed tick. If this stops
			// advancing, the alarm() watchdog and /health both flag the stall.
			await this.state.storage.put("lastTickMs", Date.now());
			await this.state.storage.put("lastSync", {
				timestamp: new Date().toISOString(),
				result,
				builderResult: builderRes,
				durationMs: Date.now() - startTime,
			});

			if (computeResult.status === "fulfilled") {
				const r2 = result as Record<string, unknown>;
				const dataChanged = ((r2.blocksProcessed as number) || 0) > 0;
				const lastWarm = ((await this.state.storage.get("lastWarmWrite")) as number) || 0;
				const stale = Date.now() - lastWarm > 25000;
				if (dataChanged || stale) {
					try {
						const HEADERS: Record<string, string> = {
							"Content-Type": "application/json",
							"Access-Control-Allow-Origin": "*",
						};
						const allResponse = await handleAll(this.env, HEADERS);
						const body = await allResponse.text();
						await warmKvCache(this.env, "v1:all", body, 30);
						await this.state.storage.put("lastWarmWrite", Date.now());
					} catch (e) {
						console.error(
							"[SyncCoordinator] KV warm failed:",
							e instanceof Error ? e.message : e,
						);
					}

					const lastAnalytics =
						((await this.state.storage.get("lastAnalyticsWarm")) as number) || 0;
					if (Date.now() - lastAnalytics > 600_000) {
						try {
							const H: Record<string, string> = {
								"Content-Type": "application/json",
								"Access-Control-Allow-Origin": "*",
							};
							const [daily, prices, leaders, demand] = await Promise.all([
								handleDailySessions(this.env, H).then((r) => r.text()),
								handlePriceChart(this.env, H, 90).then((r) => r.text()),
								handleLeaderboard(
									this.env,
									H,
									new URL("https://internal/mor/v1/leaderboard"),
								).then((r) => r.text()),
								handleModelDemand(this.env, H).then((r) => r.text()),
							]);
							await Promise.all([
								warmKvCache(this.env, "v1:sessions:daily", daily, 660),
								warmKvCache(this.env, "v1:price:chart:90", prices, 660),
								warmKvCache(this.env, "v1:leaderboard:", leaders, 660),
								warmKvCache(this.env, "v1:models:demand", demand, 660),
							]);
							await this.state.storage.put("lastAnalyticsWarm", Date.now());
							console.log("[SyncCoordinator] Analytics KV warmed");
						} catch (e) {
							console.error(
								"[SyncCoordinator] Analytics warm failed:",
								e instanceof Error ? e.message : e,
							);
						}
					}
				}
			}

			const r = result as Record<string, unknown>;
			const computeLabel =
				computeResult.status === "fulfilled"
					? `+${r.sessionsOpened || 0} opened, +${r.sessionsClosed || 0} closed, ${r.blocksProcessed || 0} blocks${r.diamondCuts ? ` ⚠ ${r.diamondCuts} DIAMOND UPGRADE(S)` : ""}`
					: "FAILED";
			const builderLabel =
				builderResult.status === "fulfilled" && builderRes
					? `${(builderRes as Record<string, unknown>).deposited} deposits`
					: builderResult.status === "rejected"
						? "FAILED"
						: "skipped";

			console.log(
				`[SyncCoordinator] #${nextSyncCount}: Compute(${computeLabel}) Builder(${builderLabel}) ${Date.now() - startTime}ms`,
			);

			return {
				success: computeResult.status === "fulfilled",
				syncCount: nextSyncCount,
				...r,
				builder: builderRes,
			};
		} catch (e: unknown) {
			console.error("[SyncCoordinator] Sync error:", e);
			return {
				success: false,
				error: e instanceof Error ? e.message : String(e),
				durationMs: Date.now() - startTime,
			};
		}
	}
}
