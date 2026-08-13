/**
 * Caching utilities for MorScan API responses.
 *
 * Two strategies:
 * - KV cache: for high-frequency endpoints (SDK and SPA calls).
 *   KV expirationTtl minimum is 60s, so we embed a timestamp in the
 *   value and check freshness on read to support sub-60s effective TTLs.
 * - CF Cache API: for analytics/aggregation endpoints
 *
 * Invalidation: sync calls invalidateCfCache after writing new data
 * so stale responses never linger behind a timer.
 */

import type { Env } from "../types";

interface KvCacheEntry {
	cachedAt: number;
	body: string;
}

/**
 * Try to serve from KV cache. On miss, call the handler, cache the result, return it.
 */
export async function withKvCache(
	env: Env,
	cacheKey: string,
	ttlSeconds: number,
	handler: () => Promise<Response>,
): Promise<Response> {
	const kv = env.MORSCAN_CACHE;
	if (kv) {
		const raw = await kv.get(cacheKey);
		if (raw !== null) {
			try {
				const entry: KvCacheEntry = JSON.parse(raw);
				if (Date.now() - entry.cachedAt < ttlSeconds * 1000) {
					return new Response(entry.body, {
						headers: {
							"Content-Type": "application/json",
							"Access-Control-Allow-Origin": "*",
							"X-Cache": "HIT",
							"X-Cache-Source": "kv",
						},
					});
				}
			} catch (_e) {
				// Corrupted entry, fall through to handler
			}
		}
	}

	const response = await handler();
	const body = await response.text();

	if (response.ok && kv) {
		const entry: KvCacheEntry = { cachedAt: Date.now(), body };
		try {
			// KV expirationTtl minimum is 60s; use max(ttl, 60) for KV eviction,
			// but our freshness check above enforces the real TTL.
			await kv.put(cacheKey, JSON.stringify(entry), {
				expirationTtl: Math.max(ttlSeconds, 60),
			});
		} catch (_e) {
			// KV write failures are non-fatal
		}
	}

	const headers = new Headers(response.headers);
	headers.set("X-Cache", "MISS");
	return new Response(body, { status: response.status, headers });
}

/**
 * Memoize a VALUE (not a Response) in KV.
 *
 * WHY THIS EXISTS, and it is not the same job as withKvCache. withKvCache keys on the
 * REQUEST, so anything that varies per request gets its own entry - `/mor/v1/sessions` is
 * keyed `limit:page:status`. That is correct for the page body and wrong for the totals
 * inside it: `SELECT COUNT(*) FROM sessions` is PAGE-INVARIANT, so every pagination shape
 * was paying for its own full-table scan of ~208k rows to produce the same number.
 * Measured 2026-08-13: that one count ran 16,825 times in 24h for 3.50 BILLION rows read,
 * the single largest reader on this database. The provider-discovery union was another
 * 3.14 billion. Together, two thirds of morscan's D1 bill for two values that barely move.
 *
 * So: cache the value once, under a key that does NOT carry the request shape, and let
 * every caller and every page share it.
 *
 * Fails OPEN in both directions - a KV miss, a parse error or a write failure all fall
 * through to the real query. A cache that can break the page is worse than no cache.
 */
export async function withKvValue<T>(
	env: Env,
	cacheKey: string,
	ttlSeconds: number,
	compute: () => Promise<T>,
): Promise<T> {
	const kv = env.MORSCAN_CACHE;
	if (kv) {
		try {
			const raw = await kv.get(cacheKey);
			if (raw !== null) {
				const entry = JSON.parse(raw) as { cachedAt: number; value: T };
				if (Date.now() - entry.cachedAt < ttlSeconds * 1000) return entry.value;
			}
		} catch (_e) {
			// Corrupted or unreadable entry - recompute rather than fail.
		}
	}

	const value = await compute();

	if (kv) {
		try {
			await kv.put(cacheKey, JSON.stringify({ cachedAt: Date.now(), value }), {
				// KV's minimum expirationTtl is 60s; the cachedAt check above enforces the
				// real TTL when it is shorter.
				expirationTtl: Math.max(ttlSeconds, 60),
			});
		} catch (_e) {
			// Non-fatal: the value is already computed and correct.
		}
	}

	return value;
}

/**
 * Write a pre-built response body to KV cache (used by SyncCoordinator to warm cache).
 */
export async function warmKvCache(
	env: Env,
	cacheKey: string,
	body: string,
	ttlSeconds: number,
): Promise<void> {
	const kv = env.MORSCAN_CACHE;
	if (!kv) return;
	const entry: KvCacheEntry = { cachedAt: Date.now(), body };
	await kv.put(cacheKey, JSON.stringify(entry), {
		expirationTtl: Math.max(ttlSeconds, 60),
	});
}

/**
 * Try to serve from CF Cache API. On miss, call the handler, cache the result, return it.
 */
export async function withCfCache(
	cacheKey: string,
	ttlSeconds: number,
	handler: () => Promise<Response>,
): Promise<Response> {
	const cache = caches.default;
	const cacheUrl = new URL(`https://morscan-cache.internal/${cacheKey}`);
	const cacheRequest = new Request(cacheUrl.toString());

	const cached = await cache.match(cacheRequest);
	if (cached) {
		const headers = new Headers(cached.headers);
		headers.set("X-Cache", "HIT");
		headers.set("X-Cache-Source", "cf");
		return new Response(cached.body, { status: cached.status, headers });
	}

	const response = await handler();
	const body = await response.text();

	if (response.ok) {
		const cacheResponse = new Response(body, {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": `public, max-age=${ttlSeconds}`,
				"Access-Control-Allow-Origin": "*",
			},
		});
		try {
			await cache.put(cacheRequest, cacheResponse);
		} catch (_e) {
			// CF cache put failures are non-fatal
		}
	}

	const headers = new Headers(response.headers);
	headers.set("X-Cache", "MISS");
	return new Response(body, { status: response.status, headers });
}

/**
 * Invalidate CF Cache entries by key. Called by sync after writing new data.
 * Ensures stale responses are purged immediately, not after a TTL timer.
 */
export async function invalidateCfCache(keys: string[]): Promise<void> {
	const cache = caches.default;
	await Promise.all(
		keys.map((k) => {
			const url = new URL(`https://morscan-cache.internal/${k}`);
			return cache.delete(new Request(url.toString())).catch(() => {});
		}),
	);
}
