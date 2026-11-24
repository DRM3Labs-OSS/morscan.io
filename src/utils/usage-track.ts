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
import { allowedClosed, meterTake } from "./call-meter";

/**
 * The instrument's own ceilings: rows it may write across every isolate, a
 * minute and a UTC day (exact, CallMeter). A row past either is not written;
 * the request it describes is untouched. The day ceiling bounds the table's
 * growth whatever a flood does (at most LOG_ROWS_PER_DAY rows of at most about
 * 450 bytes a day, pruned at the retention window); the minute ceiling keeps a
 * burst from contending with the sync for the one database. When the meter is
 * configured but does not answer, the row is dropped (a write a stranger can
 * cause fails closed); a build with no meter keeps only the per-address cap.
 */
export const LOG_ROWS_PER_MIN = 600;
export const LOG_ROWS_PER_DAY = 50_000;
const LOG_SHARDS = 4;
/**
 * One address past 100 rows a minute (the RL_STANDARD binding under
 * `log:<ip>`, per machine) is sampled 1 in LOG_THIN with weight x LOG_THIN, so
 * SUM(weight) still recovers its volume and it cannot spend the day's rows.
 */
export const LOG_THIN = 20;

/** The path a row records: a 404 is "(404)", so random paths never reach the table. */
export function loggedPath(path: string, status?: number): string {
	return status === 404 ? "(404)" : path;
}

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

/** The same cheap shape gate validateApiKey applies before any lookup. */
function wellFormedKey(key: string): boolean {
	return (key.startsWith("mor_") || key.startsWith("mspk_")) && key.length >= 25;
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
		// A string that cannot be a key (validateApiKey refuses it unread) is one
		// tag, so junk headers do not mint a new caller per request.
		if (!wellFormedKey(key)) return "key:malformed";
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
 * errors. Caller gates on trackable() and wraps this in ctx.waitUntil, after
 * routing, so `status` is the answer the request got.
 */
export async function logRequest(
	env: Env,
	req: Request,
	path: string,
	status?: number,
): Promise<void> {
	try {
		const ua = req.headers.get("user-agent");
		const credential = await credentialClass(req, env);
		let weight = sampleWeight(credential, ua, sampleDivisor(env), Math.random());
		if (weight === 0) return;
		const ip = req.headers.get("CF-Connecting-IP");
		if (ip && env.RL_STANDARD) {
			let within = true;
			try {
				within = (await env.RL_STANDARD.limit({ key: `log:${ip}` })).success;
			} catch {
				// the binding failing leaves the row to the global ceiling below
			}
			if (!within) {
				if (Math.random() >= 1 / LOG_THIN) return;
				weight *= LOG_THIN;
			}
		}
		const v = await meterTake(
			env,
			"usage-log",
			[
				[LOG_ROWS_PER_MIN, 60],
				[LOG_ROWS_PER_DAY, 86400],
			],
			{ shards: LOG_SHARDS },
		);
		if (!allowedClosed(env, v)) return;
		const cf = (req as { cf?: { country?: string; colo?: string } }).cf;
		await logUsage(env.DB, {
			path: loggedPath(path, status),
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
