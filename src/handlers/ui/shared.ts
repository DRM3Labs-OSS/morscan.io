/**
 * UI Handlers - shared constants + helpers used across the page handlers.
 */

import type { Env } from "../../types";
import type { PriceData, StatBarData } from "../../ui/shell";
import type { StatItem } from "../../ui/morscan_header";
import { getNetworkMetrics } from "../../utils/metrics";
import { getSyncStateTokenPrices } from "../../db/explorer-market";
import { buildStampHtml } from "../../ui/build-stamp";
import walletBadge from "../../ui/partials/wallet-badge.html";

// ─── Shared constants ───

// Canonical Content-Security-Policy for HTML responses. One definition, reused
// across the UI page handlers and the wallet-first console.
//
// connect-src is 'self' for the API (the UI only talks to its own origin);
// operators fronting the API on a separate host should add it here. The
// WalletConnect / reown-AppKit hosts are allowed so the console's vanilla
// WalletConnect provider (mobile deep-link / desktop QR) can open its wss
// relay, fetch the wallet registry, load its modal fonts, and run its verify
// frame. These are NETWORK allowances only - the WC bundle itself is
// self-served (script-src 'self', GET /console/wc.js), never from a CDN.
//   - connect-src: wss relay (relay.walletconnect.org/.com) + registry/analytics
//     (explorer-api.walletconnect.com, api.web3modal.org, *.reown.com, pulse)
//   - font-src:   the modal's KHTeka fonts (fonts.reown.com); 'self' covers the
//     self-hosted IBM Plex Mono at /fonts/ (no third-party font host)
//   - frame-src:  the WalletConnect verify iframe (verify.walletconnect.org)
export const CSP =
	"default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; font-src 'self' https://fonts.reown.com data:; img-src 'self' data: blob: https:; connect-src 'self' https://cloudflareinsights.com wss://*.walletconnect.org wss://*.walletconnect.com wss://*.reown.com https://*.walletconnect.org https://*.walletconnect.com https://api.web3modal.org https://*.web3modal.org https://*.web3modal.com https://*.reown.com https://*.pinata.cloud; frame-src https://*.walletconnect.org https://*.walletconnect.com https://*.reown.com; frame-ancestors 'none';";

export const HTML_HEADERS = {
	"Content-Type": "text/html;charset=UTF-8",
	"Access-Control-Allow-Origin": "*",
	"Cache-Control": "no-cache, s-maxage=5",
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
	"Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
	"Content-Security-Policy": CSP,
};

export const JSON_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

// ─── Shared helpers ───

export function morStat(price: PriceData | null): StatItem {
	return {
		label: "MOR",
		value: price && price.usd > 0 ? `$${price.usd.toFixed(2)}` : "-",
		id: "stat-mor",
	};
}

// The credit line the static HTML pages ship (landing/about/terms/privacy/
// 404/stake all carry this exact literal). The dynamic shell (layout.mustache)
// already renders version + build commit; these raw pages don't, so we swap
// the literal at serve time for the same line rather than bake a stale SHA
// into the checked-in HTML.
const STATIC_FOOTER_CREDIT =
	'<p style="margin:0;font-size:0.6rem;color:#8a8580;">MorScan &middot; &copy; 2026</p>';

/** Inject the universal upper-right wallet badge before </body>. Standalone
 * pages (landing + side pages) do not use the plane header, so this gives them
 * the same connected-wallet menu. The badge self-suppresses on pages that
 * already have the plane header slot, so it never doubles. */
export function withWalletBadge(html: string): string {
	return html.replace("</body>", `${walletBadge as string}\n</body>`);
}

/** Inject the live build stamp into a static page's footer credit, and the
 * universal wallet badge. The stamp itself has ONE definition
 * (src/ui/build-stamp.ts), computed from the same sources /version reports,
 * so the footer and the composition honesty marker can never disagree. */
export function withBuildFooter(html: string): string {
	const line = `<p style="margin:0;font-size:0.6rem;color:#8a8580;">${buildStampHtml()}</p><p style="margin:0.45rem auto 0;max-width:46rem;font-size:0.62rem;line-height:1.5;color:#c7c2bc;">Open alpha, no warranties expressed or implied. Data is served as-is from on-chain events; verify it with the provenance receipts. Not financial advice.</p>`;
	return withWalletBadge(html.split(STATIC_FOOTER_CREDIT).join(line));
}

/** Escape string for safe interpolation inside <script> tags */
export function escJs(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/<\//g, "<\\/");
}

/** Safely serialize data for embedding in <script> tags */
export function safeJson(data: unknown): string {
	return JSON.stringify(data).replace(/<\//g, "<\\/");
}

/** Fetch cached price from D1 */
export async function getCachedPrice(env: Env): Promise<PriceData | null> {
	try {
		const row = await getSyncStateTokenPrices(env.DB);
		if (!row) return null;
		const cached = JSON.parse(row.value);
		return {
			usd: cached.mor?.usd || cached.usd || 0,
			change24h: cached.mor?.change24h || cached.change24h || 0,
			marketCap: cached.mor?.marketCap || cached.marketCap || 0,
		};
	} catch {
		return null;
	}
}

/** Build shared stat bar data from D1 - canonical metrics (one definition). */
export async function getStatBarData(
	env: Env,
	price: PriceData | null,
): Promise<StatBarData> {
	const m = await getNetworkMetrics(env);
	return {
		morPrice: price && price.usd > 0 ? `$${price.usd.toFixed(2)}` : "-",
		providerCount: String(m.providers),
		activeSessions: String(m.activeSessions),
		morStaked: `${new Intl.NumberFormat().format(m.morStaked)} MOR`,
	};
}

/** Extract page-specific styles and content from a content fragment */
export function extractPage(html: string): { styles: string; content: string } {
	const styleBlocks: string[] = [];
	const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
	for (let m = styleRe.exec(html); m !== null; m = styleRe.exec(html))
		styleBlocks.push(m[1]);
	const content = html
		.replace(styleRe, "")
		.replace(/^<!--[^>]*-->\s*/g, "")
		.trim();
	return { styles: styleBlocks.join("\n"), content };
}

// Map URL path to active tab. Canonical scheme is /compute/<subtab>; the
// subtab is the second segment (legacy flat paths 301 before reaching here).
export function pathToTab(
	path: string,
): "network" | "providers" | "consumers" | "sessions" {
	const segs = path.split("/").filter(Boolean);
	const p = (segs[0] === "compute" ? segs[1] : segs[0]) || "network";
	if (["network", "providers", "consumers", "sessions"].includes(p)) {
		return p as "network" | "providers" | "consumers" | "sessions";
	}
	return "network";
}
