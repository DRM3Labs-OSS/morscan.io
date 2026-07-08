/**
 * UI Handlers - Builder plane pages
 */

import type { Env } from "../../types";
import { baseUrl } from "../../config";
import { render } from "../../ui/shell";
import { builderPlane, type Tab } from "../../ui/morscan_header";
import {
	getCachedPrice,
	extractPage,
	morStat,
	escJs,
	safeJson,
	HTML_HEADERS,
} from "./shared";
import { builderDailyEmissions, morNumber } from "../builder-shared";
import { countBuilderSubnets, getBuilderSubnetName } from "../../db/explorer-market";
import { getBuilderSyncStateValue } from "../../db/sync-builder";
import { seoHead, seoLede, breadcrumbLd, morPriceLd } from "./seo";

const BUILDER_KEYWORDS =
	"Morpheus builder subnets, MOR staking, MOR emissions, Morpheus staking, builder rewards, decentralized AI, Base network AI, MOR token";

import builderHtml from "../../ui/pages/builder.html";
import builderCalcHtml from "../../ui/pages/builder-calc.html";
import builderSubnetHtml from "../../ui/pages/builder-subnet.html";
import apiStyles from "../../ui/partials/api-styles.html";
import apiMarkup from "../../ui/partials/api-markup.html";
import apiScript1 from "../../ui/partials/api-script-1.html";
import apiScript2 from "../../ui/partials/api-script-2.html";

// api.html was split into 3 fragments (<250 LOC each); recombine byte-identically.
const apiHtml =
	(apiStyles as string) +
	(apiMarkup as string) +
	(apiScript1 as string) +
	(apiScript2 as string);

// ─── Builder Subnets Page ───

export async function handleBuilderPage(env: Env): Promise<Response> {
	const { handleBuilderAll } = await import("../builder");
	const [price, builderResp] = await Promise.all([
		getCachedPrice(env),
		handleBuilderAll(env),
	]);
	let builderData: Record<string, unknown> | null = null;
	try {
		builderData = JSON.parse(await builderResp.text());
	} catch {}
	const builderContract =
		env.BUILDER_CONTRACT || "0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9";

	const pc = builderPlane("builder_subnets" as Tab, [
		morStat(price),
		{ label: "Subnets", value: "-", id: "stat-bar-subnets" },
		{ label: "Builder Staked", value: "-", id: "stat-bar-staked" },
		{ label: "All Pools", value: "-", id: "stat-bar-all-pools" },
		{ label: "Est. APR", value: "-", id: "stat-bar-apr" },
		{ label: "Daily Emissions", value: "-", id: "stat-bar-daily" },
		{ label: "Pending", value: "-", id: "stat-bar-pending" },
	]);
	pc.contract = {
		icon: "\u{1F3D7}\u{FE0F}",
		label: "Builder Contract",
		address: builderContract,
	};

	const dailyEmissions = Math.round(builderDailyEmissions());
	const { styles, content } = extractPage(
		(builderHtml as string).split("{{DAILY_EMISSIONS}}").join(String(dailyEmissions)),
	);
	return new Response(
		render({
			title: "Morpheus Builder Subnets - MorScan",
			description:
				"Morpheus builder subnets on Base: every subnet's stake, daily MOR emissions, and estimated APR. Stake MOR and earn builder rewards.",
			ogUrl: `${baseUrl()}/builder/subnets`,
			ogImage: `${baseUrl()}/og/builder.png`,
			subtitle: "Morpheus Builder Net Explorer",
			active: "builder_subnets",
			price,
			planeConfig: pc,
			pageStyles: styles,
			content:
				seoLede(
					"Morpheus builder subnets earn MOR emissions. Track every subnet's stake, daily emissions, and estimated APR on Base.",
				) + content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__BUILDER_DATA__ = ${safeJson(builderData)};</script>`,
				seoHead({
					path: "/builder/subnets",
					keywords: BUILDER_KEYWORDS,
					jsonLd: [
						breadcrumbLd([
							{ name: "Builder", path: "/builder/subnets" },
							{ name: "Subnets", path: "/builder/subnets" },
						]),
						...(price && price.usd > 0 ? [morPriceLd(price.usd)] : []),
					],
				}),
			].join("\n"),
		}),
		{ headers: HTML_HEADERS },
	);
}

// ─── Builder Calculator Page ───

export async function handleBuilderCalcPage(env: Env): Promise<Response> {
	const { handleBuilderStats } = await import("../builder");
	const [price, statsResp] = await Promise.all([
		getCachedPrice(env),
		handleBuilderStats(env),
	]);
	let builderStats: Record<string, unknown> | null = null;
	try {
		builderStats = JSON.parse(await statsResp.text());
	} catch {}
	const builderContract =
		env.BUILDER_CONTRACT || "0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9";

	const pc = builderPlane("builder_calc" as Tab, [
		morStat(price),
		{ label: "Subnets", value: "-", id: "stat-bar-subnets" },
		{ label: "Builder Staked", value: "-", id: "stat-bar-staked" },
		{ label: "All Pools", value: "-", id: "stat-bar-all-pools" },
		{ label: "Est. APR", value: "-", id: "stat-bar-apr" },
		{ label: "Daily Emissions", value: "-", id: "stat-bar-daily" },
		{ label: "Pending", value: "-", id: "stat-bar-pending" },
	]);
	pc.contract = {
		icon: "\u{1F3D7}\u{FE0F}",
		label: "Builder Contract",
		address: builderContract,
	};

	const dailyEmissions = Math.round(builderDailyEmissions());
	const { styles, content } = extractPage(
		(builderCalcHtml as string).split("{{DAILY_EMISSIONS}}").join(String(dailyEmissions)),
	);
	return new Response(
		render({
			title: "Morpheus Builder Calculator - MorScan",
			description:
				"Estimate Morpheus builder subnet emissions and MOR staking rewards on Base, from live daily emissions and pool stake.",
			ogUrl: `${baseUrl()}/builder/calculator`,
			ogImage: `${baseUrl()}/og/builder.png`,
			subtitle: "Morpheus Builder Net Explorer",
			active: "builder_calc",
			price,
			planeConfig: pc,
			pageStyles: styles,
			content:
				seoLede(
					"Estimate Morpheus builder subnet emissions and MOR staking rewards from live daily emissions and total pool stake on Base.",
				) + content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__BUILDER_DATA__ = ${safeJson(builderStats)};</script>`,
				builderStats
					? `<script>document.addEventListener('DOMContentLoaded',function(){var d=window.__BUILDER_DATA__;if(!d)return;var e=document.getElementById('stat-bar-subnets');if(e)e.textContent=d.subnetCount;var s=document.getElementById('stat-bar-staked');if(s)s.textContent=d.totalDeposited+' MOR';var a=document.getElementById('stat-bar-apr');if(a)a.textContent=d.apr;});</script>`
					: "",
				seoHead({
					path: "/builder/calculator",
					keywords: BUILDER_KEYWORDS,
					jsonLd: [
						breadcrumbLd([
							{ name: "Builder", path: "/builder/subnets" },
							{ name: "Calculator", path: "/builder/calculator" },
						]),
					],
				}),
			].join("\n"),
		}),
		{ headers: HTML_HEADERS },
	);
}

// ─── Builder API Page ───

export async function handleBuilderApiPage(env: Env): Promise<Response> {
	const price = await getCachedPrice(env);
	const builderContract =
		env.BUILDER_CONTRACT || "0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9";
	const pc = builderPlane("builder_api" as Tab, [morStat(price)]);
	pc.contract = {
		icon: "\u{1F3D7}\u{FE0F}",
		label: "Builder Contract",
		address: builderContract,
	};

	const { styles, content } = extractPage(apiHtml as string);
	return new Response(
		render({
			title: "Morpheus Builder API - MorScan",
			description:
				"MorScan API playground for Morpheus compute and builder endpoints on Base. Query subnets, emissions, and staking with signed responses.",
			ogUrl: `${baseUrl()}/builder/api`,
			ogImage: `${baseUrl()}/og/builder.png`,
			subtitle: "Morpheus Builder Net Explorer",
			active: "builder_api",
			price,
			planeConfig: pc,
			pageStyles: styles,
			content,
			headScripts: `<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>\n${seoHead(
				{
					path: "/builder/api",
					keywords: BUILDER_KEYWORDS,
					jsonLd: [
						breadcrumbLd([
							{ name: "Builder", path: "/builder/subnets" },
							{ name: "API", path: "/builder/api" },
						]),
					],
				},
			)}`,
		}),
		{ headers: HTML_HEADERS },
	);
}

// ─── Builder Subnet Detail Page ───

export async function handleBuilderSubnetPage(
	env: Env,
	subnetId: string,
): Promise<Response> {
	// Fetch lightweight global stats (fast D1 read) but NOT the heavy subnet detail
	const [price, globalRow, subnetCountRow] = await Promise.all([
		getCachedPrice(env),
		getBuilderSyncStateValue(env.DB, "global_stats"),
		countBuilderSubnets(env.DB),
	]);
	const globalStats = globalRow ? JSON.parse(globalRow.value as string) : {};
	const subnetCount = (subnetCountRow?.cnt as number) || 0;
	const totalDep = globalStats.total_deposited
		? (BigInt(globalStats.total_deposited) / BigInt(1e14)).toString()
		: "0";
	const totalDepMor = (parseInt(totalDep, 10) / 10000).toFixed(0);
	// ONE APR formula, shared with /mor/v1/builder/stats: live decayed emissions
	// over the builder pool's total deposited MOR. Previously this page used a
	// hardcoded 2967.14 over all_pools_total, disagreeing with the /builder
	// header (44% vs 11%). Same inputs now => same network builder APR.
	const totalDepositedMor = morNumber(globalStats.total_deposited || "0");
	const apr =
		totalDepositedMor > 0
			? (((builderDailyEmissions() * 365) / totalDepositedMor) * 100).toFixed(1)
			: "0";
	const builderStats = {
		subnetCount,
		totalDeposited: Number(totalDepMor).toLocaleString(),
		apr: `${apr}%`,
	};

	const builderContract =
		env.BUILDER_CONTRACT || "0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9";
	const nameRow = await getBuilderSubnetName(env.DB, subnetId).catch(() => null);
	const subnetName = nameRow?.name || `${subnetId.slice(0, 10)}...`;

	const pc = builderPlane("builder_subnets" as Tab, [
		morStat(price),
		{ label: "Subnets", value: "-", id: "stat-bar-subnets" },
		{ label: "Total Staked", value: "-", id: "stat-bar-staked" },
		{ label: "Est. APR", value: "-", id: "stat-bar-apr" },
	]);
	pc.contract = {
		icon: "\u{1F3D7}\u{FE0F}",
		label: "Builder Contract",
		address: builderContract,
	};

	const { styles, content } = extractPage(builderSubnetHtml as string);
	return new Response(
		render({
			title: `${subnetName} - Builder Subnet - MorScan`,
			description: `${subnetName} on the Morpheus network. Stake, stakers, and live activity on MorScan.`,
			ogUrl: `${baseUrl()}/builder/subnet/${subnetId}`,
			ogImage: `${baseUrl()}/og/subnet/${subnetId}.png`,
			subtitle: "Morpheus Builder Net Explorer",
			active: "builder_subnets",
			price,
			planeConfig: pc,
			pageStyles: styles,
			content,
			headScripts: [
				`<script>window.MORSCAN_API_KEY = "${escJs(env.MORSCAN_DEMO_KEY || "")}";</script>`,
				`<script>window.__SUBNET_ID__ = "${escJs(subnetId)}";</script>`,
				`<script>window.__MOR_PRICE__ = ${price?.usd ?? 0};</script>`,
				`<script>window.__SUBNET_DATA__ = null;</script>`,
				`<script>window.__BUILDER_DATA__ = ${JSON.stringify(builderStats)};</script>`,
				`<script>document.addEventListener('DOMContentLoaded',function(){var d=window.__BUILDER_DATA__;if(!d)return;var e=document.getElementById('stat-bar-subnets');if(e)e.textContent=d.subnetCount;var s=document.getElementById('stat-bar-staked');if(s)s.textContent=d.totalDeposited+' MOR';var a=document.getElementById('stat-bar-apr');if(a)a.textContent=d.apr;});</script>`,
				seoHead({
					path: `/builder/subnet/${subnetId}`,
					keywords: BUILDER_KEYWORDS,
					jsonLd: [
						breadcrumbLd([
							{ name: "Builder", path: "/builder/subnets" },
							{ name: "Subnets", path: "/builder/subnets" },
							{ name: subnetName, path: `/builder/subnet/${subnetId}` },
						]),
					],
				}),
			].join("\n"),
		}),
		{ headers: HTML_HEADERS },
	);
}
