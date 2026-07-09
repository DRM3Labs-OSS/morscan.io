/**
 * Token Price Handler - MOR + ETH
 *
 * PRIMARY source is on-chain: MOR/USD is read straight from the Base DEX pool
 * (Uniswap v3 MOR/WETH) via the shared RPC pool, and ETH/USD from a Chainlink
 * feed on Base (see src/utils/onchain-price.ts). This has no external rate
 * limit, unlike CoinGecko - whose per-IP quota our shared Cloudflare Worker
 * egress IPs kept exhausting, leaving the price stale/delayed.
 *
 * change24h is computed from OUR own price_history (recorded from the on-chain
 * read), not CoinGecko. marketCap = circulating supply x live on-chain price,
 * where circulating supply is derived once from the last CoinGecko snapshot and
 * then tracks price on-chain. CoinGecko survives ONLY as a last-resort fallback
 * for the current price if the on-chain read fails, and as the historical chart
 * baseline until we have recorded enough of our own points.
 *
 * Public endpoint - no auth required.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { signResponse } from "../utils/provenance";
import {
	readOnchainPrice,
	recordPriceHistory,
	getChange24hFromHistory,
	type OnchainPrice,
} from "../utils/onchain-price";
import {
	getSyncStateTokenPrices,
	setSyncStateTokenPrices,
	getSyncStateCirculatingSupply,
	setSyncStateCirculatingSupply,
	getSyncStatePriceChart,
	setSyncStatePriceChart,
	getPriceHistorySince,
} from "../db/explorer-market";

async function attachPriceProvenance(
	env: Env,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const mnemonic = signingMnemonic(env);
	if (!mnemonic) return body;
	const receipt = await signResponse(
		"blockchain.price",
		{ endpoint: "/mor/v1/price", source: (body.source as string) || "base-dex" },
		{
			morUsd: body.usd,
			ethUsd: (body.eth as { usd?: number } | undefined)?.usd ?? null,
			fetchedAt: body.fetchedAt,
		},
		mnemonic,
		env.DB,
	);
	if (receipt) body._provenance_aggregate = JSON.parse(receipt);
	return body;
}

const CACHE_TTL_SECONDS = 30;
const COINGECKO_URL =
	"https://api.coingecko.com/api/v3/simple/price?ids=morpheusai,ethereum&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true";

interface PriceCache {
	mor: { usd: number; change24h: number | null; marketCap: number | null };
	eth: { usd: number; change24h: number | null };
	fetchedAt: number;
	source?: string;
}

/**
 * MOR circulating supply, used for marketCap = supply x price. There is no
 * clean on-chain circulating-supply figure (the Base bridged totalSupply and
 * the diamond totalMORSupply both undercount global circulating), so we derive
 * supply once from the last CoinGecko marketCap/price snapshot and cache it;
 * marketCap then tracks the live on-chain price. Refreshed opportunistically
 * whenever the CoinGecko fallback runs. Returns null if we have never seen a
 * snapshot (marketCap is then omitted rather than shown wrong).
 */
async function getMorCirculatingSupply(env: Env): Promise<number | null> {
	try {
		const row = await getSyncStateCirculatingSupply(env.DB);
		if (row) {
			const n = Number(row.value);
			if (Number.isFinite(n) && n > 0) return n;
		}
		// Transition seed: derive from the pre-existing CoinGecko price cache.
		const cached = await getCachedPrice(env, true);
		if (cached?.mor.marketCap && cached.mor.usd > 0) {
			const supply = cached.mor.marketCap / cached.mor.usd;
			await setMorCirculatingSupply(env, supply);
			return supply;
		}
	} catch {}
	return null;
}

async function setMorCirculatingSupply(env: Env, supply: number): Promise<void> {
	if (!(supply > 0)) return;
	try {
		await setSyncStateCirculatingSupply(env.DB, String(Math.round(supply)));
	} catch {}
}

/**
 * Build the PriceCache from a fresh on-chain read: MOR/USD + ETH/USD on-chain,
 * change24h from our price_history, marketCap from cached circulating supply.
 */
async function priceFromOnchain(env: Env, p: OnchainPrice): Promise<PriceCache> {
	const [change24h, supply] = await Promise.all([
		getChange24hFromHistory(env, p.morUsd),
		getMorCirculatingSupply(env),
	]);
	return {
		mor: {
			usd: p.morUsd,
			change24h,
			marketCap: supply ? supply * p.morUsd : null,
		},
		eth: { usd: p.ethUsd, change24h: null },
		fetchedAt: Math.floor(Date.now() / 1000),
		source: "base-dex",
	};
}

async function getCachedPrice(env: Env, stale = false): Promise<PriceCache | null> {
	try {
		const row = await getSyncStateTokenPrices(env.DB);
		if (!row) return null;
		const cached: PriceCache = JSON.parse(row.value);
		const age = Math.floor(Date.now() / 1000) - cached.fetchedAt;
		if (!stale && age > CACHE_TTL_SECONDS) return null;
		return cached;
	} catch {
		return null;
	}
}

async function setCachedPrice(env: Env, price: PriceCache): Promise<void> {
	try {
		await setSyncStateTokenPrices(env.DB, JSON.stringify(price));
	} catch {}
}

async function fetchFromCoinGecko(): Promise<PriceCache | null> {
	try {
		const resp = await fetch(COINGECKO_URL, {
			headers: {
				Accept: "application/json",
				"User-Agent": "MorScan/1.0 (Morpheus Explorer)",
			},
		});
		if (!resp.ok) return null;
		const data = (await resp.json()) as Record<string, Record<string, number>>;
		const mor = data.morpheusai;
		const eth = data.ethereum;
		if (!mor || typeof mor.usd !== "number") return null;
		return {
			mor: {
				usd: mor.usd,
				change24h: mor.usd_24h_change ?? null,
				marketCap: mor.usd_market_cap ?? null,
			},
			eth: {
				usd: eth?.usd ?? 0,
				change24h: eth?.usd_24h_change ?? null,
			},
			fetchedAt: Math.floor(Date.now() / 1000),
			source: "coingecko",
		};
	} catch {
		return null;
	}
}

function priceBody(
	p: PriceCache,
	cached: boolean,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		usd: p.mor.usd,
		change24h: p.mor.change24h,
		marketCap: p.mor.marketCap,
		eth: p.eth,
		cached,
		source: p.source ?? "base-dex",
		fetchedAt: p.fetchedAt,
		...extra,
	};
}

export async function handlePrice(
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	// Serve a fresh cache point (<30s) without re-hitting the chain.
	const cached = await getCachedPrice(env);
	if (cached) {
		const body = priceBody(cached, true);
		try {
			await attachPriceProvenance(env, body);
		} catch {}
		return new Response(JSON.stringify(body), { headers });
	}

	// PRIMARY: read the price straight from the Base DEX pool (no rate limit).
	const onchain = await readOnchainPrice(env);
	if (onchain) {
		const fresh = await priceFromOnchain(env, onchain);
		await setCachedPrice(env, fresh);
		// Opportunistically record our own history point (deduped ~10 min).
		try {
			await recordPriceHistory(env, onchain);
		} catch {}
		const body = priceBody(fresh, false);
		try {
			await attachPriceProvenance(env, body);
		} catch {}
		return new Response(JSON.stringify(body), { headers });
	}

	// FALLBACK: only if the on-chain read failed, try CoinGecko once.
	const fresh = await fetchFromCoinGecko();
	if (fresh) {
		await setCachedPrice(env, fresh);
		if (fresh.mor.marketCap && fresh.mor.usd > 0) {
			await setMorCirculatingSupply(env, fresh.mor.marketCap / fresh.mor.usd);
		}
		const body = priceBody(fresh, false, { source: "coingecko" });
		try {
			await attachPriceProvenance(env, body);
		} catch {}
		return new Response(JSON.stringify(body), { headers });
	}

	// LAST RESORT: serve the last good value, flagged stale.
	const stale = await getCachedPrice(env, true);
	if (stale) {
		const body: Record<string, unknown> = {
			usd: stale.mor.usd,
			change24h: stale.mor.change24h,
			marketCap: stale.mor.marketCap,
			eth: stale.eth,
			cached: true,
			stale: true,
			source: stale.source ?? "base-dex",
			fetchedAt: stale.fetchedAt,
		};
		try {
			await attachPriceProvenance(env, body);
		} catch {}
		return new Response(JSON.stringify(body), { headers });
	}

	return new Response(
		JSON.stringify({
			error: "Price temporarily unavailable",
			usd: 0,
		}),
		{ status: 503, headers },
	);
}

const CHART_CACHE_TTL = 3600; // 1 hour
// Hourly granularity (90 days auto-returns ~hourly points on CoinGecko) so real intraday highs and sustained levels show, not just one 00:00 UTC snapshot per day.
const CHART_URL =
	"https://api.coingecko.com/api/v3/coins/morpheusai/market_chart?vs_currency=usd&days=90";

export async function handleChartSvg(env: Env): Promise<Response> {
	// Render from the same self-owned source as the JSON chart (our own
	// price_history; CoinGecko only for the pre-history tail) so the chart never
	// goes blank just because CoinGecko is rate-limiting.
	const { prices: pts } = await assembleChartPoints(env);
	const prices = pts.map((p) => p.v);

	if (prices.length < 2) {
		return new Response(
			'<svg xmlns="http://www.w3.org/2000/svg" width="420" height="130"/>',
			{
				headers: {
					"Content-Type": "image/svg+xml",
					"Cache-Control": "public, max-age=60",
				},
			},
		);
	}

	const w = 420,
		h = 130,
		padTop = 6,
		padBot = 24;
	const min = Math.min(...prices);
	const max = Math.max(...prices);
	const range = max - min || 1;
	const color = "#22c55e";

	const points = prices
		.map((v, i) => {
			const x = (i / (prices.length - 1)) * w;
			const y = h - padBot - ((v - min) / range) * (h - padTop - padBot);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");

	const lastY =
		h - padBot - ((prices[prices.length - 1] - min) / range) * (h - padTop - padBot);

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="${w}" height="${h}" style="display:block">
<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
<stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
</linearGradient></defs>
<line x1="0" y1="${h * 0.25}" x2="${w}" y2="${h * 0.25}" stroke="#333" stroke-width="0.5" stroke-dasharray="2,4"/>
<line x1="0" y1="${h * 0.5}" x2="${w}" y2="${h * 0.5}" stroke="#333" stroke-width="0.5" stroke-dasharray="2,4"/>
<line x1="0" y1="${h * 0.75}" x2="${w}" y2="${h * 0.75}" stroke="#333" stroke-width="0.5" stroke-dasharray="2,4"/>
<polygon points="0,${h - padBot} ${points} ${w},${h - padBot}" fill="url(#cg)"/>
<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
<circle cx="${w}" cy="${lastY.toFixed(1)}" r="3" fill="${color}"/>
<circle cx="${w}" cy="${lastY.toFixed(1)}" r="6" fill="${color}" opacity="0.2"/>
<text x="6" y="${h - padBot}" font-size="8" fill="#555" font-family="ui-monospace,Menlo,monospace">$${min.toFixed(2)}</text>
<text x="6" y="10" font-size="8" fill="#555" font-family="ui-monospace,Menlo,monospace">$${max.toFixed(2)}</text>
</svg>`;

	return new Response(svg, {
		headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=60" },
	});
}

const DAY_MS = 24 * 3600 * 1000;

// Timeframe windows the price widget offers. price_history now reaches back to
// the MOR/WETH pool's on-chain origin (block 20211651, 2024-09-24), backfilled
// hourly from the same on-chain math the live read uses, so the longer windows
// render real history rather than a flat/empty stretch. "all" uses a horizon
// larger than any possible history so it always spans the whole recorded series
// from the earliest point. Default stays 90d. Each entry has a matching pill in
// src/ui/partials/price-widget.html.
const ALL_TIME_DAYS = 4000; // > any history; effectively "from the first point"
export const CHART_WINDOWS: ReadonlyArray<{ key: string; label: string; days: number }> =
	[
		{ key: "24h", label: "24h", days: 1 },
		{ key: "7d", label: "7d", days: 7 },
		{ key: "30d", label: "30d", days: 30 },
		{ key: "90d", label: "90d", days: 90 },
		{ key: "6mo", label: "6mo", days: 182 },
		{ key: "1yr", label: "1yr", days: 365 },
		{ key: "all", label: "All", days: ALL_TIME_DAYS },
	];
export const DEFAULT_CHART_WINDOW_DAYS = 90;

/** Map a window key (e.g. "7d") to its day count, defaulting to 90d. */
export function chartWindowDays(key: string | null | undefined): number {
	const w = CHART_WINDOWS.find((x) => x.key === key);
	return w ? w.days : DEFAULT_CHART_WINDOW_DAYS;
}

export interface ChartPoint {
	t: number;
	v: number;
}

/** Our own on-chain-recorded points in the window, as {t: ms, v: usd}. */
async function ownChartPoints(env: Env, windowSec: number): Promise<ChartPoint[]> {
	try {
		const cutoff = Math.floor(Date.now() / 1000) - windowSec;
		const rows = await getPriceHistorySince(env.DB, cutoff);
		return rows.map((r) => ({ t: r.ts * 1000, v: Math.round(r.usd * 100) / 100 }));
	} catch {
		return [];
	}
}

/** Read the cached CoinGecko 90-day baseline (mor_price_chart), refreshing it if
 * stale. When allowFetch is false (the OG-card path), never make a live
 * CoinGecko call: serve whatever baseline is cached in D1 so rasterization stays
 * fast and never stalls on an external request. */
async function coingeckoBaseline(env: Env, allowFetch = true): Promise<ChartPoint[]> {
	let cached: { prices: ChartPoint[]; fetchedAt: number } | null = null;
	try {
		const row = await getSyncStatePriceChart(env.DB);
		if (row) cached = JSON.parse(row.value);
	} catch {}
	const age = Math.floor(Date.now() / 1000) - (cached?.fetchedAt || 0);
	if (cached && age < CHART_CACHE_TTL) return cached.prices || [];
	if (!allowFetch) return cached?.prices || [];

	try {
		const resp = await fetch(CHART_URL, {
			headers: {
				Accept: "application/json",
				"User-Agent": "MorScan/1.0 (Morpheus Explorer)",
			},
			signal: AbortSignal.timeout(8000),
		});
		if (!resp.ok) throw new Error(`CoinGecko ${resp.status}`);
		const data = (await resp.json()) as { prices: [number, number][] };
		const prices = (data.prices || []).map((p: [number, number]) => ({
			t: p[0],
			v: Math.round(p[1] * 100) / 100,
		}));
		await setSyncStatePriceChart(
			env.DB,
			JSON.stringify({ prices, fetchedAt: Math.floor(Date.now() / 1000) }),
		);
		return prices;
	} catch {
		return cached?.prices || []; // keep serving the last good baseline
	}
}

/** Assemble the chart points for a given window (days): our own on-chain
 * price_history, with a CoinGecko baseline only for the historical tail before
 * our earliest point. Once our own points reach back to the window start it is
 * fully self-owned (no CoinGecko dependency). Shared by the JSON + SVG chart
 * endpoints and every timeframe pill. */
export async function assembleChartPoints(
	env: Env,
	windowDays: number = DEFAULT_CHART_WINDOW_DAYS,
	allowFetch = true,
): Promise<{ prices: ChartPoint[]; source: string }> {
	const windowMs = windowDays * DAY_MS;
	const windowStartMs = Date.now() - windowMs;
	const own = await ownChartPoints(env, Math.floor(windowMs / 1000));
	const earliestOwnMs = own.length ? own[0].t : Number.POSITIVE_INFINITY;

	// Fully self-owned: our own points reach back to (within a day of) the window
	// start, so they already cover the whole window - no CoinGecko needed.
	if (own.length >= 2 && earliestOwnMs <= windowStartMs + DAY_MS) {
		return { prices: own, source: "price_history" };
	}

	// Transition / short history: CoinGecko baseline for the part of the window
	// older than our earliest owned point, then our own on-chain points forward.
	const baseline = await coingeckoBaseline(env, allowFetch);
	const inWindow = baseline.filter((p) => p.t >= windowStartMs);
	const historical = inWindow.filter((p) => p.t < earliestOwnMs);
	const merged = [...historical, ...own];
	return {
		prices: merged.length ? merged : inWindow,
		source: own.length ? "blended" : "coingecko",
	};
}

export async function handlePriceChart(
	env: Env,
	headers: Record<string, string>,
	windowDays: number = DEFAULT_CHART_WINDOW_DAYS,
): Promise<Response> {
	const { prices, source } = await assembleChartPoints(env, windowDays);
	return new Response(
		JSON.stringify({
			prices,
			windowDays,
			fetchedAt: Math.floor(Date.now() / 1000),
			source,
		}),
		{ headers },
	);
}
