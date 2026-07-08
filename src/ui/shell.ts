/**
 * Shell - Layout renderer for all MorScan pages.
 *
 * Uses morscan_header.ts for the unified header component.
 * Mustache handles only the document skeleton (head, footer).
 */

import Mustache from "mustache";
import layoutTemplate from "./layout.mustache";
import { baseUrl } from "../config";
import { buildStampHtml } from "./build-stamp";
import { renderHeader, type PlaneConfig, type PriceData } from "./morscan_header";

// Re-export types for backward compat
export type {
	Plane,
	Tab,
	PriceData,
	ContractInfo,
	StatItem,
	SubTab,
	PlaneConfig,
} from "./morscan_header";

// Legacy type kept for existing handler compat - maps to PlaneConfig.stats
export interface StatBarData {
	morPrice: string;
	providerCount: string;
	activeSessions: string;
	morStaked: string;
}

export interface PageParams {
	title: string;
	description: string;
	ogUrl: string;
	ogImage?: string; // per-page og card; defaults to the brand og-image
	subtitle: string;
	active: string;
	plane?: string;
	contract?: { icon: string; label: string; address: string; basescanPath?: string };
	pageStyles?: string;
	content: string;
	headScripts?: string;
	bodyScripts?: string;
	price?: PriceData | null;
	statBar?: StatBarData | null;
	// New: pass a PlaneConfig directly to bypass legacy mapping
	planeConfig?: PlaneConfig;
}

export function render(params: PageParams): string {
	// Build header HTML via the unified component
	const headerHtml = params.planeConfig
		? renderHeader({ plane: params.planeConfig, price: params.price })
		: ""; // fallback: layout.mustache renders legacy header

	const p = params.price;
	const ch = p?.change24h || 0;
	const sign = ch >= 0 ? "+" : "";

	const view = {
		title: params.title,
		description: params.description,
		ogUrl: params.ogUrl,
		ogImage: params.ogImage || `${baseUrl()}/og-image.png`,
		subtitle: params.subtitle,
		pageStyles: params.pageStyles || "",
		content: params.content,
		headScripts: params.headScripts || "",
		bodyScripts: params.bodyScripts || "",

		// New unified header - if planeConfig provided, inject it
		headerHtml,
		useUnifiedHeader: !!params.planeConfig,

		// Plane flags - derived from planeConfig if available, else legacy
		plane_analytics: params.planeConfig
			? params.planeConfig.key === "analytics"
			: params.plane === "analytics",
		plane_pools: params.planeConfig
			? params.planeConfig.key === "pools"
			: params.plane === "pools",
		plane_compute: params.planeConfig
			? params.planeConfig.key === "compute"
			: (params.plane || "compute") === "compute",
		plane_builder: params.planeConfig
			? params.planeConfig.key === "builder"
			: params.plane === "builder",
		plane_holders: params.planeConfig
			? params.planeConfig.key === "holders"
			: params.plane === "holders",
		plane_api: params.planeConfig
			? params.planeConfig.key === "api"
			: params.plane === "api",

		active_providers: params.active === "providers",
		active_consumers: params.active === "consumers",
		active_network: params.active === "network",
		active_api: params.active === "api",
		active_api_docs: params.active === "api_docs",
		active_builder_subnets: params.active === "builder_subnets",
		active_builder_calc: params.active === "builder_calc",
		active_builder_api: params.active === "builder_api",
		active_holders: params.active === "holders",
		active_dust: params.active === "dust",

		// Price block (legacy)
		priceHtml: p && p.usd > 0,
		priceUsd: p ? p.usd.toFixed(2) : "",
		priceChange: p ? `${sign}${ch.toFixed(2)}%` : "",
		priceChangeColor: ch >= 0 ? "var(--green)" : "var(--red)",
		priceMcap: p && p.marketCap >= 1e6 ? `$${(p.marketCap / 1e6).toFixed(1)}M` : "",

		// Contract banner (legacy)
		hasContract: !!params.contract,
		contractIcon: params.contract?.icon || "",
		contractLabel: params.contract?.label || "",
		contractAddress: params.contract?.address || "",
		contractAddressShort: params.contract
			? `${params.contract.address.slice(0, 6)}...${params.contract.address.slice(-4)}`
			: "",
		contractBasescanUrl: params.contract
			? `https://basescan.org/${params.contract.basescanPath || "address"}/${params.contract.address}`
			: "",

		// Stat bar (legacy)
		statBar: params.statBar || null,

		// One definition (src/ui/build-stamp.ts), same sources as /version.
		buildStamp: buildStampHtml(),
	};

	return Mustache.render(layoutTemplate as string, view);
}
