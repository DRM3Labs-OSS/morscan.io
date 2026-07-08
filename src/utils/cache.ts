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
