/**
 * MorScan Alerting - self-contained, OSS-configurable operational alerts.
 *
 * Two jobs:
 *   1. notifyAlert() - record an alert to the D1 `alerts` table ALWAYS, then
 *      fan out to whichever notification channels the operator configured via
 *      env vars (Telegram, Slack, Discord, generic webhook). Every channel is
 *      optional and best-effort: a failing (or unset) channel never throws and
 *      never blocks the caller or the cron.
 *   2. runAlertDetection() - called from the minute cron with the sync
 *      watchdog's health signal. It compares the current health against the
 *      last-known state (persisted in sync_state under 'alert_state') and fires
 *      an alert ONLY on a state transition, so the operator is paged once per
 *      event, not every tick.
 *
 * Design principle: fully generic. A fresh clone with NO config still works -
 * alerts are recorded to the admin area at /admin/alerts. No DRM3-specific
 * hardcoding; any operator plugs in their own channel purely via env vars.
 */

import { getSyncStateValue, insertAlert, upsertSyncStateValue } from "../db/ops";
import type { Env } from "../types";

export type AlertLevel = "info" | "warning" | "critical";

export interface AlertInput {
	level: AlertLevel;
	kind: string;
	message: string;
}

export interface ChannelResult {
	channel: "telegram" | "slack" | "discord" | "webhook";
	configured: boolean;
	ok: boolean;
	status?: number;
	error?: string;
}

export interface NotifyResult {
	id: number | null;
	recorded: boolean;
	channels: ChannelResult[];
}

/** Default staleness before the sync watchdog is considered stalled (seconds). */
const DEFAULT_STALL_SECONDS = 120;

/** Per-channel network timeout (ms). Best-effort; a slow channel never hangs the cron. */
const CHANNEL_TIMEOUT_MS = 8000;

/** Level -> a plain emoji marker for chat channels. */
function levelEmoji(level: AlertLevel): string {
	if (level === "critical") return "\u{1F534}"; // red circle
	if (level === "warning") return "\u{1F7E1}"; // yellow circle
	return "\u{1F7E2}"; // green circle
}

/** Resolve the operator host label for messages (no request context in cron). */
export function alertHost(env: Env, override?: string): string {
	if (override) return override;
	const base = env.PUBLIC_BASE_URL || "";
	try {
		if (base) return new URL(base).host;
	} catch {
		/* fall through */
	}
	return "morscan";
}

/** Which channels does the current env have configured? Values are never returned. */
export function configuredChannels(
	env: Env,
): Record<"telegram" | "slack" | "discord" | "webhook", boolean> {
	return {
		telegram: Boolean(env.ALERT_TELEGRAM_BOT_TOKEN && env.ALERT_TELEGRAM_CHAT_ID),
		slack: Boolean(env.ALERT_SLACK_WEBHOOK_URL),
		discord: Boolean(env.ALERT_DISCORD_WEBHOOK_URL),
		webhook: Boolean(env.ALERT_WEBHOOK_URL),
	};
}

/** Human-readable multi-line body shared by the chat channels. */
function formatChatMessage(input: AlertInput, host: string, ts: number): string {
	const iso = new Date(ts).toISOString();
	return [
		`${levelEmoji(input.level)} MorScan ${input.level.toUpperCase()}`,
		`kind: ${input.kind}`,
		input.message,
		`host: ${host}`,
		`time: ${iso}`,
	].join("\n");
}

async function postJson(url: string, body: unknown): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
	});
}

async function sendTelegram(env: Env, text: string): Promise<ChannelResult> {
	const base: ChannelResult = { channel: "telegram", configured: true, ok: false };
	try {
		const url = `https://api.telegram.org/bot${env.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`;
		const r = await postJson(url, {
			chat_id: env.ALERT_TELEGRAM_CHAT_ID,
			text,
			disable_web_page_preview: true,
		});
		return { ...base, ok: r.ok, status: r.status };
	} catch (e) {
		return { ...base, error: e instanceof Error ? e.message : String(e) };
	}
}

async function sendSlack(env: Env, text: string): Promise<ChannelResult> {
	const base: ChannelResult = { channel: "slack", configured: true, ok: false };
	try {
		const r = await postJson(env.ALERT_SLACK_WEBHOOK_URL as string, { text });
		return { ...base, ok: r.ok, status: r.status };
	} catch (e) {
		return { ...base, error: e instanceof Error ? e.message : String(e) };
	}
}

async function sendDiscord(env: Env, text: string): Promise<ChannelResult> {
	const base: ChannelResult = { channel: "discord", configured: true, ok: false };
	try {
		const r = await postJson(env.ALERT_DISCORD_WEBHOOK_URL as string, { content: text });
		return { ...base, ok: r.ok, status: r.status };
	} catch (e) {
		return { ...base, error: e instanceof Error ? e.message : String(e) };
	}
}

async function sendWebhook(
	env: Env,
	payload: Record<string, unknown>,
): Promise<ChannelResult> {
	const base: ChannelResult = { channel: "webhook", configured: true, ok: false };
	try {
		const r = await postJson(env.ALERT_WEBHOOK_URL as string, payload);
		return { ...base, ok: r.ok, status: r.status };
	} catch (e) {
		return { ...base, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Insert the alert row. Best-effort: a D1 failure is logged, never thrown. */
async function recordAlert(
	env: Env,
	input: AlertInput,
	ts: number,
): Promise<number | null> {
	try {
		const res = await insertAlert(env.DB, ts, input.level, input.kind, input.message);
		const id = (res.meta as { last_row_id?: number } | undefined)?.last_row_id;
		return typeof id === "number" ? id : null;
	} catch (e) {
		console.error("[alerts] recordAlert failed:", e);
		return null;
	}
}

/**
 * Record an alert and fan out to every configured channel.
 *
 * Recording to D1 always happens (and is awaited). Channel fan-out is
 * best-effort:
 *   - opts.awaitChannels true  -> await all sends and return their statuses
 *     (used by the admin "test alert" button so the operator sees the result).
 *   - opts.ctx provided        -> sends run in ctx.waitUntil (used by the cron
 *     so a slow channel never delays the tick). Returned channels reflect
 *     which were attempted, ok defaults false (fire-and-forget).
 */
export async function notifyAlert(
	env: Env,
	input: AlertInput,
	opts: { awaitChannels?: boolean; ctx?: ExecutionContext; host?: string } = {},
): Promise<NotifyResult> {
	const ts = Date.now();
	const id = await recordAlert(env, input, ts);
	const recorded = id !== null;

	const host = alertHost(env, opts.host);
	const text = formatChatMessage(input, host, ts);
	const cfg = configuredChannels(env);
	const webhookPayload = {
		level: input.level,
		kind: input.kind,
		message: input.message,
		ts,
		host,
	};

	const senders: Array<Promise<ChannelResult>> = [];
	if (cfg.telegram) senders.push(sendTelegram(env, text));
	if (cfg.slack) senders.push(sendSlack(env, text));
	if (cfg.discord) senders.push(sendDiscord(env, text));
	if (cfg.webhook) senders.push(sendWebhook(env, webhookPayload));

	if (opts.awaitChannels) {
		const channels = await Promise.all(senders);
		return { id, recorded, channels };
	}

	// Fire-and-forget: never block the caller (the cron) on channel latency.
	const all = Promise.all(senders).then((results) => {
		for (const r of results) {
			if (!r.ok)
				console.warn(
					`[alerts] channel ${r.channel} send failed`,
					r.status ?? "",
					r.error ?? "",
				);
		}
	});
	if (opts.ctx) opts.ctx.waitUntil(all);
	else void all;

	// Attempted (not-yet-resolved) channel list for the caller's awareness.
	const attempted: ChannelResult[] = [];
	if (cfg.telegram) attempted.push({ channel: "telegram", configured: true, ok: false });
	if (cfg.slack) attempted.push({ channel: "slack", configured: true, ok: false });
	if (cfg.discord) attempted.push({ channel: "discord", configured: true, ok: false });
	if (cfg.webhook) attempted.push({ channel: "webhook", configured: true, ok: false });
	return { id, recorded, channels: attempted };
}

// ─── Detection (state-transition, deduped) ───────────────────────────────────

/** The health signal the minute cron already computes from the DO watchdog. */
export interface CronHealth {
	lastSyncAgeSeconds: number | null;
	liveHead: number | null;
	syncedBlock: number | null;
	blocksBehind: number | null;
}

interface AlertState {
	stalled: boolean;
	rpcFailing: boolean;
}

const ALERT_STATE_KEY = "alert_state";

async function loadAlertState(env: Env): Promise<AlertState> {
	try {
		const row = await getSyncStateValue(env.DB, ALERT_STATE_KEY);
		if (row?.value) {
			const parsed = JSON.parse(row.value) as Partial<AlertState>;
			return { stalled: Boolean(parsed.stalled), rpcFailing: Boolean(parsed.rpcFailing) };
		}
	} catch (e) {
		console.error("[alerts] loadAlertState failed:", e);
	}
	// No prior state: baseline healthy so we only fire on a real transition.
	return { stalled: false, rpcFailing: false };
}

async function saveAlertState(env: Env, state: AlertState): Promise<void> {
	try {
		await upsertSyncStateValue(env.DB, ALERT_STATE_KEY, JSON.stringify(state));
	} catch (e) {
		console.error("[alerts] saveAlertState failed:", e);
	}
}

function stallThreshold(env: Env): number {
	const raw = env.ALERT_SYNC_STALL_SECONDS;
	const n = raw ? parseInt(raw, 10) : NaN;
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_SECONDS;
}

/**
 * Compare current health with the last-known state and fire an alert on each
 * transition. Fires at most one alert per changed signal per tick.
 *
 * Triggers:
 *   - sync_stall (critical): lastSyncAge crosses above the stall threshold.
 *   - sync_recovered (info): sync is fresh again after having been stalled.
 *   - rpc_failing (warning): the watchdog's live chain-head read returned
 *     nothing (liveHead === 0), i.e. the RPC pool could not reach any endpoint.
 *   - rpc_recovered (info): the head read succeeds again.
 *
 * NOTE on the RPC signal: MorScan's sync layer does not surface a single clean
 * "all endpoints failing" boolean, so we use the cron watchdog's own liveHead
 * read as the proxy - liveHead === 0 means getCurrentBlock() threw across the
 * RPC pool + fallback. A one-tick blip self-clears on the next minute (which
 * fires rpc_recovered). This is a best-effort heuristic, documented as such.
 */
export async function runAlertDetection(
	env: Env,
	health: CronHealth,
	ctx?: ExecutionContext,
): Promise<void> {
	const prev = await loadAlertState(env);
	const threshold = stallThreshold(env);

	const age = health.lastSyncAgeSeconds;
	const stalled = typeof age === "number" && age > threshold;
	// liveHead of 0 means the head read failed across all endpoints (no real
	// chain head is 0). null (signal absent) is treated as not-failing.
	const rpcFailing = health.liveHead === 0;

	const host = alertHost(env);

	if (!prev.stalled && stalled) {
		const behind =
			health.blocksBehind != null
				? `${health.blocksBehind} blocks behind head`
				: "head unknown";
		await notifyAlert(
			env,
			{
				level: "critical",
				kind: "sync_stall",
				message: `Sync stalled: no advance for ${age}s (threshold ${threshold}s). Synced block ${health.syncedBlock ?? "?"}, ${behind}.`,
			},
			{ ctx, host },
		);
	} else if (prev.stalled && !stalled) {
		await notifyAlert(
			env,
			{
				level: "info",
				kind: "sync_recovered",
				message: `Sync recovered: fresh again (last sync ${age ?? "?"}s ago, synced block ${health.syncedBlock ?? "?"}).`,
			},
			{ ctx, host },
		);
	}

	if (!prev.rpcFailing && rpcFailing) {
		await notifyAlert(
			env,
			{
				level: "warning",
				kind: "rpc_failing",
				message:
					"RPC failing: the chain-head read returned no result across all configured endpoints (RPC pool + fallback).",
			},
			{ ctx, host },
		);
	} else if (prev.rpcFailing && !rpcFailing) {
		await notifyAlert(
			env,
			{
				level: "info",
				kind: "rpc_recovered",
				message: `RPC recovered: chain-head read succeeding again (head ${health.liveHead ?? "?"}).`,
			},
			{ ctx, host },
		);
	}

	const next: AlertState = { stalled, rpcFailing };
	if (next.stalled !== prev.stalled || next.rpcFailing !== prev.rpcFailing) {
		await saveAlertState(env, next);
	}
}
