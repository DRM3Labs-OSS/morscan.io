/**
 * Unit tests for the operational alerting module (src/alerts).
 *
 * Covers the parts that are pure or cleanly fakeable:
 *   - configuredChannels(): which channels the env enables (telegram needs BOTH
 *     token + chat id; the others need their one webhook url).
 *   - alertHost(): override wins, else PUBLIC_BASE_URL host, else "morscan".
 *   - notifyAlert(): ALWAYS records a row to the `alerts` table (even with no
 *     channels), returns the row id, and fans out only to configured channels
 *     with the right url + body shape (fetch is stubbed - no real network).
 *   - runAlertDetection(): the deduped state machine - fires ONCE on each
 *     transition (healthy->stalled, stalled->recovered, rpc fail/recover) and
 *     stays silent while the state is unchanged.
 *
 * A tiny inline fake models the exact two sync_state statements and the one
 * alerts INSERT the module issues (see src/db/ops.ts). It is not a SQL engine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	alertHost,
	configuredChannels,
	type CronHealth,
	notifyAlert,
	runAlertDetection,
} from "../../src/alerts/index.ts";
import type { Env } from "../../src/types.ts";

interface AlertRow {
	id: number;
	ts: number;
	level: string;
	kind: string;
	message: string;
}

/** In-memory stand-in for the `alerts` INSERT + the two `sync_state` statements. */
class FakeAlertsD1 {
	readonly alerts: AlertRow[] = [];
	readonly syncState = new Map<string, string>();
	private nextId = 1;

	prepare(sql: string) {
		return new FakeAlertsStmt(sql, this);
	}

	insertAlert(ts: number, level: string, kind: string, message: string): number {
		const id = this.nextId++;
		this.alerts.push({ id, ts, level, kind, message });
		return id;
	}
}

class FakeAlertsStmt {
	private args: unknown[] = [];
	constructor(
		private readonly sql: string,
		private readonly db: FakeAlertsD1,
	) {}

	bind(...args: unknown[]): FakeAlertsStmt {
		this.args = args;
		return this;
	}

	// biome-ignore lint/suspicious/noExplicitAny: mirrors the D1 generic surface
	async first<T = any>(): Promise<T | null> {
		if (this.sql.includes("SELECT value FROM sync_state WHERE key = ?")) {
			const [key] = this.args as string[];
			const value = this.db.syncState.get(key);
			return value === undefined ? null : ({ value } as T);
		}
		throw new Error(`FakeAlertsD1.first: unsupported SQL: ${this.sql.slice(0, 60)}`);
	}

	async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
		if (this.sql.includes("INSERT INTO alerts")) {
			const [ts, level, kind, message] = this.args as [number, string, string, string];
			const id = this.db.insertAlert(ts, level, kind, message);
			return { success: true, meta: { last_row_id: id } };
		}
		if (this.sql.includes("INSERT INTO sync_state")) {
			const [key, value] = this.args as [string, string];
			this.db.syncState.set(key, value);
			return { success: true, meta: { last_row_id: 0 } };
		}
		throw new Error(`FakeAlertsD1.run: unsupported SQL: ${this.sql.slice(0, 60)}`);
	}
}

function makeEnv(over: Partial<Record<string, string>> = {}): { env: Env; db: FakeAlertsD1 } {
	const db = new FakeAlertsD1();
	const env = { DB: db, ...over } as unknown as Env;
	return { env, db };
}

/** Captured fetch calls, so channel fan-out can be asserted without network. */
interface FetchCall {
	url: string;
	body: unknown;
}

describe("configuredChannels", () => {
	it("reports nothing when the env is empty", () => {
		const { env } = makeEnv();
		expect(configuredChannels(env)).toEqual({
			telegram: false,
			slack: false,
			discord: false,
			webhook: false,
		});
	});

	it("requires BOTH telegram token and chat id", () => {
		expect(configuredChannels(makeEnv({ ALERT_TELEGRAM_BOT_TOKEN: "t" }).env).telegram).toBe(
			false,
		);
		expect(configuredChannels(makeEnv({ ALERT_TELEGRAM_CHAT_ID: "c" }).env).telegram).toBe(
			false,
		);
		expect(
			configuredChannels(
				makeEnv({ ALERT_TELEGRAM_BOT_TOKEN: "t", ALERT_TELEGRAM_CHAT_ID: "c" }).env,
			).telegram,
		).toBe(true);
	});

	it("enables slack/discord/webhook each on their single url", () => {
		expect(configuredChannels(makeEnv({ ALERT_SLACK_WEBHOOK_URL: "s" }).env).slack).toBe(true);
		expect(configuredChannels(makeEnv({ ALERT_DISCORD_WEBHOOK_URL: "d" }).env).discord).toBe(
			true,
		);
		expect(configuredChannels(makeEnv({ ALERT_WEBHOOK_URL: "w" }).env).webhook).toBe(true);
	});
});

describe("alertHost", () => {
	it("prefers an explicit override", () => {
		expect(alertHost(makeEnv({ PUBLIC_BASE_URL: "https://a.io" }).env, "override.host")).toBe(
			"override.host",
		);
	});
	it("falls back to the PUBLIC_BASE_URL host", () => {
		expect(alertHost(makeEnv({ PUBLIC_BASE_URL: "https://morscan.io/path" }).env)).toBe(
			"morscan.io",
		);
	});
	it("uses 'morscan' when nothing is set", () => {
		expect(alertHost(makeEnv().env)).toBe("morscan");
	});
});

describe("notifyAlert", () => {
	let calls: FetchCall[];
	beforeEach(() => {
		calls = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { body?: string }) => {
				calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
				return { ok: true, status: 200 } as Response;
			}),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("ALWAYS records the alert row even with no channels configured", async () => {
		const { env, db } = makeEnv();
		const res = await notifyAlert(env, {
			level: "critical",
			kind: "sync_stall",
			message: "no advance",
		});
		expect(res.recorded).toBe(true);
		expect(typeof res.id).toBe("number");
		expect(db.alerts).toHaveLength(1);
		expect(db.alerts[0]).toMatchObject({
			level: "critical",
			kind: "sync_stall",
			message: "no advance",
		});
		expect(db.alerts[0].ts).toBeGreaterThan(0);
		expect(res.channels).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	it("fans out to each configured channel with the right url and body", async () => {
		const { env } = makeEnv({
			ALERT_TELEGRAM_BOT_TOKEN: "BOT",
			ALERT_TELEGRAM_CHAT_ID: "CHAT",
			ALERT_SLACK_WEBHOOK_URL: "https://slack.test/hook",
			ALERT_DISCORD_WEBHOOK_URL: "https://discord.test/hook",
			ALERT_WEBHOOK_URL: "https://generic.test/hook",
			PUBLIC_BASE_URL: "https://morscan.io",
		});
		const res = await notifyAlert(
			env,
			{ level: "warning", kind: "rpc_failing", message: "rpc down" },
			{ awaitChannels: true },
		);
		expect(res.channels.map((c) => c.channel).sort()).toEqual([
			"discord",
			"slack",
			"telegram",
			"webhook",
		]);
		expect(res.channels.every((c) => c.ok)).toBe(true);

		const telegram = calls.find((c) => c.url.includes("api.telegram.org"));
		expect(telegram?.url).toContain("/botBOT/sendMessage");
		expect((telegram?.body as { chat_id: string }).chat_id).toBe("CHAT");
		// Chat channels share a human-readable multi-line body carrying the fields.
		const chatText = (telegram?.body as { text: string }).text;
		expect(chatText).toContain("kind: rpc_failing");
		expect(chatText).toContain("rpc down");
		expect(chatText).toContain("host: morscan.io");
		expect(chatText).toContain("WARNING");

		// The generic webhook gets a STRUCTURED payload, not the chat text.
		const webhook = calls.find((c) => c.url === "https://generic.test/hook");
		expect(webhook?.body).toMatchObject({
			level: "warning",
			kind: "rpc_failing",
			message: "rpc down",
			host: "morscan.io",
		});
		const discord = calls.find((c) => c.url === "https://discord.test/hook");
		expect((discord?.body as { content: string }).content).toContain("kind: rpc_failing");
	});

	it("only sends to channels that are configured", async () => {
		const { env } = makeEnv({ ALERT_SLACK_WEBHOOK_URL: "https://slack.test/hook" });
		const res = await notifyAlert(
			env,
			{ level: "info", kind: "test", message: "hi" },
			{ awaitChannels: true },
		);
		expect(res.channels.map((c) => c.channel)).toEqual(["slack"]);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://slack.test/hook");
	});
});

describe("runAlertDetection - deduped state machine", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 }) as Response));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const healthy: CronHealth = {
		lastSyncAgeSeconds: 10,
		liveHead: 100,
		syncedBlock: 100,
		blocksBehind: 0,
	};
	const stalled: CronHealth = {
		lastSyncAgeSeconds: 999,
		liveHead: 100,
		syncedBlock: 50,
		blocksBehind: 50,
	};

	it("fires nothing when healthy from a clean baseline", async () => {
		const { env, db } = makeEnv();
		await runAlertDetection(env, healthy);
		expect(db.alerts).toHaveLength(0);
	});

	it("fires sync_stall exactly ONCE across repeated stalled ticks (dedup)", async () => {
		const { env, db } = makeEnv();
		await runAlertDetection(env, stalled);
		await runAlertDetection(env, stalled);
		await runAlertDetection(env, stalled);
		const stalls = db.alerts.filter((a) => a.kind === "sync_stall");
		expect(stalls).toHaveLength(1);
		expect(stalls[0].level).toBe("critical");
		expect(stalls[0].message).toContain("50 blocks behind head");
	});

	it("fires sync_recovered once when sync returns to fresh", async () => {
		const { env, db } = makeEnv();
		await runAlertDetection(env, stalled); // -> stall
		await runAlertDetection(env, healthy); // -> recover
		await runAlertDetection(env, healthy); // no re-fire
		expect(db.alerts.map((a) => a.kind)).toEqual(["sync_stall", "sync_recovered"]);
		expect(db.alerts[1].level).toBe("info");
	});

	it("treats liveHead===0 as rpc_failing and recovers on a real head", async () => {
		const { env, db } = makeEnv();
		await runAlertDetection(env, { ...healthy, liveHead: 0 }); // rpc fail
		await runAlertDetection(env, { ...healthy, liveHead: 0 }); // dedup
		await runAlertDetection(env, healthy); // recover
		const kinds = db.alerts.map((a) => a.kind);
		expect(kinds).toEqual(["rpc_failing", "rpc_recovered"]);
		expect(db.alerts[0].level).toBe("warning");
	});

	it("a null liveHead (signal absent) is NOT treated as failing", async () => {
		const { env, db } = makeEnv();
		await runAlertDetection(env, { ...healthy, liveHead: null });
		expect(db.alerts.filter((a) => a.kind === "rpc_failing")).toHaveLength(0);
	});

	it("respects the ALERT_SYNC_STALL_SECONDS threshold override", async () => {
		// age 30s is fresh under the default 120s, but stalled under a 20s override.
		const midAge: CronHealth = { ...healthy, lastSyncAgeSeconds: 30 };
		const def = makeEnv();
		await runAlertDetection(def.env, midAge);
		expect(def.db.alerts).toHaveLength(0);

		const tight = makeEnv({ ALERT_SYNC_STALL_SECONDS: "20" });
		await runAlertDetection(tight.env, midAge);
		expect(tight.db.alerts.filter((a) => a.kind === "sync_stall")).toHaveLength(1);
	});
});
