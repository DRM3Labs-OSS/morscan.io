/**
 * UI Handlers - Standalone pages (holders, pools, about, 404)
 *
 * There is no standalone login page: /login 302s to /console, the single
 * sign-in door (wallet connect primary, key sign-in secondary). See
 * routes/auth.ts.
 */

import type { Env } from "../../types";
import { baseUrl } from "../../config";
import { render } from "../../ui/shell";
import { holdersPlane, poolsPlane, type Tab } from "../../ui/morscan_header";
import {
	getCachedPrice,
	extractPage,
	morStat,
	escJs,
	safeJson,
	HTML_HEADERS,
	withBuildFooter,
} from "./shared";
import { seoHead, seoLede, breadcrumbLd, morPriceLd } from "./seo";
import { MORSCAN_VERSION } from "../../version";
import { readHolderCoverage } from "../../sync/holder-coverage";
import { builderDailyEmissions } from "../builder-shared";
import { getSyncStateLastBlock } from "../../db/explorer-market";
import { getMorHolderTierCounts, sumMorHolderBalance } from "../../db/explorer-sessions";
import { getNetworkMetrics } from "../../utils/metrics";

import landingHtml from "../../ui/pages/landing.html";
import priceWidgetHtml from "../../ui/partials/price-widget.html";
import termsHtml from "../../ui/pages/terms.html";
import privacyHtml from "../../ui/pages/privacy.html";
import stakeHtml from "../../ui/pages/stake.html";
import holdersHtml from "../../ui/pages/holders.html";
import poolsHtml from "../../ui/pages/pools.html";
import aboutHtml from "../../ui/pages/about.html";
import verifyHtml from "../../ui/pages/verify.html";
import contributeHtml from "../../ui/pages/contribute.html";
import notFoundHtml from "../../ui/pages/404.html";

// ─── MOR Holders Page ───

export async function handleHoldersPage(
	env: Env,
	mode: "holders" | "dust" = "holders",
): Promise<Response> {
	const price = await getCachedPrice(env);
	const { styles, content } = extractPage(holdersHtml as string);
	const isDust = mode === "dust";
	const activeTab = (isDust ? "dust" : "holders") as Tab;

	// SSR holder counts - Basescan-honest: total = wallets with balance > 0.
	const MIN_WEI = "10000000000000000"; // 0.01 MOR
	const chainBlock = parseInt((await getSyncStateLastBlock(env.DB))?.value || "0", 10);
	const [countRow, totalMor, cov] = await Promise.all([
		getMorHolderTierCounts(env.DB, MIN_WEI),
		sumMorHolderBalance(env.DB),
		readHolderCoverage(env, chainBlock),
	]);
	const total = countRow?.with_balance || 0;
	const meaningful = countRow?.meaningful || 0;
	const dust = countRow?.dust || 0;
	const totalMorVal = totalMor?.total
		? new Intl.NumberFormat().format(Math.floor(totalMor.total))
		: "-";
	const indexing = !cov.complete;

	const fmt = (n: number) => new Intl.NumberFormat().format(n);
	// Honest "still indexing" label so a low interim count never reads as final.
	const holdersValue = indexing
		? `${fmt(total)} (indexing ${cov.pct.toFixed(0)}%)`
		: fmt(total);
	const planeConfig = holdersPlane(activeTab, [
		morStat(price),
		{ label: "Total Holders", value: holdersValue, id: "stat-bar-holders" },
		{ label: "≥0.01 MOR", value: fmt(meaningful) },
		{ label: "Dust (<0.01)", value: fmt(dust), id: "stat-bar-dust" },
		{ label: "Total MOR", value: totalMorVal, id: "stat-bar-total-mor" },
	]);
	const holdersPath = `/holders/${isDust ? "dust" : "all"}`;
	return new Response(
		render({
			title: isDust ? "Dust Holders - MorScan" : "MOR Token Holders - MorScan",
			description: isDust
				? "MOR token holders with dust balances (under 0.01 MOR) on Base, ranked by balance."
				: "Every MOR token holder on Base, ranked by balance and classified by on-chain role: providers, stakers, and builders.",
			ogUrl: `${baseUrl()}${holdersPath}`,
			ogImage: `${baseUrl()}/og/holders.png`,
			subtitle: isDust ? "Dust Holders (<0.01 MOR)" : "$MOR Token Holders",
			active: activeTab,
			price,
			planeConfig,
			pageStyles: styles,
			content:
				seoLede(
					isDust
						? "MOR token holders with dust balances under 0.01 MOR on Base, ranked by balance."
						: "Every MOR token holder on Base, ranked by balance and classified by on-chain role: providers, stakers, and builders.",
				) + content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__HOLDERS_MODE__ = "${mode}";</script>`,
				seoHead({
					path: holdersPath,
					keywords:
						"MOR holders, MOR token holders, MOR rich list, Morpheus holders, MOR token, decentralized AI, Base network AI",
					jsonLd: [
						breadcrumbLd([
							{ name: isDust ? "Dust Holders" : "Holders", path: holdersPath },
						]),
						...(price && price.usd > 0 ? [morPriceLd(price.usd)] : []),
					],
				}),
			].join("\n"),
		}),
		{ headers: HTML_HEADERS },
	);
}

// ─── Pools Overview Page ───

export async function handlePoolsPage(env: Env): Promise<Response> {
	const { handlePools } = await import("../pools");
	const [price, poolsResp] = await Promise.all([getCachedPrice(env), handlePools(env)]);
	let poolsData: Record<string, unknown> | null = null;
	try {
		poolsData = JSON.parse(await poolsResp.text());
	} catch {}

	const pc = poolsPlane("pools_overview" as Tab, [morStat(price)]);

	const { styles, content } = extractPage(poolsHtml as string);
	return new Response(
		render({
			title: "Morpheus Staking Pools - MorScan",
			description:
				"Morpheus staking pools on Base: on-chain staked MOR across the Compute and Builder contracts.",
			ogUrl: `${baseUrl()}/pools`,
			ogImage: `${baseUrl()}/og/pools.png`,
			subtitle: "Morpheus Staking Pools",
			active: "pools_overview",
			price,
			planeConfig: pc,
			pageStyles: styles,
			content:
				seoLede(
					"Morpheus staking pools on Base: on-chain staked MOR across the Compute and Builder contracts.",
				) + content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__POOLS_DATA__ = ${safeJson(poolsData)};</script>`,
				seoHead({
					path: "/pools",
					keywords:
						"Morpheus staking pools, MOR staking, Morpheus pools, MOR token, decentralized AI, Base network AI",
					jsonLd: [
						breadcrumbLd([{ name: "Pools", path: "/pools" }]),
						...(price && price.usd > 0 ? [morPriceLd(price.usd)] : []),
					],
				}),
			].join("\n"),
		}),
		{ headers: HTML_HEADERS },
	);
}

// ─── About (public, standalone - no shell header) ───

export function handleAboutPage(): Response {
	let html = aboutHtml as string;
	html = html.replace(
		"&copy; 2026 DRM3 Labs Corp.",
		`MorScan v${MORSCAN_VERSION} &copy; DRM3 Labs Corp.`,
	);
	// Absolute share-card URLs reflect the real serving origin.
	html = html.split("https://morscan.io").join(baseUrl());
	return new Response(withBuildFooter(html), {
		headers: { ...HTML_HEADERS, "Cache-Control": "public, s-maxage=60, max-age=30" },
	});
}

// ─── Verify (public, standalone - the human-facing receipt walkthrough) ───

/**
 * GET /verify - fetches a live signed response, checks its Ed25519 receipt
 * against /.well-known/morscan-keys.json IN THE VISITOR'S BROWSER (WebCrypto),
 * and narrates each step. The verification core in the page is the exact port
 * of scripts/verify-receipt.mjs; tests/unit/verify-page.test.ts holds the two
 * implementations byte-for-byte equal against a live-captured fixture.
 * /version stays the machine receipt; this is the human one.
 */
export function handleVerifyPage(): Response {
	const html = (verifyHtml as string).split("https://morscan.io").join(baseUrl());
	return new Response(withBuildFooter(html), {
		headers: { ...HTML_HEADERS, "Cache-Control": "public, s-maxage=60, max-age=30" },
	});
}

// ─── 404 ───

export function handle404(): Response {
	const html = (notFoundHtml as string).split("https://morscan.io").join(baseUrl());
	return new Response(withBuildFooter(html), { status: 404, headers: HTML_HEADERS });
}

/**
 * Server-rendered "network at a glance" stats for the landing page. The rest of
 * the page hydrates its live numbers client-side, which leaves a bare fetcher or
 * an AI crawler (no JS) looking at empty tiles. This block bakes the real values
 * straight into the HTML from the SAME canonical sources the SPA reads (cached
 * price + KV metrics summary + holder count), so a no-JS read sees actual
 * numbers. Cheap: one D1 price read, one KV metrics read, one holder COUNT; the
 * page is edge-cached (s-maxage) so origin recomputes are throttled. Fails soft
 * to an empty string so a data hiccup never blanks the page.
 */
async function renderLandingStats(env: Env): Promise<string> {
	try {
		const MIN_WEI = "10000000000000000"; // 0.01 MOR (matches the holders page)
		const [price, metrics, holderCounts] = await Promise.all([
			getCachedPrice(env),
			getNetworkMetrics(env),
			getMorHolderTierCounts(env.DB, MIN_WEI).catch(() => null),
		]);
		const nf = new Intl.NumberFormat("en-US");
		const hasPrice = !!(price && price.usd > 0);
		const priceUsd = hasPrice ? `$${(price as { usd: number }).usd.toFixed(2)}` : "-";
		const ch = price?.change24h ?? 0;
		const chColor = ch >= 0 ? "var(--green)" : "#f87171";
		const chStr = hasPrice
			? ` <span class="d" style="color:${chColor}">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}% (24h)</span>`
			: "";
		const mcapNum = price?.marketCap ?? 0;
		const mcap = mcapNum >= 1e6 ? `$${(mcapNum / 1e6).toFixed(1)}M` : "-";
		const holders =
			holderCounts?.with_balance != null ? nf.format(holderCounts.with_balance) : "-";
		return `<section class="ssr-stats" aria-label="Live Morpheus network stats">
    <h2 class="ssr-stats-h">Morpheus network at a glance</h2>
    <dl class="ssr-grid">
      <div><dt>MOR price</dt><dd>${priceUsd}${chStr}</dd></div>
      <div><dt>Market cap</dt><dd>${mcap}</dd></div>
      <div><dt>Providers</dt><dd>${nf.format(metrics.providers)}</dd></div>
      <div><dt>Active sessions</dt><dd>${nf.format(metrics.activeSessions)}</dd></div>
      <div><dt>Total sessions</dt><dd>${nf.format(metrics.totalSessions)}</dd></div>
      <div><dt>MOR holders</dt><dd>${holders}</dd></div>
    </dl>
    <p class="ssr-note">Live on-chain data from Base, indexed by MorScan and signed with Ed25519 provenance receipts so every number is independently verifiable. Explore <a href="/analytics/overview" style="color:var(--green);text-decoration:none">network analytics</a>, <a href="/compute/providers" style="color:var(--green);text-decoration:none">compute providers and sessions</a>, <a href="/holders/all" style="color:var(--green);text-decoration:none">MOR token holders</a>, <a href="/builder/subnets" style="color:var(--green);text-decoration:none">builder subnets</a>, and <a href="/pools" style="color:var(--green);text-decoration:none">staking pools</a>, or query the <a href="/api/playground" style="color:var(--green);text-decoration:none">API</a>.</p>
  </section>`;
	} catch {
		return "";
	}
}

/**
 * Public landing page - the open-access front door. Static shell; live data
 * (teaser, price, chart) is fetched client-side from public endpoints, but the
 * headline stats are also server-rendered (renderLandingStats) so a no-JS
 * fetcher/AI crawler reads real numbers. {{REGISTER_URL}} is the
 * operator-configured signup/upgrade link.
 */
export async function handleLandingPage(env: Env): Promise<Response> {
	const ssrStats = await renderLandingStats(env);
	const html = landingHtml
		.split("{{PRICE_WIDGET}}")
		.join(priceWidgetHtml as string)
		.split("{{REGISTER_URL}}")
		.join(env.REGISTER_URL || "/api/playground")
		.split("{{BASE_URL}}")
		.join(baseUrl())
		.split("{{SERVING_KEY}}")
		.join(escJs(env.MORSCAN_DEMO_KEY || ""))
		.split("{{SSR_STATS}}")
		.join(ssrStats);
	return new Response(withBuildFooter(html), { headers: HTML_HEADERS });
}

export function handleTermsPage(): Response {
	const html = (termsHtml as string).split("{{BASE_URL}}").join(baseUrl());
	return new Response(withBuildFooter(html), { headers: HTML_HEADERS });
}

// ─── Contribute (public, standalone - open-source invitation) ───

export function handleContributePage(): Response {
	const html = (contributeHtml as string).split("{{BASE_URL}}").join(baseUrl());
	return new Response(withBuildFooter(html), {
		headers: { ...HTML_HEADERS, "Cache-Control": "public, s-maxage=60, max-age=30" },
	});
}

export function handlePrivacyPage(): Response {
	const html = (privacyHtml as string).split("{{BASE_URL}}").join(baseUrl());
	return new Response(withBuildFooter(html), { headers: HTML_HEADERS });
}

/**
 * /stake - public, standalone stake-for-capacity page. Injects the UI serving
 * key (the site serving itself) so the live subnet stats strip can call
 * /mor/v1/builder/subnets.
 */
export function handleStakePage(env: Env): Response {
	const html = (stakeHtml as string)
		.split("{{BASE_URL}}")
		.join(baseUrl())
		.split("{{DAILY_EMISSIONS}}")
		.join(String(Math.round(builderDailyEmissions())))
		.split("{{API_KEY}}")
		.join(escJs(env.MORSCAN_DEMO_KEY || ""));
	return new Response(withBuildFooter(html), {
		headers: { ...HTML_HEADERS, "Cache-Control": "public, s-maxage=60, max-age=30" },
	});
}
