/**
 * Dynamic per-page OG (Open Graph) share cards.
 *
 * GET /og/<slug>.png  (the .png is optional: /og/<slug> also works)
 *
 * Every shared MorScan link renders a branded 1200x630 card: the MorScan
 * wings + wordmark, a page-specific title and subtitle, and 2-3 LIVE stat
 * chips (MOR price, providers, sessions, holders, staked) pulled from the same
 * canonical D1 sources the UI uses. The card shows the PRODUCT, not just a
 * logo, so a preview makes people click.
 *
 * Rendering is server-side: we build an SVG string per slug (injecting the
 * live stats) and rasterize it to PNG with @resvg/resvg-wasm. The wasm module
 * and two IBM Plex Mono font buffers (Regular + Bold, OFL) are vendored under
 * src/vendor/og and bundled into the worker. The rendered PNG is cached hard
 * in the CF Cache API (keyed by slug), so a card is rasterized at most once per
 * cache window per colo; second hits are a cache HIT.
 *
 * Live stats degrade gracefully: any stat that fails to read is simply dropped
 * from the card, and if rasterization itself fails the caller falls back to the
 * static brand card (see routes/ui.ts).
 */

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { Env } from "../types";
import { getNetworkMetrics } from "../utils/metrics";
import { getSyncStateTokenPrices } from "../db/explorer-market";
import { countDiscoveredHolders } from "../db/explorer-core";
import resvgWasm from "../vendor/og/resvg.wasm";
import monoRegular from "../vendor/og/mono-regular.ttf";
import monoBold from "../vendor/og/mono-bold.ttf";
import { MORSCAN_ICON_SVG } from "./ui/assets";

// ---- Palette ---------------------------------------------------------------
const BG = "#0c0a09";
const GREEN = "#22c55e";
const CYAN = "#22d3ee";
const INK = "#fafaf9";
const MUTE = "#a8a29e";
const FAINT = "#78716c";
const WORDMARK = "#d6d3d1";

// IBM Plex Mono is a fixed-advance font: one glyph is 0.6em wide. That lets us
// lay out variable-width stat chips without measuring text.
const MONO_ADVANCE = 0.6;

// ---- Card copy -------------------------------------------------------------
// Titles are pre-wrapped (SVG has no auto-wrap). Keep each line <= 20 chars so
// it fits the 1020px content width at the 78px title size.
type StatKey =
	| "price"
	| "providers"
	| "sessions"
	| "activeSessions"
	| "holders"
	| "staked";

interface CardDef {
	title: string[];
	subtitle: string;
	stats: StatKey[];
}

const CARDS: Record<string, CardDef> = {
	home: {
		title: ["Morpheus AI", "Block Explorer"],
		subtitle: "Live network intelligence for Morpheus on Base",
		stats: ["price", "providers", "sessions"],
	},
	about: {
		title: ["About MorScan"],
		subtitle: "The open block explorer for the Morpheus network",
		stats: ["providers", "holders", "price"],
	},
	verify: {
		title: ["Verify a Response"],
		subtitle: "Ed25519 receipts, checked in your own browser",
		stats: ["price", "providers", "holders"],
	},
	terms: {
		title: ["Terms of Service"],
		subtitle: "How MorScan may be used",
		stats: ["price", "providers", "holders"],
	},
	privacy: {
		title: ["Privacy Policy"],
		subtitle: "What MorScan does and does not collect",
		stats: ["price", "providers", "holders"],
	},
	stake: {
		title: ["Support MorScan"],
		subtitle: "Stake MOR to raise your API limits",
		stats: ["staked", "providers", "price"],
	},
	analytics: {
		title: ["Morpheus Network", "Analytics"],
		subtitle: "Live intelligence for the Morpheus AI network",
		stats: ["providers", "sessions", "price"],
	},
	compute: {
		title: ["Providers, Sessions", "and Models"],
		subtitle: "The compute layer of Morpheus, in real time",
		stats: ["providers", "activeSessions", "price"],
	},
	builder: {
		title: ["Builder Subnets", "and Emissions"],
		subtitle: "Subnets, emissions, and staking rewards",
		stats: ["staked", "providers", "price"],
	},
	holders: {
		title: ["MOR Token Holders"],
		subtitle: "Every MOR holder on Base, ranked by balance",
		stats: ["holders", "price", "staked"],
	},
	pools: {
		title: ["Staking Pools"],
		subtitle: "Compute and Builder pools on Morpheus",
		stats: ["staked", "providers", "sessions"],
	},
	subnet: {
		title: ["Builder Subnet"],
		subtitle: "Emissions, staking, and rewards on Morpheus",
		stats: ["staked", "providers", "price"],
	},
	default: {
		title: ["Morpheus AI", "Block Explorer"],
		subtitle: "The open block explorer for Morpheus on Base",
		stats: ["price", "providers", "holders"],
	},
};

const STAT_LABELS: Record<StatKey, string> = {
	price: "MOR PRICE",
	providers: "PROVIDERS",
	sessions: "TOTAL SESSIONS",
	activeSessions: "ACTIVE SESSIONS",
	holders: "MOR HOLDERS",
	staked: "MOR STAKED",
};

// ---- Live stats ------------------------------------------------------------
interface LiveStats {
	price?: number;
	providers?: number;
	sessions?: number;
	activeSessions?: number;
	holders?: number;
	staked?: number;
}

async function gatherStats(env: Env): Promise<LiveStats> {
	const out: LiveStats = {};
	const [metrics, priceRow, holdersRow] = await Promise.all([
		getNetworkMetrics(env).catch(() => null),
		// Price is cached in D1 sync_state by the price handler (no RPC here).
		getSyncStateTokenPrices(env.DB).catch(() => null),
		countDiscoveredHolders(env.DB).catch(() => null),
	]);

	if (metrics) {
		out.providers = metrics.providers;
		out.sessions = metrics.totalSessions;
		out.activeSessions = metrics.activeSessions;
		out.staked = metrics.morStaked;
	}
	if (priceRow?.value) {
		try {
			const usd = JSON.parse(priceRow.value)?.mor?.usd;
			if (typeof usd === "number" && usd > 0) out.price = usd;
		} catch {
			// ignore malformed price cache
		}
	}
	if (holdersRow && typeof holdersRow.cnt === "number") out.holders = holdersRow.cnt;
	return out;
}

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
	return n.toLocaleString("en-US");
}

// Returns { label, value } for a stat, or null if the underlying data is
// unavailable (so the chip is dropped rather than shown blank).
function statValue(key: StatKey, s: LiveStats): { label: string; value: string } | null {
	const label = STAT_LABELS[key];
	switch (key) {
		case "price":
			return s.price === undefined ? null : { label, value: `$${s.price.toFixed(2)}` };
		case "providers":
			return s.providers === undefined
				? null
				: { label, value: s.providers.toLocaleString("en-US") };
		case "sessions":
			return s.sessions === undefined ? null : { label, value: compact(s.sessions) };
		case "activeSessions":
			return s.activeSessions === undefined
				? null
				: { label, value: compact(s.activeSessions) };
		case "holders":
			return s.holders === undefined ? null : { label, value: compact(s.holders) };
		case "staked":
			return s.staked === undefined ? null : { label, value: compact(s.staked) };
	}
}

// ---- SVG assembly ----------------------------------------------------------
function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The MorScan wings, from morscan_header.ts LOGO_SVG (viewBox 0 0 89 40).
const WINGS_PATH =
	"M44.5031 36.7108L52.2884 27.0574V39.5L75.154 30.3296L78.4294 22.9099L58.8453 30.8065V28.0173L80.2346 19.2454L83.6775 11.7472L58.7647 21.8776V19.1669L85.7246 7.99814L89 0.5L56.3826 13.818C56.3826 13.818 53.5973 14.8563 52.369 16.8486L44.5031 26.5805L36.6372 16.8486C35.4089 14.8563 32.6236 13.818 32.6236 13.818L0 0.5L3.27539 7.99814L30.2415 19.1608V21.8715L5.32871 11.7472L8.77159 19.2454L30.1609 28.0173V30.8065L10.5768 22.9099L13.8522 30.3296L36.7178 39.5V27.0574L44.5031 36.7108Z";

function chip(
	x: number,
	y: number,
	label: string,
	value: string,
): { svg: string; width: number } {
	const valueSize = 46;
	const labelSize = 20;
	const labelSpacing = 2;
	const padX = 32;
	const height = 118;
	const valueW = value.length * valueSize * MONO_ADVANCE;
	// Labels carry letter-spacing, so add it per glyph or the box clips wide labels.
	const labelW = label.length * (labelSize * MONO_ADVANCE + labelSpacing);
	const width = Math.ceil(Math.max(valueW, labelW) + padX * 2);
	const accent = value.startsWith("$") ? CYAN : GREEN;
	const svg = `
    <g>
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18"
        fill="#151312" stroke="#2a2725" stroke-width="1.5"/>
      <rect x="${x}" y="${y}" width="4" height="${height}" rx="2" fill="${accent}"/>
      <text x="${x + padX}" y="${y + 40}" font-family="IBM Plex Mono" font-size="${labelSize}"
        font-weight="400" letter-spacing="${labelSpacing}" fill="${FAINT}">${esc(label)}</text>
      <text x="${x + padX}" y="${y + 92}" font-family="IBM Plex Mono" font-size="${valueSize}"
        font-weight="700" fill="${accent === CYAN ? CYAN : INK}">${esc(value)}</text>
    </g>`;
	return { svg, width };
}

function buildCardSvg(slug: string, stats: LiveStats): string {
	const def = CARDS[slug] ?? CARDS.default;
	const twoLine = def.title.length > 1;

	// Title block.
	const titleSize = 78;
	const titleLead = 92;
	const titleTop = twoLine ? 236 : 262;
	const titleSvg = def.title
		.map(
			(line, i) =>
				`<text x="90" y="${titleTop + i * titleLead}" font-family="IBM Plex Mono" font-size="${titleSize}" font-weight="700" fill="${INK}">${esc(line)}</text>`,
		)
		.join("");

	const subtitleY = titleTop + (twoLine ? titleLead : 0) + 60;
	const subtitleSvg = `<text x="90" y="${subtitleY}" font-family="IBM Plex Mono" font-size="30" font-weight="400" fill="${MUTE}">${esc(def.subtitle)}</text>`;

	// Live stat chips (drop any that have no data).
	const chipY = 436;
	let cx = 90;
	const gap = 26;
	const chipsSvg = def.stats
		.map((k) => statValue(k, stats))
		.filter((v): v is { label: string; value: string } => v !== null)
		.map((v) => {
			const c = chip(cx, chipY, v.label, v.value);
			cx += c.width + gap;
			return c.svg;
		})
		.join("");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glowA" cx="82%" cy="6%" r="62%">
      <stop offset="0" stop-color="${GREEN}" stop-opacity="0.20"/>
      <stop offset="0.6" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="4%" cy="104%" r="55%">
      <stop offset="0" stop-color="${GREEN}" stop-opacity="0.12"/>
      <stop offset="0.6" stop-color="${GREEN}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="wings" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#eafbe7"/>
      <stop offset="0.4" stop-color="#57b45c"/>
      <stop offset="0.55" stop-color="#2f8f3f"/>
      <stop offset="0.75" stop-color="#4aa551"/>
      <stop offset="1" stop-color="#d8f2d2"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="${BG}"/>
  <rect width="1200" height="630" fill="url(#glowA)"/>
  <rect width="1200" height="630" fill="url(#glowB)"/>
  <rect x="0" y="0" width="1200" height="6" fill="${GREEN}"/>
  <rect x="0" y="624" width="1200" height="6" fill="${GREEN}" opacity="0.65"/>
  <g transform="translate(90 62) scale(1.45)">
    <path d="${WINGS_PATH}" fill="url(#wings)"/>
  </g>
  <text x="238" y="107" font-family="IBM Plex Mono" font-size="30" font-weight="700" letter-spacing="10" fill="${WORDMARK}">MorScan</text>
  ${titleSvg}
  ${subtitleSvg}
  ${chipsSvg}
  <text x="90" y="600" font-family="IBM Plex Mono" font-size="25" font-weight="400" letter-spacing="1" fill="${FAINT}">Morpheus on Base</text>
  <text x="1110" y="600" text-anchor="end" font-family="IBM Plex Mono" font-size="25" font-weight="700" letter-spacing="1" fill="${GREEN}">morscan.io</text>
</svg>`;
}

// ---- Rasterization ---------------------------------------------------------
let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
	if (!wasmReady) {
		wasmReady = initWasm(resvgWasm as WebAssembly.Module).catch((e) => {
			// Reset so a later request can retry initialization.
			wasmReady = null;
			throw e;
		});
	}
	return wasmReady;
}

function renderPng(svg: string): Uint8Array {
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: 1200 },
		background: BG,
		font: {
			loadSystemFonts: false,
			fontBuffers: [
				new Uint8Array(monoRegular as ArrayBuffer),
				new Uint8Array(monoBold as ArrayBuffer),
			],
			defaultFontFamily: "IBM Plex Mono",
		},
	});
	return resvg.render().asPng();
}

// ---- Public entry ----------------------------------------------------------
const CACHE_VERSION = "v2";
const OG_TTL_SECONDS = 3600;

/**
 * Render (or serve from cache) the branded OG card for a slug.
 * Throws on rasterization failure so the route can fall back to a static card.
 */
export async function handleOgCard(
	env: Env,
	slug: string,
	url: URL,
	ctx: ExecutionContext,
): Promise<Response> {
	const normalized = slug.toLowerCase();

	// Cache key folds in a coarse time bucket so live stats refresh once per TTL
	// window even behind an immutable Cache-Control on the client.
	const bucket = Math.floor(Date.now() / (OG_TTL_SECONDS * 1000));
	const idSuffix = normalized === "subnet" ? `:${url.searchParams.get("id") || "x"}` : "";
	const cacheUrl = new URL(
		`https://morscan-og.internal/${CACHE_VERSION}/${normalized}${idSuffix}/${bucket}`,
	);
	const cacheReq = new Request(cacheUrl.toString());
	const cache = caches.default;

	const hit = await cache.match(cacheReq);
	if (hit) {
		const h = new Headers(hit.headers);
		h.set("X-Cache", "HIT");
		return new Response(hit.body, { status: 200, headers: h });
	}

	await ensureWasm();
	const stats = await gatherStats(env);
	const svg = buildCardSvg(normalized, stats);
	const png = renderPng(svg);
	// Copy into a standalone ArrayBuffer so the body is a clean, cacheable blob.
	const body = png.slice();

	const headers = {
		"Content-Type": "image/png",
		"Cache-Control": `public, max-age=${OG_TTL_SECONDS}, s-maxage=${OG_TTL_SECONDS}, immutable`,
		"X-Cache": "MISS",
	};
	ctx.waitUntil(cache.put(cacheReq, new Response(body, { status: 200, headers })));
	return new Response(body, { status: 200, headers });
}

// ---- Favicon / touch icons -------------------------------------------------
// Google shows a site's favicon in search results from a crawlable, square
// raster at a standard path (icon >= 48px, a multiple of 48). We rasterize the
// SAME MorScan wings-on-black brand icon (assets.ts MORSCAN_ICON_SVG) to PNG
// with the resvg pipeline the OG cards already use, and serve it at
// /favicon.ico, /favicon.png, and /apple-touch-icon.png. Rendered PNGs are
// cached hard (7 days) in the CF Cache API so a raster is produced at most once
// per window per colo; second hits are a cache HIT. No fonts are needed (the
// icon is pure vector), so this is cheaper than an OG card.
const FAVICON_TTL_SECONDS = 604800; // 7 days

function renderIconPng(size: number, background?: string): Uint8Array {
	const resvg = new Resvg(MORSCAN_ICON_SVG, {
		fitTo: { mode: "width", value: size },
		...(background ? { background } : {}),
		font: { loadSystemFonts: false },
	});
	return resvg.render().asPng();
}

/**
 * Render (or serve from cache) a square PNG of the MorScan brand icon.
 * Throws on rasterization failure so the route can fall back to the SVG icon.
 */
export async function handleFavicon(
	ctx: ExecutionContext,
	opts: { size: number; contentType: string; tag: string; background?: string },
): Promise<Response> {
	const cacheUrl = new URL(
		`https://morscan-og.internal/favicon/${CACHE_VERSION}/${opts.tag}`,
	);
	const cacheReq = new Request(cacheUrl.toString());
	const cache = caches.default;

	const hit = await cache.match(cacheReq);
	if (hit) {
		const h = new Headers(hit.headers);
		h.set("X-Cache", "HIT");
		return new Response(hit.body, { status: 200, headers: h });
	}

	await ensureWasm();
	const png = renderIconPng(opts.size, opts.background);
	// Copy into a standalone ArrayBuffer so the body is a clean, cacheable blob.
	const body = png.slice();
	const headers = {
		"Content-Type": opts.contentType,
		"Cache-Control": `public, max-age=${FAVICON_TTL_SECONDS}, s-maxage=${FAVICON_TTL_SECONDS}, immutable`,
		"X-Cache": "MISS",
	};
	ctx.waitUntil(cache.put(cacheReq, new Response(body, { status: 200, headers })));
	return new Response(body, { status: 200, headers });
}

// Exported for offline/visual tests.
export { buildCardSvg, CARDS };
