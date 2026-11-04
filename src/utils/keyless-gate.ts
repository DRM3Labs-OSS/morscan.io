/**
 * The keyless gate - two cheap defenses applied ONLY to requests that carry no
 * credential, so a key (or an x402 payment, or an SDK wallet signature) always
 * beats a user-agent and a legitimate caller is never touched:
 *
 *   1. Crawler denylist (ACTIVE). Zero-value marketing and SEO scrapers pull
 *      pages in volume, pay nothing, and cite nothing. They are refused before
 *      any render. Search engines (Googlebot, Bingbot, DuckDuckBot, Applebot)
 *      and agent crawlers (GPTBot, ClaudeBot, PerplexityBot) are deliberately
 *      NOT listed, so the pages stay indexable and agent-readable.
 *
 *   2. Anonymous per-IP day cap (ARMED, OFF by default). A ceiling on keyless
 *      /mor/v1 volume from one IP. OFF unless ANON_DAY_CAP is set above 0 - the
 *      number is chosen from the usage_log read, not guessed, so this ships
 *      dormant and is turned on with evidence. The signed read still returns
 *      within budget; over budget returns 429 pointing at the free access doors.
 *
 * The gate adds no D1 cost on the default path: with ANON_DAY_CAP unset the
 * only work is a regex test against the user-agent.
 */

import type { Env } from "../types";
import { baseUrl } from "../config";
import { bumpAnonDay } from "../db/anon-counters";
import { validateApiKey } from "./auth";

// Zero-value marketing/SEO scrapers. Specific on purpose: NOT a broad bot
// catch-all (that would hit search engines and agent crawlers we want). Mirrors
// the dtaoscan denylist. A keyed caller with any of these UAs is never blocked
// (the gate only runs for keyless requests).
const DENIED_CRAWLER_RE =
	/(AhrefsBot|SemrushBot|AwarioBot|AwarioSmartBot|MJ12bot|DotBot|KakaoBot|Bytespider|PetalBot|DataForSeoBot|BLEXBot|serpstatbot|MegaIndex|MauiBot|Barkrowler|ZoominfoBot|magpie-crawler|peer39_crawler|TurnitinBot|Seekport)/i;

/** True when the user-agent is a denied marketing/SEO crawler. Null/empty is not a match. */
export function isDeniedCrawler(ua: string | null): boolean {
	return !!ua && DENIED_CRAWLER_RE.test(ua);
}

/**
 * A request is credentialed (and so skips the ANON DAY CAP) if it presents ANY
 * recognized credential header: an API key, a bearer token, an SDK wallet
 * signature, or an x402 payment. Presence is enough here because the cap only
 * meters anonymous volume and an invalid credential is handled (401) downstream.
 * The CRAWLER block does NOT trust mere presence - it validates the key - so a
 * scraper cannot defeat it with a junk header (see keylessGate).
 */
export function hasCredentialHeader(req: Request): boolean {
	return !!(
		req.headers.get("X-Morscan-Key") ||
		req.headers.get("Authorization")?.startsWith("Bearer ") ||
		req.headers.get("X-Morscan-Wallet") ||
		req.headers.get("X-PAYMENT")
	);
}

/** The configured anonymous per-IP day cap. 0 (default) = the cap is OFF. */
export function anonDayCap(env: Env): number {
	const n = parseInt(env.ANON_DAY_CAP || "0", 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A short tag for an IP, so the day counter stores no raw address. Salted with a
 * per-deployment secret (the JWT secret, already present) so the truncated hash
 * is not a rainbow-table lookup over the small IPv4 space if the table ever leaks.
 */
async function hashIp(env: Env, ip: string): Promise<string> {
	const salt = env.MORSCAN_JWT_SECRET || "";
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${salt}|${ip}`),
	);
	return Array.from(new Uint8Array(buf).slice(0, 8), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Paths the anon day cap meters: keyless /mor/v1 data endpoints, EXCLUDING the
 * documented-free endpoints (price and capacity never cost a call), so arming
 * the cap never 429s a caller on a free endpoint.
 */
function isDayCapped(path: string): boolean {
	if (!path.startsWith("/mor/v1/")) return false;
	return (
		path !== "/mor/v1/price" &&
		path !== "/mor/v1/price/chart" &&
		path !== "/mor/v1/capacity"
	);
}

const GATE_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
	"Cache-Control": "no-store",
};

function crawlerBlockResponse(): Response {
	const b = baseUrl();
	return new Response(
		JSON.stringify({
			error:
				"This crawler is not accepted. The data is open to people and to agents that identify themselves: mint a free key with one wallet signature, no email and no signup.",
			docs_url: `${b}/auth.md`,
		}),
		{ status: 403, headers: GATE_HEADERS },
	);
}

function anonCapResponse(retryAfter: number): Response {
	const b = baseUrl();
	return new Response(
		JSON.stringify({
			error:
				"Anonymous daily limit reached. Mint a free key with one wallet signature at /console (no email, no signup), or pay per call with x402. The limit resets at 00:00 UTC.",
			retry_after: retryAfter,
			docs_url: `${b}/auth.md`,
		}),
		{ status: 429, headers: { ...GATE_HEADERS, "Retry-After": String(retryAfter) } },
	);
}

/**
 * Run the keyless gate. Returns a Response to block the request, or null to let
 * it proceed. Call early in the fetch pipeline for every request; it is a no-op
 * for any credentialed caller and for every user-agent that is not a denied
 * crawler (when the anon cap is off). Fails OPEN on a storage error.
 */
export async function keylessGate(
	env: Env,
	req: Request,
	path: string,
): Promise<Response | null> {
	// 1. Crawler denylist (pages + API; /health exempt). A denied crawler is
	// refused UNLESS it carries a VALID api key - presence of a header is not
	// enough, or a scraper would bypass the block with a junk key. On a page
	// (which carries no legitimate key) that means always refused; on /mor/v1 a
	// valid key beats the user-agent. validateApiKey is a D1 read only when a key
	// is actually presented, and this whole branch runs only for a denied-crawler
	// UA, never on normal traffic.
	if (
		path !== "/health" &&
		path !== "/healthz" &&
		isDeniedCrawler(req.headers.get("user-agent"))
	) {
		if (path.startsWith("/mor/v1/")) {
			const auth = await validateApiKey(req, env);
			if (auth.valid) return null;
		}
		return crawlerBlockResponse();
	}

	// A valid-looking credential (key, wallet signature, or payment) skips the
	// anonymous cap; an invalid one is handled 401 downstream.
	if (hasCredentialHeader(req)) return null;

	// 2. Anonymous per-IP day cap (keyless metered /mor/v1 only, free endpoints
	// excluded; off unless configured).
	const cap = anonDayCap(env);
	if (cap > 0 && isDayCapped(path)) {
		try {
			const ip = req.headers.get("CF-Connecting-IP") || "unknown";
			const { used, retryAfter } = await bumpAnonDay(
				env.DB,
				await hashIp(env, ip),
				Math.floor(Date.now() / 1000),
			);
			if (used > cap) return anonCapResponse(retryAfter);
		} catch {
			// Fail open: a broken meter must never take the API down.
		}
	}

	return null;
}
