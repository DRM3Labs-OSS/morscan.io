/**
 * UI Handlers - Static assets (OG image, brand icons)
 */

import ogImageData from "../../images/og-image.png";
import drm3IconBlack from "../../images/drm3-icon-black-white-consumer-128.png";
import drm3IconTransparent from "../../images/drm3-icon-transparent-white-consumer-128.png";

// Per-page share cards (static PNGs, 1200x630). Generated at build time from a
// branded HTML template so a shared link previews the right plane, not one
// generic product card. Regenerate with scripts/gen-og.mjs.
import ogAnalytics from "../../images/og-analytics.png";
import ogCompute from "../../images/og-compute.png";
import ogBuilder from "../../images/og-builder.png";
import ogHolders from "../../images/og-holders.png";
import ogPools from "../../images/og-pools.png";
import ogApi from "../../images/og-api.png";
import ogStake from "../../images/og-stake.png";
import ogAbout from "../../images/og-about.png";

// Self-hosted IBM Plex Mono (SIL OFL 1.1, license in src/fonts/OFL.txt).
// Served at /fonts/ibm-plex-mono-<weight>.woff2 so no page needs Google Fonts;
// the @font-face blocks in the page heads point here.
import plexMono400 from "../../fonts/ibm-plex-mono-400.woff2";
import plexMono500 from "../../fonts/ibm-plex-mono-500.woff2";
import plexMono600 from "../../fonts/ibm-plex-mono-600.woff2";
import plexMono700 from "../../fonts/ibm-plex-mono-700.woff2";

const FONTS: Record<string, ArrayBuffer> = {
	"ibm-plex-mono-400.woff2": plexMono400 as unknown as ArrayBuffer,
	"ibm-plex-mono-500.woff2": plexMono500 as unknown as ArrayBuffer,
	"ibm-plex-mono-600.woff2": plexMono600 as unknown as ArrayBuffer,
	"ibm-plex-mono-700.woff2": plexMono700 as unknown as ArrayBuffer,
};

// /fonts/<file> - immutable bytes, cache hard (a year; the filename would
// change if the font ever did).
export function handleFont(file: string): Response | null {
	const bytes = FONTS[file];
	if (!bytes) return null;
	return new Response(bytes, {
		headers: {
			"Content-Type": "font/woff2",
			"Cache-Control": "public, max-age=31536000, immutable",
			"Access-Control-Allow-Origin": "*",
		},
	});
}

const PAGE_OG: Record<string, ArrayBuffer> = {
	analytics: ogAnalytics as unknown as ArrayBuffer,
	compute: ogCompute as unknown as ArrayBuffer,
	builder: ogBuilder as unknown as ArrayBuffer,
	holders: ogHolders as unknown as ArrayBuffer,
	pools: ogPools as unknown as ArrayBuffer,
	api: ogApi as unknown as ArrayBuffer,
	stake: ogStake as unknown as ArrayBuffer,
	about: ogAbout as unknown as ArrayBuffer,
};

export function handleOgImage(): Response {
	return new Response(ogImageData, {
		headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
	});
}

// Per-page og card at /og/<page>.png. Unknown pages fall back to the brand card.
export function handlePageOg(page: string): Response {
	const png = PAGE_OG[page];
	if (!png) return handleOgImage();
	return new Response(png, {
		headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
	});
}

export function handleDrm3IconBlack(): Response {
	return new Response(drm3IconBlack, {
		headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
	});
}

export function handleDrm3IconTransparent(): Response {
	return new Response(drm3IconTransparent, {
		headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
	});
}

// MorScan product icon - canonical source: drm3-brand-kit/src/products/morscan/morscan-icon.svg
// Exported so the favicon pipeline (handlers/og-image.ts) can rasterize the
// same wings-on-black brand mark to PNG for /favicon.ico, /favicon.png, and
// /apple-touch-icon.png.
export const MORSCAN_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="MorScan icon"><defs><linearGradient id="miMetal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eafbe7"/><stop offset=".18" stop-color="#b7e6ae"/><stop offset=".38" stop-color="#57b45c"/><stop offset=".55" stop-color="#2f8f3f"/><stop offset=".72" stop-color="#4aa551"/><stop offset=".88" stop-color="#9bdb94"/><stop offset="1" stop-color="#d8f2d2"/></linearGradient><linearGradient id="miSheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset=".25" stop-color="#fff" stop-opacity=".05"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/></linearGradient><radialGradient id="miGlow" cx="0.5" cy="0.48" r="0.55"><stop offset="0" stop-color="#22c55e" stop-opacity=".3"/><stop offset=".6" stop-color="#22c55e" stop-opacity=".1"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></radialGradient></defs><rect width="128" height="128" rx="28" fill="#000000"/><rect width="128" height="128" rx="28" fill="url(#miGlow)"/><g transform="translate(14 41.5) scale(1.1236)"><path d="M44.5031 36.7108L52.2884 27.0574V39.5L75.154 30.3296L78.4294 22.9099L58.8453 30.8065V28.0173L80.2346 19.2454L83.6775 11.7472L58.7647 21.8776V19.1669L85.7246 7.99814L89 0.5L56.3826 13.818C56.3826 13.818 53.5973 14.8563 52.369 16.8486L44.5031 26.5805L36.6372 16.8486C35.4089 14.8563 32.6236 13.818 32.6236 13.818L0 0.5L3.27539 7.99814L30.2415 19.1608V21.8715L5.32871 11.7472L8.77159 19.2454L30.1609 28.0173V30.8065L10.5768 22.9099L13.8522 30.3296L36.7178 39.5V27.0574L44.5031 36.7108Z" fill="url(#miMetal)"/><path d="M44.5031 36.7108L52.2884 27.0574V39.5L75.154 30.3296L78.4294 22.9099L58.8453 30.8065V28.0173L80.2346 19.2454L83.6775 11.7472L58.7647 21.8776V19.1669L85.7246 7.99814L89 0.5L56.3826 13.818C56.3826 13.818 53.5973 14.8563 52.369 16.8486L44.5031 26.5805L36.6372 16.8486C35.4089 14.8563 32.6236 13.818 32.6236 13.818L0 0.5L3.27539 7.99814L30.2415 19.1608V21.8715L5.32871 11.7472L8.77159 19.2454L30.1609 28.0173V30.8065L10.5768 22.9099L13.8522 30.3296L36.7178 39.5V27.0574L44.5031 36.7108Z" fill="url(#miSheen)"/></g></svg>`;

export function handleMorscanIcon(): Response {
	return new Response(MORSCAN_ICON_SVG, {
		headers: {
			"Content-Type": "image/svg+xml",
			"Cache-Control": "public, max-age=86400",
		},
	});
}

// Per-subnet og card: operator-uploaded PNGs in KV (key og:subnet:<id>),
// falling back to the brand og image. Upload:
//   npx wrangler kv key put "og:subnet:<id>" --path card.png --namespace-id <MORSCAN_CACHE id> --remote
export async function handleSubnetOg(
	env: { MORSCAN_CACHE?: KVNamespace },
	subnetId: string,
): Promise<Response> {
	if (env.MORSCAN_CACHE) {
		const png = await env.MORSCAN_CACHE.get(`og:subnet:${subnetId}`, "arrayBuffer");
		if (png)
			return new Response(png, {
				headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
			});
	}
	return handleOgImage();
}
