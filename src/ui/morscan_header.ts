/**
 * morscan_header.ts - Unified header component for all MorScan pages.
 *
 * One function, one config per plane. Every page calls renderHeader().
 * Desktop and mobile. Tabs, stat bar, contract, sync, pricing, sign-out.
 */

// ─── Types ───

export type Plane = "analytics" | "pools" | "compute" | "builder" | "holders" | "api";
export type Tab =
	| "analytics"
	| "pools_overview"
	| "providers"
	| "consumers"
	| "sessions"
	| "network"
	| "api"
	| "api_docs"
	| "builder_subnets"
	| "builder_calc"
	| "builder_api"
	| "holders"
	| "dust";

export interface PriceData {
	usd: number;
	change24h: number;
	marketCap: number;
}

export interface ContractInfo {
	icon: string;
	label: string;
	address: string;
	basescanPath?: string; // 'address' or 'token', defaults to 'address'
	upgradeStatus?: string; // SSR'd upgrade status line (HTML-safe)
}

export interface StatItem {
	label: string;
	value: string;
	id?: string; // optional DOM id for client-side updates
	green?: boolean; // defaults to true
}

export interface SubTab {
	label: string;
	href: string;
	active: boolean;
}

export interface PlaneConfig {
	key: Plane;
	label: string;
	href: string;
	subtitle: string;
	subTabs: SubTab[];
	stats: StatItem[];
	contract?: ContractInfo;
}

export interface HeaderParams {
	plane: PlaneConfig;
	price?: PriceData | null;
}

// ─── Plane Configs ───

export function analyticsPlane(stats: StatItem[]): PlaneConfig {
	return {
		key: "analytics",
		label: "Analytics",
		href: "/analytics/overview",
		subtitle: "Morpheus Network Intelligence",
		subTabs: [{ label: "Overview", href: "/analytics/overview", active: true }],
		stats,
	};
}

export function computePlane(
	active: Tab,
	stats: StatItem[],
	upgradeStatus?: string,
): PlaneConfig {
	return {
		key: "compute",
		label: "Compute",
		href: "/compute/network",
		subtitle: "Morpheus Compute Explorer",
		subTabs: [
			{ label: "Network", href: "/compute/network", active: active === "network" },
			{ label: "Providers", href: "/compute/providers", active: active === "providers" },
			{ label: "Consumers", href: "/compute/consumers", active: active === "consumers" },
			{ label: "Sessions", href: "/compute/sessions", active: active === "sessions" },
		],
		stats,
		contract: {
			icon: "💎",
			label: "Diamond Contract",
			address: "0x6aBE1d282f72B474E54527D93b979A4f64d3030a",
			upgradeStatus,
		},
	};
}

export function builderPlane(active: Tab, stats: StatItem[]): PlaneConfig {
	return {
		key: "builder",
		label: "Builder",
		href: "/builder/subnets",
		subtitle: "Morpheus Builder Subnets",
		subTabs: [
			{
				label: "Subnets",
				href: "/builder/subnets",
				active: active === "builder_subnets",
			},
			{
				label: "Calculator",
				href: "/builder/calculator",
				active: active === "builder_calc",
			},
		],
		stats,
		contract: {
			icon: "🔨",
			label: "Builder Contract",
			address: "0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9",
		},
	};
}

export function holdersPlane(active: Tab, stats: StatItem[]): PlaneConfig {
	return {
		key: "holders",
		label: "Holders",
		href: "/holders/all",
		subtitle: "MOR Token Holders",
		subTabs: [
			{ label: "All", href: "/holders/all", active: active === "holders" },
			{ label: "Dust (<0.01)", href: "/holders/dust", active: active === "dust" },
		],
		stats,
		contract: {
			icon: "🪙",
			label: "MOR Token (ERC-20)",
			address: "0x7431aDa8a591C955a994a21710752EF9b882b8e3",
			basescanPath: "token",
		},
	};
}

export function apiPlane(active: Tab, stats: StatItem[]): PlaneConfig {
	return {
		key: "api",
		label: "API",
		href: "/api/playground",
		subtitle: "MorScan API",
		subTabs: [
			{ label: "Playground", href: "/api/playground", active: active === "api" },
			{ label: "Docs", href: "/api/docs", active: active === "api_docs" },
		],
		stats,
	};
}

export function poolsPlane(active: Tab, stats: StatItem[]): PlaneConfig {
	return {
		key: "pools",
		label: "Pools",
		href: "/pools",
		subtitle: "Morpheus Staking Pools",
		subTabs: [{ label: "Overview", href: "/pools", active: active === "pools_overview" }],
		stats,
	};
}

// ─── Shared SVGs ───

const LOGO_SVG = `<svg class="logo-icon" width="56" height="26" viewBox="0 0 89 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M44.5031 36.7108L52.2884 27.0574V39.5L75.154 30.3296L78.4294 22.9099L58.8453 30.8065V28.0173L80.2346 19.2454L83.6775 11.7472L58.7647 21.8776V19.1669L85.7246 7.99814L89 0.5L56.3826 13.818C56.3826 13.818 53.5973 14.8563 52.369 16.8486L44.5031 26.5805L36.6372 16.8486C35.4089 14.8563 32.6236 13.818 32.6236 13.818L0 0.5L3.27539 7.99814L30.2415 19.1608V21.8715L5.32871 11.7472L8.77159 19.2454L30.1609 28.0173V30.8065L10.5768 22.9099L13.8522 30.3296L36.7178 39.5V27.0574L44.5031 36.7108Z" fill="#22c55e"/></svg>`;

const BASE_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 111 111" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:-1px" aria-hidden="true" focusable="false"><path d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6319 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H3.9565e-07C2.35281 87.8625 26.0432 110.034 54.921 110.034Z" fill="#c7c2bc"/></svg>`;

// ─── Escape Helper ───

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// ─── Render Functions ───

function renderPrice(price: PriceData | null | undefined): string {
	// Reserve the block even before the value is known so the client refresh
	// never reflows the header. Widths are fixed (tabular digits + min-width);
	// filling a value in place causes no horizontal shift.
	const p = price && price.usd > 0 ? price : null;
	const ch = p ? p.change24h || 0 : 0;
	const sign = ch >= 0 ? "+" : "";
	const color = ch >= 0 ? "var(--green)" : "var(--red)";
	const mcapText =
		p && p.marketCap >= 1e6
			? `MCap $${(p.marketCap / 1e6).toFixed(1)}<span class="mkt-u">M</span>`
			: "";
	const valText = p ? `$${p.usd.toFixed(2)}` : "";
	const chText = p ? `${sign}${ch.toFixed(2)}% (24h)` : "";
	return `<div id="header-price" class="header-price" aria-live="polite">
    <span style="display:block;"><span id="header-price-val" style="font-size:0.9rem;font-weight:700;color:var(--mor);font-variant-numeric:tabular-nums;">${valText}</span><span id="header-price-stale" title="Price feed delayed" style="display:none;color:var(--text-muted);font-size:0.75rem;margin-left:5px;">&middot; delayed</span></span>
    <span id="header-price-change" style="font-size:0.75rem;font-weight:600;display:block;margin-top:2px;color:${color}">${chText}</span>
    <span id="header-price-mcap" class="header-price-mcap" style="font-size:0.75rem;color:var(--text-muted);display:${mcapText ? "block" : "none"};margin-top:4px;">${mcapText}</span>
  </div>`;
}

function renderStatBar(stats: StatItem[]): string {
	if (!stats.length) return "";
	const items = stats
		.map((s) => {
			const idAttr = s.id ? ` id="${esc(s.id)}"` : "";
			const cls = s.green !== false ? " green" : "";
			return `<div class="stat-bar-item"><span class="stat-bar-label">${esc(s.label)}</span><span class="stat-bar-value${cls}"${idAttr}>${esc(s.value)}</span></div>`;
		})
		.join("\n      ");
	return `<div class="stat-bar">${items}</div>`;
}

function renderContract(c: ContractInfo): string {
	const basescanUrl = `https://basescan.org/${c.basescanPath || "address"}/${c.address}`;
	const shortAddr = `${c.address.slice(0, 6)}...${c.address.slice(-4)}`;
	// Inline, not flex-basis:100%: a full-width child wrapped the banner onto a
	// second row on the compute plane while builder/holders stayed one thin
	// row. The upgrade note now rides the same row (hidden on narrow screens,
	// same treatment as the full address).
	const upgradeLine = c.upgradeStatus
		? `<span id="diamond-upgrade-status" class="cb-upgrade">${c.upgradeStatus}</span>`
		: "";
	// ONE compact strip: contract identity + Read/Write left, block + live
	// badge + chain note right. The old layout stacked two full banners (plus
	// a decorative progress bar that only ever read full) and cost ~3x the
	// height for the same information. Keeps the same element ids the shared
	// layout script updates (#sync-chain, #sync-badge, #contract-*), and the
	// same .sync-bar class the sync-status card line appends into.
	return `<div class="contract-banner sync-bar">
      <span aria-hidden="true">${esc(c.icon)}</span>
      <span class="cb-main"><span class="cb-label">${esc(c.label)}</span><a id="contract-link" href="${esc(basescanUrl)}" target="_blank" rel="noopener"><span class="addr-full" id="contract-addr-full">${esc(c.address)}</span><span class="addr-short" id="contract-addr-short">${esc(shortAddr)}</span></a>${upgradeLine}</span>
      <div class="contract-links">
        <a id="contract-read" href="${esc(basescanUrl)}#readContract" target="_blank">Read</a>
        <a id="contract-write" href="${esc(basescanUrl)}#writeContract" target="_blank">Write</a>
      </div>
      <span class="cb-sync"><span class="sync-label">Block</span><span class="sync-val" id="sync-chain">-</span><span class="sync-badge" id="sync-badge">-</span><span class="sync-note">${BASE_ICON_SVG} Base L2 &middot; ~2s blocks</span></span>
    </div>`;
}

function renderPlaneTabs(plane: PlaneConfig): string {
	const planes: { key: Plane; label: string; href: string }[] = [
		{ key: "analytics", label: "Analytics", href: "/analytics/overview" },
		{ key: "compute", label: "Compute", href: "/compute/network" },
		{ key: "builder", label: "Builder", href: "/builder/subnets" },
		{ key: "holders", label: "Holders", href: "/holders/all" },
		{ key: "pools", label: "Pools", href: "/pools" },
		{ key: "api", label: "API", href: "/api/playground" },
	];
	const tabs = planes
		.map(
			(p) =>
				`<a href="${p.href}"${p.key === plane.key ? ' class="active" aria-current="page"' : ""}>${p.label}</a>`,
		)
		.join("");
	return `<div class="plane-tabs" role="navigation" aria-label="Primary sections">${tabs}</div>`;
}

function renderSubTabs(tabs: SubTab[], label: string): string {
	// A lone subtab is pure noise (an "Overview" row restating the plane) and
	// costs a full header row on phones - render subtabs only when there is a
	// real choice to make.
	if (tabs.length < 2) return "";
	const items = tabs
		.map(
			(t) =>
				`<a href="${esc(t.href)}"${t.active ? ' class="active" aria-current="page"' : ""}>${esc(t.label)}</a>`,
		)
		.join("");
	return `<nav aria-label="${esc(label)} views">${items}</nav>`;
}

// ─── Main Export ───

export function renderHeader(params: HeaderParams): string {
	const { plane, price } = params;
	const priceHtml = renderPrice(price);

	return `<header>
      <div class="header-top">
        <a href="/" class="logo" style="text-decoration:none;">
          ${LOGO_SVG}
          <h1>MorScan</h1>
        </a>
        ${priceHtml}
        <div class="header-actions">
          <a class="hdr-github" href="https://github.com/DRM3Labs-OSS/morscan.io" target="_blank" rel="noopener" aria-label="MorScan on GitHub" title="MorScan on GitHub"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>
          <div id="hdr-wallet" class="hdr-wallet" aria-live="polite"></div>
        </div>
      </div>
      <div class="subtitle">${esc(plane.subtitle)}</div>
      ${renderPlaneTabs(plane)}
      ${renderSubTabs(plane.subTabs, plane.label)}
    </header>
    ${renderStatBar(plane.stats)}
    ${plane.contract ? renderContract(plane.contract) : ""}`;
}
