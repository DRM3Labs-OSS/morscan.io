/**
 * SEO head fragments - canonical, keywords, robots, and JSON-LD structured data.
 *
 * Shell-rendered pages inject these through the `headScripts` slot, which the
 * layout renders inside <head> (see ui/layout.mustache). Standalone HTML pages
 * carry their own <head> and inline the equivalent tags directly.
 *
 * Pre-launch the whole site is noindex. SEO_INDEXABLE below is the single flip
 * point for every shell-rendered page; standalone HTML pages each carry their
 * own "remove noindex when the site goes live" meta.
 */

import { baseUrl } from "../../config";

/**
 * Live: true makes every shell-rendered page crawlable. This is the single flip
 * point for the whole shell fleet; set to false to take the fleet back to
 * noindex in one edit.
 */
export const SEO_INDEXABLE = true;

const SITE_NAME = "MorScan";
const SITE_DESC =
	"Block explorer and signed real-time API for the Morpheus AI network on Base.";

/** JSON.stringify then neutralize `<` so a payload can never break out of the script tag. */
function ldScript(obj: unknown): string {
	return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

/** schema.org Organization - the publisher identity, homepage only. */
export function organizationLd(): object {
	return {
		"@context": "https://schema.org",
		"@type": "Organization",
		name: SITE_NAME,
		url: `${baseUrl()}/`,
		logo: `${baseUrl()}/morscan-icon.svg`,
		description: SITE_DESC,
		parentOrganization: {
			"@type": "Organization",
			name: "DRM3 Labs",
			url: "https://drm3.network",
		},
		sameAs: ["https://github.com/DRM3Labs-OSS"],
	};
}

/** schema.org WebSite with a SearchAction wired to the homepage search box (?q=). */
export function websiteLd(): object {
	return {
		"@context": "https://schema.org",
		"@type": "WebSite",
		name: SITE_NAME,
		url: `${baseUrl()}/`,
		description: SITE_DESC,
		publisher: { "@type": "Organization", name: SITE_NAME },
		potentialAction: {
			"@type": "SearchAction",
			target: {
				"@type": "EntryPoint",
				urlTemplate: `${baseUrl()}/?q={search_term_string}`,
			},
			"query-input": "required name=search_term_string",
		},
	};
}

/** schema.org BreadcrumbList for an inner page. Home is prepended automatically. */
export function breadcrumbLd(items: Array<{ name: string; path: string }>): object {
	const all = [{ name: "MorScan", path: "/" }, ...items];
	return {
		"@context": "https://schema.org",
		"@type": "BreadcrumbList",
		itemListElement: all.map((it, i) => ({
			"@type": "ListItem",
			position: i + 1,
			name: it.name,
			item: `${baseUrl()}${it.path}`,
		})),
	};
}

/**
 * schema.org ExchangeRateSpecification for the live MOR/USD rate, read on-chain
 * from the Base DEX. Honest and sourced - emitted only when a price is known.
 */
export function morPriceLd(priceUsd: number): object {
	return {
		"@context": "https://schema.org",
		"@type": "ExchangeRateSpecification",
		name: "MOR / USD",
		currency: "MOR",
		description:
			"MOR to USD, read on-chain from the Base DEX (Uniswap v3 MOR/WETH pool).",
		currentExchangeRate: {
			"@type": "UnitPriceSpecification",
			price: Number(priceUsd.toFixed(4)),
			priceCurrency: "USD",
		},
	};
}

export interface SeoHeadOpts {
	/** Canonical path, e.g. '/holders/all'. Combined with the serving origin. */
	path: string;
	keywords?: string;
	jsonLd?: object[];
	/** Override the site-wide pre-launch default (noindex). */
	indexable?: boolean;
}

/**
 * Build the SEO fragment for a shell-rendered page: robots (pre-launch noindex),
 * canonical, optional keywords, and any JSON-LD blocks. Append to headScripts.
 */
export function seoHead(opts: SeoHeadOpts): string {
	const parts: string[] = [];
	const indexable = opts.indexable ?? SEO_INDEXABLE;
	// Pre-launch: remove noindex when the site goes live (flip SEO_INDEXABLE).
	if (!indexable) parts.push('<meta name="robots" content="noindex, nofollow">');
	parts.push(`<link rel="canonical" href="${baseUrl()}${opts.path}">`);
	if (opts.keywords) parts.push(`<meta name="keywords" content="${opts.keywords}">`);
	for (const obj of opts.jsonLd || []) parts.push(ldScript(obj));
	return parts.join("\n");
}

/**
 * A single confident, crawlable lede sentence prepended to a plane's SSR body so
 * each surface ranks for its own term. Muted, small, honest - never vibes copy.
 */
export function seoLede(text: string): string {
	return `<p class="seo-lede" style="font-size:0.72rem;color:var(--text-muted);line-height:1.55;margin:0 0 1.1rem;max-width:72ch;">${text}</p>`;
}
