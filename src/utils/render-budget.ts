/**
 * The render budget for the long-tail pages.
 *
 * A fixed page (the landing, analytics, the lists) has one cache key, so the
 * edge holds it and a flood costs the database nothing. A detail page has one
 * key PER wallet, provider, model or subnet, so a walk of addresses (a crawler,
 * a botnet with random addresses) is one full render per request: several
 * database reads each, against the one database that the minute sync, every
 * /mor/v1 call and every page share.
 *
 * So a detail-page render (a cache MISS only; a hit is never counted) passes:
 *   1. the per-IP first shed: the RL_STANDARD binding under `render:<ip>`,
 *      100 renders a minute per address per machine;
 *   2. the global ceiling, counted exactly by the CallMeter object:
 *      RENDER_LIMIT renders a minute for everyone, and a separate
 *      VERIFIED_RENDER_LIMIT for a crawler Cloudflare has verified, so a flood
 *      in browser clothes never starves the search engines (they are budgeted,
 *      never blocked).
 * Past either: 429 with Retry-After. Both FAIL OPEN: a broken counter must
 * never take a page down. A request with no CF-Connecting-IP never crossed the
 * public edge and is not counted.
 *
 * THE NUMBERS. 300 a minute is 5 renders a second: far above what readers or
 * an ordinary crawl ask of one site's detail pages, and a rate the database
 * absorbs beside the sync. 120 a minute for verified crawlers is two pages a
 * second, more than a search engine asks of a site this size.
 */

import type { Env } from "../types";
import { allowedOpen, meterTake } from "./call-meter";

export const RENDER_LIMIT = 300;
export const VERIFIED_RENDER_LIMIT = 120;
const RENDER_SHARDS = 4;

function verifiedCrawler(request: Request): boolean {
	const cat = (request as Request & { cf?: { verifiedBotCategory?: unknown } }).cf
		?.verifiedBotCategory;
	return typeof cat === "string" && cat.trim() !== "";
}

/** The 429 a render past its budget gets. Plain words, no store. */
export function renderBusy(retryAfter: number): Response {
	const s = Math.max(1, Math.min(60, Math.ceil(retryAfter) || 60));
	return new Response(
		`Too many pages were asked for at once. Try again in ${s} seconds.\n`,
		{
			status: 429,
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
				"Retry-After": String(s),
			},
		},
	);
}

/** Null when the render may go ahead; the 429 otherwise. Fails open. */
export async function renderRefusal(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const ip = request.headers.get("CF-Connecting-IP");
	if (!ip) return null;
	if (env.RL_STANDARD) {
		try {
			const r = await env.RL_STANDARD.limit({ key: `render:${ip}` });
			if (!r.success) return renderBusy(60);
		} catch {
			// fail open
		}
	}
	const verified = verifiedCrawler(request);
	const v = await meterTake(
		env,
		verified ? "render:verified" : "render:all",
		[[verified ? VERIFIED_RENDER_LIMIT : RENDER_LIMIT, 60]],
		{ shards: RENDER_SHARDS },
	);
	if (allowedOpen(v)) return null;
	console.log(JSON.stringify({ t: "render_429", verified }));
	return renderBusy(v?.retry || 60);
}
