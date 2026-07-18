/**
 * UI Handlers - Fatboy SPA + detail pages + API playground
 *
 * handleAppPage: serves the SPA for /network, /providers, /consumers.
 *   Reads the pre-built fatboy blob from D1 (1 read). All views render client-side.
 *
 * handleApiPage: standalone API playground page.
 * handleProviderDetailPage, handleWalletDetailPage: separate SSR pages.
 */

import type { Env } from "../../types";
import { baseUrl } from "../../config";
import { handleWalletDetail } from "../sessions";
import { handleProviderDetail } from "../provider-detail";
import { handleModelDetail } from "../model-detail";
import { buildFatboy } from "../fatboy";
import { render, type StatBarData } from "../../ui/shell";
import {
	analyticsPlane,
	computePlane,
	apiPlane,
	type Tab,
} from "../../ui/morscan_header";
import {
	HTML_HEADERS,
	JSON_HEADERS,
	morStat,
	escJs,
	safeJson,
	getCachedPrice,
	getStatBarData,
	extractPage,
	pathToTab,
} from "./shared";
import { seoHead, seoLede, breadcrumbLd, morPriceLd } from "./seo";
import {
	getLatestDiamondUpgrade,
	countDiamondUpgrades,
	getProviderEndpointStake,
	countActiveBidsForProvider,
} from "../../db/explorer-market";
import { selectFatboyCache } from "../../db/explorer-core";
import {
	getWalletBuilderStakes,
	getWalletAdminSubnets,
} from "../../db/explorer-sessions";

const COMPUTE_KEYWORDS =
	"Morpheus AI, MOR token, AI compute marketplace, AI inference marketplace, decentralized AI, Morpheus providers, Morpheus sessions, Base network AI, MOR staking";

// Re-export shared helpers so the `./handlers/ui` barrel keeps its surface.
export {
	HTML_HEADERS,
	JSON_HEADERS,
	morStat,
	escJs,
	safeJson,
	getCachedPrice,
	getStatBarData,
	extractPage,
	pathToTab,
} from "./shared";

import appMarkup from "../../ui/partials/app-markup.html";
import appScript from "../../ui/partials/app-script.html";
import analyticsTabHtml from "../../ui/partials/analytics-tab.html";
import apiStyles from "../../ui/partials/api-styles.html";
import apiMarkup from "../../ui/partials/api-markup.html";
import apiScript1 from "../../ui/partials/api-script-1.html";
import apiScript2 from "../../ui/partials/api-script-2.html";
import providerDetailMarkup from "../../ui/partials/provider-detail-markup.html";
import providerDetailScript from "../../ui/partials/provider-detail-script.html";
import walletDetailMarkup from "../../ui/partials/wallet-detail-markup.html";
import walletDetailScript from "../../ui/partials/wallet-detail-script.html";
import modelDetailMarkup from "../../ui/partials/model-detail-markup.html";
import modelDetailScript from "../../ui/partials/model-detail-script.html";

// app.html, api.html, provider-detail.html, wallet-detail.html were each split
// into <250-LOC fragments; recombine byte-identically.
const appHtml = (appMarkup as string) + (appScript as string);
const apiHtml =
	(apiStyles as string) +
	(apiMarkup as string) +
	(apiScript1 as string) +
	(apiScript2 as string);
const providerDetailHtml =
	(providerDetailMarkup as string) + (providerDetailScript as string);
const walletDetailHtml = (walletDetailMarkup as string) + (walletDetailScript as string);
const modelDetailHtml = (modelDetailMarkup as string) + (modelDetailScript as string);

// ─── App (SPA - all 4 tabs) ───

export async function handleAppPage(env: Env, path: string): Promise<Response> {
	// Read pre-built fatboy blob (1 D1 read). Falls back to live build on cache miss.
	let fatboy: Record<string, unknown> | null = null;
	try {
		const row = await selectFatboyCache(env.DB);
		if (row) fatboy = JSON.parse(row.value);
	} catch {}
	if (!fatboy) fatboy = await buildFatboy(env);

	const fatboyPrice = fatboy.price as Record<string, unknown> | null;
	const fatboyStats = fatboy.stats as Record<string, unknown> | null;
	const price = fatboyPrice
		? {
				usd: fatboyPrice.usd as number,
				change24h: fatboyPrice.change24h as number,
				marketCap: fatboyPrice.marketCap as number,
			}
		: await getCachedPrice(env);
	const statBar: StatBarData = {
		morPrice: price && price.usd > 0 ? `$${price.usd.toFixed(2)}` : "-",
		providerCount: String(fatboyStats?.providers || 0),
		activeSessions: String(fatboyStats?.serving || 0),
		morStaked: `${new Intl.NumberFormat().format((fatboyStats?.morServing as number) || 0)} MOR`,
	};

	const { styles, content } = extractPage(appHtml as string);

	let upgradeStatus: string | undefined;
	try {
		const lastUpgrade = await getLatestDiamondUpgrade(env.DB);
		const upgradeCount = await countDiamondUpgrades(env.DB);
		if (lastUpgrade) {
			const ts = (lastUpgrade as Record<string, unknown>).block_timestamp as number;
			const ago = Math.floor(Date.now() / 1000) - ts;
			const agoStr =
				ago < 3600
					? `${Math.floor(ago / 60)}m ago`
					: ago < 86400
						? `${Math.floor(ago / 3600)}h ago`
						: `${Math.floor(ago / 86400)}d ago`;
			// Short enough to ride the one-row contract strip without wrapping the
			// sync cluster onto a second line (the container caps at 1200px, so
			// every extra word here costs the row). Block + count live in the title.
			upgradeStatus = `<span style="color:var(--yellow);" title="Last upgrade: block ${((lastUpgrade as Record<string, unknown>).block_number as number).toLocaleString()} &middot; ${upgradeCount?.count || 1} total">Upgraded ${agoStr}</span>`;
		} else {
			upgradeStatus = `<span style="color:var(--text-muted);">No upgrades</span>`;
		}
	} catch {
		upgradeStatus = undefined;
	}

	const activeTab = pathToTab(path) as Tab;
	const planeConfig = computePlane(
		activeTab,
		[
			{ label: "MOR", value: statBar.morPrice, id: "stat-mor" },
			{ label: "Providers", value: statBar.providerCount },
			{ label: "Sessions", value: statBar.activeSessions },
			{ label: "In Sessions", value: statBar.morStaked },
			// The sessions tab additionally shows the all-time total (same fatboy
			// stat every other surface uses - no extra query).
			...(activeTab === "sessions"
				? [
						{
							label: "Total Sessions",
							value: new Intl.NumberFormat().format(
								(fatboyStats?.totalSessions as number) || 0,
							),
						},
					]
				: []),
		],
		upgradeStatus,
	);

	// Per-tab, keyword-led meta so each compute surface ranks for its own term.
	const meta = {
		providers: {
			title: "Morpheus AI Providers - MorScan",
			description:
				"Every AI compute provider on the Morpheus network on Base, with the models they serve, per-second bids, sessions, and reputation.",
			crumb: "Providers",
			path: "/compute/providers",
			lede: "Every AI compute provider on the Morpheus network, with the models they serve, their per-second bids, sessions, and reputation on Base.",
		},
		consumers: {
			title: "Morpheus AI Consumers - MorScan",
			description:
				"Morpheus consumer wallets on Base: who stakes MOR to run AI models. Top wallets, gas costs, the stake calculator, and recent activity.",
			crumb: "Consumers",
			path: "/compute/consumers",
			lede: "Consumers stake MOR to open inference sessions on the Morpheus network. Browse top wallets, gas costs, and their on-chain activity.",
		},
		sessions: {
			title: "Morpheus Inference Sessions - MorScan",
			description:
				"Every inference session on the Morpheus network on Base: model, provider, consumer wallet, MOR stake, status, and duration - indexed live.",
			crumb: "Sessions",
			path: "/compute/sessions",
			lede: "Every inference session on the Morpheus network on Base: model, provider, consumer wallet, MOR stake, status, and duration, newest first.",
		},
		network: {
			title: "Morpheus Compute Network - MorScan",
			description:
				"The live Morpheus AI compute marketplace on Base: providers, model bids, and open inference sessions, indexed in real time and signed.",
			crumb: "Network",
			path: "/compute/network",
			lede: "The live state of the Morpheus AI compute marketplace on Base: providers, model bids, and open inference sessions, indexed in real time.",
		},
	}[
		activeTab === "providers"
			? "providers"
			: activeTab === "consumers"
				? "consumers"
				: activeTab === "sessions"
					? "sessions"
					: "network"
	];

	return new Response(
		render({
			title: meta.title,
			description: meta.description,
			ogUrl: `${baseUrl()}${path}`,
			ogImage: `${baseUrl()}/og/compute.png`,
			subtitle: "Morpheus Compute Explorer",
			active: activeTab,
			price,
			planeConfig,
			pageStyles: styles,
			content: seoLede(meta.lede) + content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__FATBOY__ = ${safeJson(fatboy)};</script>`,
				seoHead({
					path: meta.path,
					keywords: COMPUTE_KEYWORDS,
					jsonLd: [
						breadcrumbLd([
							{ name: "Compute", path: "/compute/network" },
							{ name: meta.crumb, path: meta.path },
						]),
						...(price && price.usd > 0 ? [morPriceLd(price.usd)] : []),
					],
				}),
			].join("\n"),
		}),
		{ headers: HTML_HEADERS },
	);
}

// ─── Analytics Tab (inside MorScan layout) ───

export async function handleAnalyticsTabPage(env: Env): Promise<Response> {
	const price = await getCachedPrice(env);
	const statBar = await getStatBarData(env, price);
	const { styles, content } = extractPage(analyticsTabHtml as string);
	const planeConfig = analyticsPlane([
		morStat(price),
		{ label: "Providers", value: statBar.providerCount },
		{ label: "Sessions", value: statBar.activeSessions },
		{ label: "In Sessions", value: statBar.morStaked },
	]);

	return new Response(
		render({
			title: "Morpheus Network Analytics - MorScan",
			description:
				"Live analytics for the Morpheus decentralized AI network on Base: gas, sessions, provider demand, and network economics.",
			ogUrl: `${baseUrl()}/analytics/overview`,
			ogImage: `${baseUrl()}/og/analytics.png`,
			subtitle: "Morpheus Compute Explorer",
			active: "analytics",
			price,
			planeConfig,
			pageStyles: styles,
			content:
				seoLede(
					"Live analytics for the Morpheus decentralized AI network: gas, inference sessions, provider demand, and network economics on Base.",
				) + content,
			headScripts: [
				`<script>window.__DEMO_KEY__="${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				seoHead({
					path: "/analytics/overview",
					keywords: COMPUTE_KEYWORDS,
					jsonLd: [
						breadcrumbLd([{ name: "Analytics", path: "/analytics/overview" }]),
						...(price && price.usd > 0 ? [morPriceLd(price.usd)] : []),
					],
				}),
			].join("\n"),
		}),
		{ headers: HTML_HEADERS },
	);
}

// ─── API Playground (standalone page, not part of SPA) ───

export async function handleApiPage(
	env: Env,
	path = "/api/playground",
): Promise<Response> {
	const price = await getCachedPrice(env);
	const statBar = await getStatBarData(env, price);
	const { styles, content } = extractPage(apiHtml as string);
	const isDocs = path === "/api/docs";
	const activeTab = (isDocs ? "api_docs" : "api") as Tab;
	const planeConfig = apiPlane(activeTab, [
		{ label: "MOR", value: statBar.morPrice, id: "stat-mor" },
	]);
	return new Response(
		render({
			title: isDocs ? "Morpheus API Docs - MorScan" : "Morpheus API Playground - MorScan",
			description: isDocs
				? "OpenAPI 3.1 reference for the MorScan API: Morpheus providers, sessions, models, MOR price, and staking on Base. Signed responses, free key."
				: "Query the Morpheus network through the MorScan API: providers, sessions, models, MOR price, and staking on Base. Signed responses, free key.",
			ogUrl: `${baseUrl()}${path}`,
			ogImage: `${baseUrl()}/og/api.png`,
			subtitle: "MorScan API",
			active: activeTab,
			price,
			planeConfig,
			pageStyles: styles,
			content: accessStrip() + content,
			// No key is embedded: this page is edge-cached, and keys are personal now.
			// The client script asks /console/wallet/status (session cookie, no-store)
			// for the visitor's own key and shows the connect CTA otherwise.
			headScripts: `<script>window.MORSCAN_API_KEY = "";</script>${isDocs ? '<script>window.__API_START_TAB__="docs";</script>' : ""}\n${seoHead(
				{
					path,
					keywords:
						"Morpheus API, MOR API, Morpheus blockchain API, AI inference API, decentralized AI data, Base network AI, OpenAPI",
					jsonLd: [
						breadcrumbLd([{ name: isDocs ? "API Docs" : "API Playground", path }]),
					],
				},
			)}`,
		}),
		{ headers: HTML_HEADERS },
	);
}

// Access tiers strip shown above the playground. The wallet is the front
// door: connect for a free bottom-tier key, stake MOR for capacity.
function accessStrip(): string {
	return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1px;background:var(--border);border:1px solid var(--border);margin-bottom:1.25rem;font-size:0.68rem">
    <div style="background:var(--bg-secondary);padding:0.85rem 1rem"><strong style="color:var(--green)">Connected wallet</strong><div style="color:var(--text-muted);margin-top:0.2rem">Free key, 60 req/min. No email, no signup. <a href="/console" style="color:var(--green);text-decoration:none">Connect your wallet &rarr;</a></div></div>
    <div style="background:var(--bg-secondary);padding:0.85rem 1rem"><strong>Staked capacity</strong><div style="color:var(--text-muted);margin-top:0.2rem">3 requests/min per MOR staked, volume caps rise with stake. <a href="/stake" style="color:var(--green);text-decoration:none">Stake on the MorScan subnet &rarr;</a></div></div>
  </div>`;
}

// ─── Provider Detail ───

export async function handleProviderDetailPage(
	env: Env,
	address: string,
): Promise<Response> {
	const [price, detailResp, statBar] = await Promise.all([
		getCachedPrice(env),
		handleProviderDetail(env, address, JSON_HEADERS),
		getStatBarData(env, null),
	]);
	let data: Record<string, unknown> | null = null;
	try {
		data = JSON.parse(await detailResp.text());
	} catch {}
	const { styles, content } = extractPage(providerDetailHtml as string);
	const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
	return new Response(
		render({
			title: data ? `Provider ${shortAddr} - MorScan` : "Provider Not Found",
			description:
				"Morpheus AI compute provider on Base: models served, per-second bids, sessions, and reputation.",
			ogUrl: `${baseUrl()}/compute/providers/${address}`,
			subtitle: "Morpheus Compute Explorer",
			active: "providers",
			price,
			planeConfig: computePlane("providers" as Tab, [
				morStat(price),
				{ label: "Providers", value: statBar.providerCount },
				{ label: "Sessions", value: statBar.activeSessions },
				{ label: "In Sessions", value: statBar.morStaked },
			]),
			pageStyles: styles,
			content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__PROVIDER_DATA__ = ${safeJson(data)};</script>`,
				seoHead({
					path: `/compute/providers/${address}`,
					keywords: COMPUTE_KEYWORDS,
					jsonLd: [
						breadcrumbLd([
							{ name: "Compute", path: "/compute/network" },
							{ name: "Providers", path: "/compute/providers" },
							{ name: shortAddr, path: `/compute/providers/${address}` },
						]),
					],
				}),
			].join("\n"),
		}),
		{ status: data ? 200 : 404, headers: HTML_HEADERS },
	);
}

// ─── Model Detail ───

export async function handleModelDetailPage(
	env: Env,
	modelId: string,
): Promise<Response> {
	const [price, detailResp, statBar] = await Promise.all([
		getCachedPrice(env),
		handleModelDetail(env, modelId, JSON_HEADERS),
		getStatBarData(env, null),
	]);
	let data: Record<string, unknown> | null = null;
	try {
		data = JSON.parse(await detailResp.text());
	} catch {}
	if (data && (data as Record<string, unknown>).error) data = null;
	const model = (data?.model || {}) as Record<string, unknown>;
	const name = (model.name as string) || `${modelId.slice(0, 10)}...${modelId.slice(-4)}`;
	const modelDesc = (model.description as string) || "";
	const metaDescription = modelDesc
		? `${name} on the Morpheus AI network: ${modelDesc}`.slice(0, 300)
		: `${name} on the Morpheus AI network on Base: live provider bids, per-second pricing, inference sessions, and provider reputation.`;
	const { styles, content } = extractPage(modelDetailHtml as string);
	return new Response(
		render({
			title: data ? `${name} on Morpheus - MorScan` : "Model Not Found",
			description: metaDescription,
			ogUrl: `${baseUrl()}/compute/models/${modelId}`,
			subtitle: "Morpheus Compute Explorer",
			active: "network",
			price,
			planeConfig: computePlane("network" as Tab, [
				morStat(price),
				{ label: "Providers", value: statBar.providerCount },
				{ label: "Sessions", value: statBar.activeSessions },
				{ label: "In Sessions", value: statBar.morStaked },
			]),
			pageStyles: styles,
			content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__MODEL_DATA__ = ${safeJson(data)};window.__MOR_USD__ = ${price && price.usd > 0 ? price.usd : 0};</script>`,
				seoHead({
					path: `/compute/models/${modelId}`,
					keywords: COMPUTE_KEYWORDS,
					jsonLd: [
						breadcrumbLd([
							{ name: "Compute", path: "/compute/network" },
							{ name: "Models", path: "/analytics/overview" },
							{ name, path: `/compute/models/${modelId}` },
						]),
					],
				}),
			].join("\n"),
		}),
		{ status: data ? 200 : 404, headers: HTML_HEADERS },
	);
}

// ─── Wallet Detail ───

/**
 * The unified wallet profile: every role this address plays on the network.
 * Provider (providers table), Builder (stakes across all subnets + subnets it
 * administers), on top of the existing consumer balances/sessions view.
 */
async function walletProfileData(
	env: Env,
	address: string,
): Promise<Record<string, unknown>> {
	const addr = address.toLowerCase();
	const [providerRow, bidsRow, stakeRows, adminRows] = await Promise.all([
		getProviderEndpointStake(env.DB, addr).catch(() => null),
		countActiveBidsForProvider(env.DB, addr).catch(() => null),
		getWalletBuilderStakes(env.DB, addr).catch(() => null),
		getWalletAdminSubnets(env.DB, addr).catch(() => null),
	]);
	const toMor = (wei: string | null | undefined): number => {
		try {
			return Number(BigInt(wei || "0")) / 1e18;
		} catch {
			return 0;
		}
	};
	return {
		provider: providerRow
			? {
					endpoint: providerRow.endpoint || "",
					stakeMor: toMor(providerRow.stake),
					activeBids: bidsRow?.cnt || 0,
				}
			: null,
		builderStakes: (stakeRows || []).map((r) => ({
			subnetId: r.subnet_id,
			name: r.name,
			depositedMor: toMor(r.deposited),
		})),
		adminSubnets: (adminRows || []).map((r) => ({ subnetId: r.subnet_id, name: r.name })),
	};
}

export async function handleWalletDetailPage(
	env: Env,
	address: string,
): Promise<Response> {
	const [price, detailResp, profile] = await Promise.all([
		getCachedPrice(env),
		handleWalletDetail(env, address, JSON_HEADERS),
		walletProfileData(env, address),
	]);
	const statBar = await getStatBarData(env, price);
	let data: Record<string, unknown> | null = null;
	try {
		data = JSON.parse(await detailResp.text());
	} catch {}
	if (data) data.walletProfile = profile;
	const { styles, content } = extractPage(walletDetailHtml as string);
	const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
	return new Response(
		render({
			title: `Wallet ${shortAddr} - MorScan`,
			description:
				"Morpheus wallet on Base: MOR balance, inference sessions, provider role, and builder subnet stakes.",
			ogUrl: `${baseUrl()}/compute/consumers/wallet/${address}`,
			subtitle: "Morpheus Compute Explorer",
			active: "consumers",
			price,
			planeConfig: computePlane("consumers" as Tab, [
				morStat(price),
				{ label: "Providers", value: statBar.providerCount },
				{ label: "Sessions", value: statBar.activeSessions },
				{ label: "In Sessions", value: statBar.morStaked },
			]),
			pageStyles: styles,
			content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__WALLET_DATA__ = ${safeJson(data)};</script>`,
				seoHead({
					path: `/compute/consumers/wallet/${address}`,
					keywords: COMPUTE_KEYWORDS,
					jsonLd: [
						breadcrumbLd([
							{ name: "Compute", path: "/compute/network" },
							{ name: "Consumers", path: "/compute/consumers" },
							{ name: shortAddr, path: `/compute/consumers/wallet/${address}` },
						]),
					],
				}),
			].join("\n"),
		}),
		{ headers: HTML_HEADERS },
	);
}
