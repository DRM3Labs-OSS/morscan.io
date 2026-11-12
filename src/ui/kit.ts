/**
 * The page kit - what a composition needs to serve a page that looks and
 * behaves like a built-in one: the shared layout and header, the page cache
 * with the market tape, the canonical HTML headers, and the share-card
 * rasterizer (`renderOgCard`) for a section's own 1200x630 card.
 *
 * Imported as `morscan/ui`. A composition registers its section with
 * `planes` and its routes with `publicRoutes` (src/providers/extensions.ts),
 * then builds each page here. Nothing in this file is specific to any one
 * composition.
 */

import type { Env } from "../types";
import { baseUrl } from "../config";
import { render } from "./shell";
import type { PlaneConfig, StatItem } from "./morscan_header";
import { HTML_HEADERS, getCachedPrice, morStat } from "../handlers/ui/shared";
import { seoHead, seoLede } from "../handlers/ui/seo";

export { cachedPage } from "../routes/ui";
export { HTML_HEADERS, morStat } from "../handlers/ui/shared";
export { ogBrandSvg, renderOgCard, type OgCardOptions } from "../handlers/og-image";
export { signResponse } from "../utils/provenance";
export { signingMnemonic } from "../config";
export type {
	ContractInfo,
	PlaneConfig,
	StatItem,
	SubTab,
} from "./morscan_header";

export interface KitPage {
	title: string;
	description: string;
	/** Canonical path, e.g. "/section/page". */
	path: string;
	subtitle: string;
	/** The section this page belongs to; `key` marks the active nav item. */
	plane: Omit<PlaneConfig, "stats"> & {
		/** Stat bar items. The MOR price is prepended unless `price` is false. */
		stats: StatItem[];
	};
	/** Page CSS, without the <style> tag. */
	styles?: string;
	/** Page body HTML. */
	content: string;
	/** One crawlable sentence above the body. Defaults to `description`. */
	lede?: string | false;
	keywords?: string;
	headScripts?: string;
	bodyScripts?: string;
	ogImage?: string;
	/** Prepend the live MOR price to the stat bar. Default true. */
	price?: boolean;
}

/** Render one page in the shared layout and return it as an HTML response. */
export async function renderPage(env: Env, page: KitPage): Promise<Response> {
	const price = await getCachedPrice(env);
	const stats =
		page.price === false ? page.plane.stats : [morStat(price), ...page.plane.stats];
	const lede = page.lede === false ? "" : seoLede(page.lede || page.description);
	return new Response(
		render({
			title: page.title,
			description: page.description,
			ogUrl: `${baseUrl()}${page.path}`,
			ogImage: page.ogImage,
			subtitle: page.subtitle,
			active: "",
			price,
			planeConfig: { ...page.plane, stats },
			pageStyles: page.styles || "",
			content: lede + page.content,
			headScripts: [
				page.headScripts || "",
				seoHead({ path: page.path, keywords: page.keywords }),
			].join("\n"),
			bodyScripts: page.bodyScripts || "",
		}),
		{ headers: HTML_HEADERS },
	);
}
