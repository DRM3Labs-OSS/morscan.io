/**
 * Request tracking - the fire-and-forget feed for the usage_log instrument.
 *
 * MorScan sets no tracking cookie, so the human/machine split is read from the
 * CREDENTIAL CLASS plus the user-agent, not a browser id:
 *   - 'demo'         the serving key embedded in every page script -> a human
 *                    browsing a page (page scripts fetch /mor/v1 with it)
 *   - 'key:<prefix>' a minted api_key -> a keyed machine dependent (the
 *                    hash-prefix names the caller without storing the secret)
 *   - 'x402'         a signed micropayment -> a paying machine
 *   - null           no credential -> anonymous: a browser page GET (browser
 *                    UA) or a machine/crawler (bot/library UA, or none)
 *
 * NO raw IP and NO raw key leave this module: the key is reduced to a SHA-256
 * prefix, and only Cloudflare's coarse country/colo are recorded. The write is
 * always off the response path (ctx.waitUntil) and swallows its own errors, so
 * the instrument can never add latency to, or fail, a real request.
 */

import type { Env } from "../types";
import { logUsage } from "../db/usage-log";

/** Worth logging: pages + API, not static assets, health probes, or discovery files. */
export function trackable(path: string): boolean {
	if (
		/\.(png|jpg|jpeg|svg|ico|gif|webp|xml|txt|css|js|woff2?|ttf|map|webmanifest)$/i.test(
			path,
		)
	)
		return false;
	if (path.startsWith("/.well-known/")) return false;
	if (path === "/favicon.ico" || path === "/robots.txt" || path === "/sitemap.xml")
		return false;
	// Monitor + OG + image-proxy noise that would dominate the log without being real usage.
	if (path === "/health" || path === "/healthz" || path === "/version") return false;
	if (path.startsWith("/og") || path.startsWith("/img")) return false;
	return true;
}

/** The raw key presented on a request, from either header the gate accepts. Not validated. */
function presentedKey(req: Request): string | null {
	const h = req.headers.get("X-Morscan-Key");
	if (h) return h;
	const auth = req.headers.get("Authorization");
	if (auth?.startsWith("Bearer ")) return auth.slice(7);
	return null;
}

/** A short, non-reversible tag for a key, so a keyed caller is groupable without storing the secret. */
async function keyTag(key: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	const hex = Array.from(new Uint8Array(buf), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	return `key:${hex.slice(0, 12)}`;
}

/**
 * Classify the caller from request headers alone (no D1 read). The serving
 * (demo) key is public - it ships in every page - so a plain compare is fine.
 */
export async function credentialClass(req: Request, env: Env): Promise<string | null> {
	const key = presentedKey(req);
	if (key) {
		if (env.MORSCAN_DEMO_KEY && key === env.MORSCAN_DEMO_KEY) return "demo";
		return keyTag(key);
	}
	// SDK callers authenticate with a wallet signature and no key; without this
	// they would log as anonymous and skew the human/machine split (a signed
	// machine counted as anon). Tag the class without touching the signature.
	if (req.headers.get("X-Morscan-Wallet")) return "wallet";
	if (req.headers.get("X-PAYMENT")) return "x402";
	return null;
}

const BOT_RE =
	/bot|crawl|spider|slurp|curl|wget|python|go-http|java\/|okhttp|node-fetch|axios|libwww|ruby|headless|scrapy|http-client|dart|fetch/i;

/**
 * High-volume human-ish traffic (the serving key, or an anonymous browser page
 * GET) is sampled; everything rarer and more valuable (keyed, x402, and
 * anonymous non-browser callers - the dependents and the crawlers) is always
 * logged. A sampling heuristic, not a security gate, so a rough UA check is fine.
 */
function isSampledClass(credential: string | null, ua: string | null): boolean {
	if (credential === "demo") return true;
	if (credential === null) return !!ua && /mozilla/i.test(ua) && !BOT_RE.test(ua);
	return false;
}

/** The configured sample divisor (>= 1). 1 (default) logs every request. */
export function sampleDivisor(env: Env): number {
	const n = parseInt(env.USAGE_LOG_SAMPLE || "1", 10);
	return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Decide-and-weight: returns the sample weight to record (the row stands for
 * that many requests), or 0 to skip this request. Pure; the random draw is
 * injectable for tests.
 */
export function sampleWeight(
	credential: string | null,
	ua: string | null,
	divisor: number,
	rnd: number,
): number {
	if (divisor <= 1 || !isSampledClass(credential, ua)) return 1;
	return rnd < 1 / divisor ? divisor : 0;
}

/**
 * Append one usage row for this request, off the response path. Swallows all
 * errors. Caller gates on trackable() and wraps this in ctx.waitUntil.
 */
export async function logRequest(env: Env, req: Request, path: string): Promise<void> {
	try {
		const ua = req.headers.get("user-agent");
		const credential = await credentialClass(req, env);
		const weight = sampleWeight(credential, ua, sampleDivisor(env), Math.random());
		if (weight === 0) return;
		const cf = (req as { cf?: { country?: string; colo?: string } }).cf;
		await logUsage(env.DB, {
			path,
			method: req.method,
			credential,
			country: cf?.country ?? null,
			colo: cf?.colo ?? null,
			ua,
			weight,
		});
	} catch (e) {
		console.error(
			"[usage-log] write failed (ignored):",
			e instanceof Error ? e.message : e,
		);
	}
}
