/**
 * Market tape - the scrolling network pulse across the top of every
 * unified-header page.
 *
 * A mixed tape, not a price list: MOR price, live bid/model counts, MOR
 * staked in sessions, the latest session, the most active provider (by
 * endpoint domain), builder TVL, the gold/silver/bronze builder subnets,
 * the freshest subnet deposits, the top consumer, and the newest models.
 * Every number comes from the same D1/KV state the pages themselves render;
 * items whose data is missing simply drop off the tape.
 *
 * SSR'd into the page via the <!--MKT_TICKER--> slot in layout.mustache and
 * filled centrally in routes/ui.ts cachedPage(). PRECOMPUTE MODEL (same as
 * utils/metrics.ts): the D1 batch runs ONLY in the per-minute cron
 * (refreshTickerData, wired next to refreshNetworkMetrics); the request path
 * reads the KV summary - zero D1 rows per page render. Cold summary (fresh
 * deploy / cron outage) computes once and repopulates. Styles live in
 * layout.mustache (.mkt-*).
 */

import type { Env } from "../types";
import { getNetworkMetrics } from "../utils/metrics";
import { getSyncStateTokenPrices } from "../db/explorer-market";

export const TICKER_SLOT = "<!--MKT_TICKER-->";

export interface TickerItem {
	icon: string; // emoji, decorative
	label: string; // small muted prefix ("" to omit)
	value: string; // the bold linked text
	href: string;
	sub?: string; // muted suffix (amount, count, time-ago)
	deltaPct?: number; // colored +/-% (price-style items)
	newTag?: boolean; // green NEW chip
}

/** Raw tape inputs, one field per D1/KV read. Split from the fetch so the
 * shaping + formatting below is pure and unit-testable. */
export interface TickerData {
	nowSec: number;
	price: { usd: number; change24h: number } | null;
	morStaked: number | null;
	liveBids: { bids: number; models: number } | null;
	lastSession: { modelName: string | null; modelId: string; openedAt: number } | null;
	topProvider: { address: string; endpoint: string | null; sessions: number } | null;
	builderTvlMor: number | null;
	topSubnets: { subnetId: string; name: string | null; depositedMor: number }[];
	recentDeposits: {
		subnetId: string;
		name: string | null;
		amountMor: number;
		ts: number;
	}[];
	topConsumer: { wallet: string; sessions: number } | null;
	newestModels: { modelId: string; name: string | null; createdAt: number }[];
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Compact MOR amount: 1.53M, 12.4K, 842, 0.42. */
export function fmtMor(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
	if (n >= 100) return Math.round(n).toLocaleString("en-US");
	if (n >= 1) return n.toFixed(1);
	return n.toFixed(2);
}

/** Short relative age: 42s, 7m, 3h, 2d. */
export function fmtAgo(nowSec: number, tsSec: number): string {
	const s = Math.max(0, nowSec - tsSec);
	if (s < 90) return `${s}s`;
	if (s < 5400) return `${Math.round(s / 60)}m`;
	if (s < 129600) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
}

/** Hostname out of a provider endpoint ("https://gpu.host.io:3333/x" ->
 * "gpu.host.io"). Falls back to a short 0x address when there is no domain. */
export function providerDomain(endpoint: string | null, address: string): string {
	const host = (endpoint || "")
		.replace(/^[a-z]+:\/\//i, "")
		.split("/")[0]
		.split(":")[0]
		.trim()
		.toLowerCase();
	// A bare IP or empty host reads worse than the address.
	if (!host || /^[\d.]+$/.test(host)) return `${address.slice(0, 6)}…${address.slice(-4)}`;
	return host;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const shortId = (id: string) => `${id.slice(0, 10)}…`;

/** Shape the raw reads into tape items. Pure; missing data drops the item. */
export function buildTickerItems(d: TickerData): TickerItem[] {
	const items: TickerItem[] = [];

	if (d.price && d.price.usd > 0) {
		items.push({
			icon: "🪙",
			label: "MOR",
			value: `$${d.price.usd.toFixed(2)}`,
			href: "/analytics/overview",
			deltaPct: d.price.change24h || 0,
		});
	}
	if (d.liveBids && d.liveBids.bids > 0) {
		items.push({
			icon: "📊",
			label: "market",
			value: `${d.liveBids.bids} bids`,
			sub: `${d.liveBids.models} models`,
			href: "/compute/network",
		});
	}
	if (d.morStaked && d.morStaked > 0) {
		items.push({
			icon: "🔒",
			label: "staked",
			value: `${fmtMor(d.morStaked)} MOR`,
			sub: "in sessions",
			href: "/pools",
		});
	}
	if (d.lastSession) {
		items.push({
			icon: "⚡",
			label: "last session",
			value: d.lastSession.modelName || shortId(d.lastSession.modelId),
			sub: `${fmtAgo(d.nowSec, d.lastSession.openedAt)} ago`,
			href: "/compute/sessions",
		});
	}
	if (d.topProvider) {
		items.push({
			icon: "📡",
			label: "top provider",
			value: providerDomain(d.topProvider.endpoint, d.topProvider.address),
			sub: `${d.topProvider.sessions.toLocaleString("en-US")} sessions`,
			href: `/compute/providers/${d.topProvider.address}`,
		});
	}
	if (d.builderTvlMor && d.builderTvlMor > 0) {
		items.push({
			icon: "🔨",
			label: "builder staked",
			value: `${fmtMor(d.builderTvlMor)} MOR`,
			href: "/builder/subnets",
		});
	}
	const medals = ["🥇", "🥈", "🥉"];
	d.topSubnets.slice(0, 3).forEach((s, i) => {
		items.push({
			icon: medals[i],
			label: "",
			value: s.name || shortId(s.subnetId),
			sub: `${fmtMor(s.depositedMor)} MOR`,
			href: `/builder/subnet/${s.subnetId}`,
		});
	});
	for (const dep of d.recentDeposits) {
		items.push({
			icon: "💰",
			label: "funded",
			value: dep.name || shortId(dep.subnetId),
			sub: `+${fmtMor(dep.amountMor)} MOR · ${fmtAgo(d.nowSec, dep.ts)} ago`,
			href: `/builder/subnet/${dep.subnetId}`,
		});
	}
	if (d.topConsumer) {
		items.push({
			icon: "👑",
			label: "top consumer",
			value: shortAddr(d.topConsumer.wallet),
			sub: `${d.topConsumer.sessions.toLocaleString("en-US")} sessions`,
			href: `/compute/consumers/wallet/${d.topConsumer.wallet}`,
		});
	}
	for (const m of d.newestModels) {
		items.push({
			icon: "✨",
			label: "new model",
			value: m.name || shortId(m.modelId),
			href: "/compute/network",
			newTag: true,
		});
	}
	return items;
}

export function renderTicker(items: TickerItem[]): string {
	if (items.length === 0) return "";
	const ticks = items
		.map((t) => {
			const label = t.label ? `<span class="mkt-lb">${esc(t.label)}</span>` : "";
			const sub = t.sub ? `<span class="mkt-p">${esc(t.sub)}</span>` : "";
			const delta =
				t.deltaPct !== undefined
					? `<span class="mkt-chg ${t.deltaPct > 0.05 ? "up" : t.deltaPct < -0.05 ? "down" : "flat"}">${t.deltaPct > 0 ? "+" : ""}${t.deltaPct.toFixed(1)}%</span>`
					: "";
			const tag = t.newTag ? '<span class="mkt-new">new</span>' : "";
			return `<span class="mkt-item"><span class="mkt-ic" aria-hidden="true">${t.icon}</span>${label}<a href="${esc(t.href)}">${esc(t.value)}</a>${sub}${delta}${tag}</span>`;
		})
		.join("");
	// A short tape leaves a visible gap in the loop: repeat the items until one
	// half is comfortably wider than any viewport, then duplicate that half so
	// the -50% translate loops seamlessly. The clone is aria-hidden.
	const reps = Math.max(1, Math.ceil(12 / items.length));
	const half = `<span class="mkt-half">${ticks.repeat(reps)}</span>`;
	return `<div class="mkt-ticker" role="marquee" aria-label="Morpheus network pulse"><div class="mkt-track">${half}${half.replace('class="mkt-half"', 'class="mkt-half" aria-hidden="true"')}</div></div>`;
}

interface PriceCacheShape {
	mor?: { usd?: number; change24h?: number };
	usd?: number;
	change24h?: number;
}

const TICKER_CACHE_KEY = "ticker:data";
// The cron refreshes every 60s; tolerate a few missed ticks before the
// request path falls back to a live compute (mirrors METRICS_MAX_AGE_MS).
const TICKER_MAX_AGE_MS = 5 * 60_000;

interface TickerCacheEntry {
	cachedAt: number;
	data: TickerData;
}

/** Gather the tape's reads: one D1 batch + the KV metrics summary + the
 * cached price row. CRON PATH only (plus the cold-start fallback below).
 * Any individual failure just drops its items. */
async function computeTickerData(env: Env): Promise<TickerData> {
	const nowSec = Math.floor(Date.now() / 1000);
	const d: TickerData = {
		nowSec,
		price: null,
		morStaked: null,
		liveBids: null,
		lastSession: null,
		topProvider: null,
		builderTvlMor: null,
		topSubnets: [],
		recentDeposits: [],
		topConsumer: null,
		newestModels: [],
	};

	// KV metrics summary (same canonical numbers as the stat bar).
	try {
		const m = await getNetworkMetrics(env);
		d.morStaked = m.morStaked;
	} catch {}

	// Cached MOR price (same sync_state row the header reads).
	try {
		const row = await getSyncStateTokenPrices(env.DB);
		if (row) {
			const c: PriceCacheShape = JSON.parse(row.value);
			const usd = c.mor?.usd ?? c.usd ?? 0;
			if (usd > 0)
				d.price = { usd, change24h: c.mor?.change24h ?? c.change24h ?? 0 };
		}
	} catch {}

	// One batch, one round trip for everything else.
	try {
		const wk = nowSec - 7 * 86400;
		const res = await env.DB.batch([
			env.DB.prepare(
				`SELECT COUNT(*) as bids, COUNT(DISTINCT model_id) as models
         FROM bids WHERE (deleted_at = 0 OR deleted_at IS NULL) AND model_id != ''`,
			),
			env.DB.prepare(
				`SELECT s.model_id, s.opened_at, m.name FROM sessions s
         LEFT JOIN models m ON m.model_id = s.model_id
         ORDER BY s.opened_at DESC LIMIT 1`,
			),
			env.DB.prepare(
				`SELECT ps.provider, SUM(ps.total_sessions) as sessions, p.endpoint
         FROM provider_stats ps LEFT JOIN providers p ON p.address = ps.provider
         GROUP BY ps.provider ORDER BY sessions DESC LIMIT 1`,
			),
			env.DB.prepare(
				`SELECT SUM(CAST(total_deposited AS REAL)) as tvl FROM builder_subnets`,
			),
			env.DB.prepare(
				`SELECT subnet_id, name, metadata_name, CAST(total_deposited AS REAL) as dep
         FROM builder_subnets ORDER BY dep DESC LIMIT 3`,
			),
			env.DB.prepare(
				`SELECT e.subnet_id, CAST(e.amount AS REAL) as amt, e.block_timestamp as ts,
                b.name, b.metadata_name
         FROM builder_events e LEFT JOIN builder_subnets b ON b.subnet_id = e.subnet_id
         WHERE e.event_type = 'deposit' AND e.block_timestamp >= ?1
         ORDER BY e.block_timestamp DESC LIMIT 2`,
			).bind(wk),
			env.DB.prepare(
				`SELECT wallet, total_sessions FROM wallet_stats
         ORDER BY total_sessions DESC LIMIT 1`,
			),
			env.DB.prepare(
				`SELECT model_id, name, created_at FROM models
         WHERE name IS NOT NULL AND name != '' ORDER BY created_at DESC LIMIT 2`,
			),
		]);
		type Row = Record<string, unknown>;
		const [bids, sess, prov, tvl, subs, deps, cons, mods] = res.map(
			(r) => (r.results ?? []) as Row[],
		);
		if (bids[0] && Number(bids[0].bids) > 0)
			d.liveBids = { bids: Number(bids[0].bids), models: Number(bids[0].models) };
		if (sess[0])
			d.lastSession = {
				modelId: String(sess[0].model_id),
				modelName: (sess[0].name as string) || null,
				openedAt: Number(sess[0].opened_at),
			};
		if (prov[0] && Number(prov[0].sessions) > 0)
			d.topProvider = {
				address: String(prov[0].provider),
				endpoint: (prov[0].endpoint as string) || null,
				sessions: Number(prov[0].sessions),
			};
		if (tvl[0]?.tvl) d.builderTvlMor = Number(tvl[0].tvl) / 1e18;
		d.topSubnets = subs
			.filter((s) => Number(s.dep) > 0)
			.map((s) => ({
				subnetId: String(s.subnet_id),
				name: ((s.name as string) || (s.metadata_name as string) || null)?.trim() || null,
				depositedMor: Number(s.dep) / 1e18,
			}));
		d.recentDeposits = deps.map((e) => ({
			subnetId: String(e.subnet_id),
			name: ((e.name as string) || (e.metadata_name as string) || null)?.trim() || null,
			amountMor: Number(e.amt) / 1e18,
			ts: Number(e.ts),
		}));
		if (cons[0] && Number(cons[0].total_sessions) > 0)
			d.topConsumer = {
				wallet: String(cons[0].wallet),
				sessions: Number(cons[0].total_sessions),
			};
		d.newestModels = mods.map((m) => ({
			modelId: String(m.model_id),
			name: (m.name as string) || null,
			createdAt: Number(m.created_at),
		}));
	} catch {}

	return d;
}

/**
 * CRON PATH write. Runs the tape's D1 batch, stores the result in the shared
 * KV summary. Called once per minute from the scheduled handler (see
 * providers/compose.ts, next to refreshNetworkMetrics); also the request-path
 * cold-start fallback below.
 */
export async function refreshTickerData(env: Env): Promise<TickerData> {
	const data = await computeTickerData(env);
	const kv = env.MORSCAN_CACHE;
	if (kv) {
		try {
			const entry: TickerCacheEntry = { cachedAt: Date.now(), data };
			// Outlive TICKER_MAX_AGE_MS so a brief cron outage serves slightly
			// stale tape instead of forcing request-path D1 reads; self-heals.
			await kv.put(TICKER_CACHE_KEY, JSON.stringify(entry), { expirationTtl: 600 });
		} catch {
			// KV write failures are non-fatal.
		}
	}
	return data;
}

/** HOT PATH read: the precomputed tape data from KV, zero D1 rows. Only a
 * missing/stale summary (cold start, cron outage) computes once. */
async function getTickerData(env: Env): Promise<TickerData> {
	const kv = env.MORSCAN_CACHE;
	if (kv) {
		try {
			const raw = await kv.get(TICKER_CACHE_KEY);
			if (raw !== null) {
				const entry: TickerCacheEntry = JSON.parse(raw);
				if (Date.now() - entry.cachedAt < TICKER_MAX_AGE_MS) return entry.data;
			}
		} catch {
			// Corrupted/missing entry - fall through to a fresh compute.
		}
	}
	return refreshTickerData(env);
}

/** Build the tape HTML. Never throws: any failure or an empty network
 * renders nothing (the layout slot simply disappears). */
export async function marketTickerHtml(env: Env): Promise<string> {
	try {
		const data = await getTickerData(env);
		// Relative ages ("2m ago") are computed against render time, not the
		// cron tick that captured the data.
		data.nowSec = Math.floor(Date.now() / 1000);
		return renderTicker(buildTickerItems(data));
	} catch {
		return "";
	}
}
