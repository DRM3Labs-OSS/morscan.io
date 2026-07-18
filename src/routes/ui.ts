/**
 * UI Page Routes - SSR pages behind JWT auth
 */

import type { Env } from "../types";
import {
	handleAppPage,
	handleApiPage,
	handleAboutPage,
	handleVerifyPage,
	handleProviderDetailPage,
	handleWalletDetailPage,
	handleModelDetailPage,
	handleModelSlugPage,
	handleHoldersPage,
	handleBuilderPage,
	handleBuilderCalcPage,
	handleBuilderApiPage,
	handleBuilderSubnetPage,
	handlePoolsPage,
	handleOgImage,
	handleSubnetOg,
	handlePageOg,
	handleLandingPage,
	handleTermsPage,
	handlePrivacyPage,
	handleContributePage,
	handleStakePage,
	handleDrm3IconBlack,
	handleDrm3IconTransparent,
	handleMorscanIcon,
	handleFont,
	handleAnalyticsTabPage,
} from "../handlers/ui";

import { handleOgCard, handleFavicon } from "../handlers/og-image";
import { AGENT_LINK_HEADER } from "../handlers/agent-ready";
import { wantsMarkdown, handleMarkdownPage } from "../handlers/markdown-pages";
import { TICKER_SLOT, marketTickerHtml } from "../ui/ticker";
import swJs from "../ui/vendor/sw.txt";

/** Fill the layout's market-tape slot on pages that carry it. One place, so
 * every unified-header page gets the ticker and the tape rides the same page
 * cache (one D1 aggregate per cache miss). Pages without the slot (landing,
 * standalone side pages) pass through untouched. */
async function withMarketTicker(env: Env, fresh: Response): Promise<Response> {
	const ct = fresh.headers.get("Content-Type") || "";
	if (!ct.includes("text/html")) return fresh;
	const html = await fresh.text();
	const filled = html.includes(TICKER_SLOT)
		? html.replace(TICKER_SLOT, await marketTickerHtml(env))
		: html;
	return new Response(filled, { status: fresh.status, headers: fresh.headers });
}

/** Cache SSR pages at the Worker level (CF Cache API). */
async function cachedPage(
	url: URL,
	ctx: ExecutionContext,
	env: Env,
	handler: () => Promise<Response>,
	ttl = 30,
): Promise<Response> {
	const cacheKey = new Request(url.toString().split("?")[0], { method: "GET" });
	const cache = caches.default;
	const cached = await cache.match(cacheKey);
	if (cached) return cached;
	const fresh = await withMarketTicker(env, await handler());
	// Edge + browser cache for `ttl`s. s-maxage drives Cloudflare's edge cache
	// (CF-Cache-Status: HIT on repeat hits within the window); max-age matches it
	// so a client also holds the page briefly. Time-sensitive live data still
	// refreshes every `ttl`s. /health, /version, and the signed /mor/v1 API keep
	// their own short/no-cache headers and never flow through here.
	//
	// Use Headers.set (case-insensitive REPLACE) so we drop whatever Cache-Control
	// the handler set (e.g. the landing page's `no-cache`, which would otherwise
	// keep the root uncacheable) and emit exactly one clean directive. Spreading
	// the raw headers would leave the original `cache-control` alongside a new
	// `Cache-Control`, and the Headers ctor would comma-join them into a doubled
	// value - and any lingering `no-cache` would stop the edge from caching.
	const headers = new Headers(fresh.headers);
	headers.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}`);
	// Agent discovery (RFC 8288): advertise the api-catalog + service docs on
	// every HTML page. Set INSIDE the cached response so the header survives
	// cache hits, and Vary on Accept because the markdown-negotiated variants
	// of these pages (Accept: text/markdown, routed before this cache) differ.
	headers.set("Link", AGENT_LINK_HEADER);
	headers.append("Vary", "Accept");
	const resp = new Response(fresh.body, { status: fresh.status, headers });
	ctx.waitUntil(cache.put(cacheKey, resp.clone()));
	return resp;
}

export async function handleUiRoutes(
	path: string,
	request: Request,
	url: URL,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response | null> {
	// Markdown content negotiation (Accept: text/markdown) for the main pages.
	// MUST run before the HTML page cache so the two representations never
	// share a cache entry; the markdown response carries Vary: Accept.
	if (wantsMarkdown(request, path)) {
		return await handleMarkdownPage(path, env);
	}

	// Open access: the read-only explorer UI is public. Per-IP rate limits and
	// the cache layers protect the backend; /login remains for the API console.
	if (path === "/" || path === "/ui") {
		return await cachedPage(url, ctx, env, async () => handleLandingPage(env));
	}

	// ── Canonical URL scheme: /<parent>/<subtab> mirrors the tab language. ──
	// Parent paths redirect to their first subtab; every legacy path 301s to
	// its canonical equivalent (params preserved). Nothing that worked 404s.
	const redirect301 = (loc: string) =>
		new Response(null, {
			status: 301,
			headers: { Location: loc, "Cache-Control": "public, max-age=3600" },
		});

	// Parent redirects
	if (path === "/analytics" || path === "/analytics-tab")
		return redirect301("/analytics/overview");
	if (path === "/compute") return redirect301("/compute/network");
	if (path === "/holders") return redirect301("/holders/all");
	if (path === "/builder") return redirect301("/builder/subnets");
	if (path === "/api") return redirect301("/api/playground");
	// Legacy flat compute paths
	if (
		path === "/network" ||
		path === "/providers" ||
		path === "/consumers" ||
		path === "/sessions"
	) {
		return redirect301(`/compute${path}`);
	}
	const legacyProvider = path.match(/^\/providers\/(0x[0-9a-fA-F]{40})$/);
	if (legacyProvider) return redirect301(`/compute/providers/${legacyProvider[1]}`);
	const legacyWallet = path.match(/^\/consumers\/wallet\/(0x[0-9a-fA-F]{40})$/);
	if (legacyWallet) return redirect301(`/compute/consumers/wallet/${legacyWallet[1]}`);
	if (path === "/builder/calc") return redirect301("/builder/calculator");

	if (path === "/analytics/overview") {
		return await cachedPage(url, ctx, env, () => handleAnalyticsTabPage(env));
	}
	// Provider detail - must be before the compute subtab routes
	if (path.match(/^\/compute\/providers\/0x[0-9a-fA-F]{40}$/)) {
		const address = path.split("/").pop() || "";
		return await cachedPage(url, ctx, env, () => handleProviderDetailPage(env, address));
	}
	// Wallet detail
	if (path.match(/^\/compute\/consumers\/wallet\/0x[0-9a-fA-F]{40}$/)) {
		const address = path.split("/").pop() || "";
		return await cachedPage(url, ctx, env, () => handleWalletDetailPage(env, address));
	}
	// Model detail - one model's bids, sessions, providers, and demand.
	// Two spellings: the on-chain listing id, and the canonical slug we own
	// ("/compute/models/kimi-k3"). Both render the same aggregated page.
	if (path.match(/^\/compute\/models\/0x[0-9a-fA-F]{64}$/)) {
		const modelId = (path.split("/").pop() || "").toLowerCase();
		return await cachedPage(url, ctx, env, () => handleModelDetailPage(env, modelId));
	}
	const slugMatch = path.match(/^\/compute\/models\/([a-z0-9][a-z0-9.\-]{0,80})$/);
	if (slugMatch) {
		const slug = slugMatch[1];
		return await cachedPage(url, ctx, env, () => handleModelSlugPage(env, slug, path));
	}
	// About page - public, standalone, no auth, no shell header.
	if (path === "/about") {
		return await cachedPage(url, ctx, env, async () => handleAboutPage());
	}
	// Verify page - public, standalone: the human-facing in-browser receipt check.
	if (path === "/verify") {
		return await cachedPage(url, ctx, env, async () => handleVerifyPage());
	}
	// Legal pages - public, standalone.
	if (path === "/terms") {
		return await cachedPage(url, ctx, env, async () => handleTermsPage());
	}
	if (path === "/privacy") {
		return await cachedPage(url, ctx, env, async () => handlePrivacyPage());
	}
	// Contribute page - public, standalone, open-source invitation.
	if (path === "/contribute") {
		return await cachedPage(url, ctx, env, async () => handleContributePage());
	}
	// Stake-for-capacity page - public, standalone.
	if (path === "/stake") {
		return await cachedPage(url, ctx, env, async () => handleStakePage(env));
	}
	// API playground - standalone page (not part of SPA)
	// /api/docs serves same page, client-side switches to OpenAPI docs tab
	if (path === "/api/playground" || path === "/api/docs") {
		return await cachedPage(url, ctx, env, () => handleApiPage(env, path));
	}
	// SPA - 4 tabs served by one handler (fatboy data)
	if (
		[
			"/compute/network",
			"/compute/providers",
			"/compute/consumers",
			"/compute/sessions",
		].includes(path)
	) {
		return await cachedPage(url, ctx, env, () => handleAppPage(env, path));
	}
	// Pools plane UI
	if (path === "/pools") {
		return await cachedPage(url, ctx, env, () => handlePoolsPage(env));
	}
	// MOR Holders page
	if (path === "/holders/all") {
		return await cachedPage(url, ctx, env, () => handleHoldersPage(env));
	}
	// Dust wallets page
	if (path === "/holders/dust") {
		return await cachedPage(url, ctx, env, () => handleHoldersPage(env, "dust"));
	}
	// Builder plane UI
	if (path === "/builder/subnets") {
		return await cachedPage(url, ctx, env, () => handleBuilderPage(env));
	}
	if (path === "/builder/calculator") {
		return await cachedPage(url, ctx, env, () => handleBuilderCalcPage(env));
	}
	if (path === "/builder/api") {
		return await cachedPage(url, ctx, env, () => handleBuilderApiPage(env));
	}
	if (path.match(/^\/builder\/subnet\/0x[0-9a-fA-F]{64}$/)) {
		const subnetId = path.split("/").pop() || "";
		return await cachedPage(url, ctx, env, () => handleBuilderSubnetPage(env, subnetId));
	}
	if (path === "/og-image.png" || path === "/og-image.svg") {
		return handleOgImage();
	}
	// Per-subnet og cards (KV-backed operator uploads, brand fallback)
	const ogSubnet = path.match(/^\/og\/subnet\/(0x[0-9a-fA-F]{64})\.png$/);
	if (ogSubnet) {
		return handleSubnetOg(env, ogSubnet[1]);
	}
	// Per-page share cards: dynamic, live-stat branded PNGs rendered on the fly
	// (resvg). The `.png` extension is optional. On any rasterization failure we
	// fall back to the pre-rendered static card so a preview never 500s.
	const ogPage = path.match(/^\/og\/([a-z0-9-]+?)(?:\.png)?$/);
	if (ogPage) {
		const slug = ogPage[1];
		try {
			return await handleOgCard(env, slug, url, ctx);
		} catch (_e) {
			return handlePageOg(slug);
		}
	}
	if (path === "/morscan-icon.svg") {
		return handleMorscanIcon();
	}
	// Self-hosted webfonts (IBM Plex Mono, OFL 1.1) - immutable, cached hard.
	if (path.startsWith("/fonts/")) {
		const font = handleFont(path.slice("/fonts/".length));
		if (font) return font;
	}
	// Standard favicon + touch-icon discovery paths (Google + browsers). Google's
	// search-result favicon comes from a crawlable square raster >= 48px; we
	// render the wings-on-black brand icon to PNG (cached hard) and serve PNG
	// bytes at /favicon.ico (Google accepts a PNG there). Any rasterization
	// failure falls back to the SVG brand icon so these paths never 404/500.
	if (path === "/favicon.ico") {
		try {
			return await handleFavicon(ctx, {
				size: 96,
				contentType: "image/png",
				tag: "ico-96-v1",
			});
		} catch (_e) {
			return handleMorscanIcon();
		}
	}
	if (path === "/favicon.png") {
		try {
			return await handleFavicon(ctx, {
				size: 48,
				contentType: "image/png",
				tag: "png-48-v1",
			});
		} catch (_e) {
			return handleMorscanIcon();
		}
	}
	if (path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png") {
		try {
			// Solid black behind the rounded corners: iOS composites the home-screen
			// icon on an opaque tile, so a filled square reads cleaner than alpha.
			return await handleFavicon(ctx, {
				size: 180,
				contentType: "image/png",
				tag: "apple-180-v1",
				background: "#000000",
			});
		} catch (_e) {
			return handleMorscanIcon();
		}
	}
	if (path === "/drm3-icon-black-white-consumer-128.png") {
		return handleDrm3IconBlack();
	}
	if (path === "/drm3-icon-transparent-white-consumer-128.png") {
		return handleDrm3IconTransparent();
	}
	// Service Worker (public, served from root scope for full control)
	if (path === "/sw.js") {
		return new Response(swJs, {
			headers: {
				"Content-Type": "application/javascript",
				"Cache-Control": "no-cache",
				"Service-Worker-Allowed": "/",
			},
		});
	}

	return null;
}
