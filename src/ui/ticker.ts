/**
 * Market tape - the scrolling cheapest-ask ticker across the top of every
 * unified-header page.
 *
 * One item per model with live bids: cheapest active ask (MOR/day) and its
 * honest 24h change, computed from on-chain bid lifecycle timestamps (a bid
 * counted "active 24h ago" was created before and not deleted until after the
 * cutoff). No baseline 24h ago (fresh listing) renders a NEW tag, never a
 * fabricated 0.0%.
 *
 * SSR'd into the page via the <!--MKT_TICKER--> slot in layout.mustache and
 * filled centrally in routes/ui.ts cachedPage(), so it rides the existing
 * 30s edge cache: one small D1 aggregate per cache miss, no BQ, no extra
 * endpoint. Styles live in layout.mustache (.mkt-*).
 */

import type { Env } from "../types";
import { getTickerModels } from "../db/explorer-market";

export const TICKER_SLOT = "<!--MKT_TICKER-->";

export interface TickerItem {
	name: string;
	morPerDay: number;
	changePct: number | null; // null = no 24h baseline (new listing)
	providers: number;
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Compact tape price: 3 significant-ish digits, tabular-friendly. */
function fmtMorPerDay(n: number): string {
	if (n >= 1000) return Math.round(n).toLocaleString("en-US");
	if (n >= 100) return n.toFixed(0);
	if (n >= 1) return n.toFixed(2);
	return n.toFixed(4);
}

export function renderTicker(items: TickerItem[]): string {
	if (items.length === 0) return "";
	const ticks = items
		.map((t) => {
			const chg =
				t.changePct === null
					? '<span class="mkt-new">new</span>'
					: `<span class="mkt-chg ${t.changePct > 0.05 ? "up" : t.changePct < -0.05 ? "down" : "flat"}">${t.changePct > 0 ? "+" : ""}${t.changePct.toFixed(1)}%</span>`;
			const title = `cheapest active ask vs 24h ago &middot; ${t.providers} provider${t.providers === 1 ? "" : "s"}`;
			return `<span class="mkt-item" title="${title}"><a href="/compute/network">${esc(t.name)}</a><span class="mkt-p">${fmtMorPerDay(t.morPerDay)} <i>MOR/day</i></span>${chg}</span>`;
		})
		.join("");
	// A short tape leaves a visible gap in the loop: repeat the items until one
	// half is comfortably wider than any viewport, then duplicate that half so
	// the -50% translate loops seamlessly. The clone is aria-hidden.
	const reps = Math.max(1, Math.ceil(12 / items.length));
	const half = `<span class="mkt-half">${ticks.repeat(reps)}</span>`;
	return `<div class="mkt-ticker" role="marquee" aria-label="Marketplace models, cheapest ask and 24h change"><div class="mkt-track">${half}${half.replace('class="mkt-half"', 'class="mkt-half" aria-hidden="true"')}</div></div>`;
}

/** Build the tape HTML from D1. Never throws: any failure or an empty
 * marketplace renders nothing (the slot comment is simply removed). */
export async function marketTickerHtml(env: Env): Promise<string> {
	try {
		const cutoff = Math.floor(Date.now() / 1000) - 86400;
		const rows = await getTickerModels(env.DB, cutoff);
		const items: TickerItem[] = rows
			.filter((r) => r.min_price !== null && r.min_price > 0)
			.map((r) => {
				const now = r.min_price as number;
				const then = r.min_price_then;
				return {
					name: r.name || `${r.model_id.slice(0, 10)}…`,
					morPerDay: (now * 86400) / 1e18,
					changePct: then && then > 0 ? ((now - then) / then) * 100 : null,
					providers: r.provider_count,
				};
			});
		return renderTicker(items);
	} catch {
		return "";
	}
}
