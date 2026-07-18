/**
 * API Routes - /mor/v1/* (dual-auth + rate limited)
 */

import { listDiamondUpgrades } from "../db/ops";
import type { Env } from "../types";
import {
	validateWalletAuth,
	checkRateLimit,
	checkIpRateLimit,
	rateLimitResponse,
} from "../utils/auth";
import { rateLimitHeaders, type RateLimitInfo } from "../utils/auth/rate-limit";
import { handleAll, handleProviders, handleBids } from "../handlers/marketplace";
import {
	handleAllSessions,
	handleWalletSessions,
	handleSessionAnalytics,
	handleWalletDetail,
	handleWalletAudit,
	handleWalletTransactions,
} from "../handlers/sessions";
import {
	handleGetModels,
	handleGetModelName,
	handleSetModelName,
	handleModelLookup,
} from "../handlers/models";
import {
	handleReputation,
	handleProviderReputation,
	handleDisputes,
} from "../handlers/reputation";
import { handleLeaderboard } from "../handlers/leaderboard";
import { handlePrice, handlePriceChart, chartWindowDays } from "../handlers/price";
import { handleWalletGas } from "../handlers/analytics";
import { handleHolders, handleDustHolders } from "../handlers/holders";
import { handleUiInit } from "../handlers/fatboy";
import {
	handleProviderDetail,
	handleModelDemand,
	handleDailySessions,
} from "../handlers/provider-detail";
import { handleModelDetail } from "../handlers/model-detail";
import {
	handleBuilderSubnets,
	handleBuilderSubnetDetail,
	handleBuilderWalletStakes,
	handleBuilderStats,
	handleBuilderEvents,
	handleBuilderAll,
} from "../handlers/builder";
import { handleProvenance } from "../handlers/provenance";
import { handleSyncStatus } from "../handlers/health";
import { withKvCache, withCfCache } from "../utils/cache";
import {
	estimatedDayReads,
	heavyUncachedEstimate,
	isOverReadBudget,
	noteRowsRead,
	readBudget,
	secondsToUtcMidnight,
} from "../utils/d1-budget";
import type { X402Payment } from "../utils/x402";
import { getProviders } from "../providers";
import type { AuthResult } from "../utils/auth/key-validation";

/**
 * Does this path match a real /mor/v1/* endpoint? Genuinely unknown paths must
 * 404 BEFORE the auth gate, so a typo'd URL returns "Not found" rather than a
 * misleading "Authentication required" 401. Real endpoints called without a
 * key still fall through to auth and correctly 401.
 */
export function isKnownApiPath(path: string): boolean {
	const exact = new Set([
		"/mor/v1/ui-init",
		"/mor/v1/all",
		"/mor/v1/marketplace",
		"/mor/v1/providers",
		"/mor/v1/bids",
		"/mor/v1/price",
		"/mor/v1/price/chart",
		"/mor/v1/analytics",
		"/mor/v1/leaderboard",
		"/mor/v1/models",
		"/mor/v1/models/lookup",
		"/mor/v1/models/demand",
		"/mor/v1/reputation",
		"/mor/v1/disputes",
		"/mor/v1/bq/status",
		"/mor/v1/bq/backfill",
		"/mor/v1/upgrades",
		"/mor/v1/holders",
		"/mor/v1/holders/dust",
		"/mor/v1/provenance",
		"/mor/v1/pools",
		"/mor/v1/builder/subnets",
		"/mor/v1/builder/stats",
		"/mor/v1/builder/events",
		"/mor/v1/builder/all",
		"/mor/v1/sessions",
		"/mor/v1/sessions/analytics",
		"/mor/v1/sessions/daily",
		"/mor/v1/sync-status",
		"/mor/v1/capacity",
	]);
	if (exact.has(path)) return true;
	// Model name get/set - any /mor/v1/models/<id> suffix is a real endpoint.
	if (path.startsWith("/mor/v1/models/")) return true;
	const patterns = [
		/^\/mor\/v1\/providers\/0x[0-9a-fA-F]{40}$/,
		/^\/mor\/v1\/reputation\/0x[0-9a-fA-F]{40}$/,
		/^\/mor\/v1\/builder\/subnets\/0x[0-9a-fA-F]{64}$/,
		/^\/mor\/v1\/builder\/stakes\/0x[0-9a-fA-F]{40}$/i,
		/^\/mor\/v1\/sessions\/0x[0-9a-fA-F]{40}$/,
		/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}$/,
		/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}\/transactions$/,
		/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}\/gas$/,
		/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}\/audit$/,
	];
	return patterns.some((re) => re.test(path));
}

/**
 * Merge standard X-RateLimit-* headers onto a metered handler's response so a
 * client/SDK can see how close it is and back off. Response headers are
 * immutable, so clone. Kept in ONE place and applied to the metered path only
 * (not the free capacity/upstream endpoints).
 */
function withRateLimitHeaders(resp: Response, limits: RateLimitInfo): Response {
	const headers = new Headers(resp.headers);
	for (const [k, v] of Object.entries(rateLimitHeaders(limits))) headers.set(k, v);
	return new Response(resp.body, {
		status: resp.status,
		statusText: resp.statusText,
		headers,
	});
}

export async function handleApiRoutes(
	path: string,
	request: Request,
	url: URL,
	env: Env,
	HEADERS: Record<string, string>,
	ctx?: ExecutionContext,
): Promise<Response | null> {
	if (!path.startsWith("/mor/v1/")) return null;

	// Open-core seams: commerce (offers/payments/caps), analytics (D1 + optional
	// BQ), admin (operator gate). Default = bundled reference impls, so behavior
	// is identical to today. See src/providers/index.ts for the injection point.
	const { commerce, analytics, admin } = getProviders();

	// The purchasable-offer door: POST /mor/v1/keys/purchase. Keyless and
	// PRE-AUTH by design - the request IS the purchase (a 402 menu without
	// X-PAYMENT, settle-then-mint with one). Delegated entirely to the provider;
	// the reference build has no purchase capability so the path 404s exactly
	// like any unknown path (door absent). Per-IP limited (it is keyless).
	if (path === "/mor/v1/keys/purchase") {
		if (!commerce.purchaseOffer) {
			return new Response(JSON.stringify({ error: "Not found" }), {
				status: 404,
				headers: HEADERS,
			});
		}
		if (request.method !== "POST") {
			return new Response(JSON.stringify({ error: "POST required" }), {
				status: 405,
				headers: { ...HEADERS, Allow: "POST, OPTIONS" },
			});
		}
		const ipCheck = await checkIpRateLimit(request, env, undefined, 30);
		if (!ipCheck.allowed) {
			return rateLimitResponse(ipCheck.retryAfter || 60, ipCheck.reason);
		}
		return await commerce.purchaseOffer(env, request);
	}

	// Unknown /mor/v1/* path → 404 (not the auth 401). Real endpoints continue.
	if (!isKnownApiPath(path)) {
		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: HEADERS,
		});
	}

	// Three consumer types: SDK (wallet-signed), explorer UI (JWT), direct API (API keys).
	// A fourth, keyless, path: x402 micropayments (see below). Auth method logged
	// per request for migration tracking.
	let auth = await validateWalletAuth(request, env);
	// Deferred x402 settlement: recorded after the rate gate so a 429'd request
	// never consumes the client's payment nonce.
	let x402Pending: { payment: X402Payment; payer: string } | null = null;
	if (!auth.valid) {
		// x402 micropayments: a request with NO credential at all (bad key != no
		// key) hitting a metered data endpoint gets a 402 x402 envelope instead
		// of a 401, and may retry with a signed X-PAYMENT authorization. Free
		// endpoints (price/chart keyless are served upstream; capacity) and the
		// whole feature when X402_PAY_TO is unset keep the 401 behavior.
		const keyless =
			!request.headers.get("X-Morscan-Key") &&
			!request.headers.get("Authorization")?.startsWith("Bearer ") &&
			!request.headers.get("X-Morscan-Wallet");
		const x402Metered =
			path !== "/mor/v1/capacity" &&
			path !== "/mor/v1/price" &&
			path !== "/mor/v1/price/chart";
		if (keyless && x402Metered && commerce.paymentsEnabled(env)) {
			const paymentHeader = request.headers.get("X-PAYMENT");
			if (!paymentHeader) {
				return commerce.paymentRequired(env, request.url);
			}
			const verified = await commerce.verifyPayment(env, paymentHeader);
			if (!verified.ok) {
				console.log(
					JSON.stringify({
						t: "x402_reject",
						error: verified.error,
						ip: request.headers.get("CF-Connecting-IP") || "unknown",
						path: path,
					}),
				);
				return commerce.paymentRequired(env, request.url, verified.error);
			}
			// Verified payment: proceed as an authenticated caller. Per-IP limits
			// and the 60/min per-payer pool still apply; settlement (the nonce-
			// consuming insert) happens after the rate gate.
			x402Pending = { payment: verified.payment, payer: verified.payer };
			auth = {
				valid: true,
				keyId: `x402:${verified.payer}`,
				name: `x402 ${verified.payer}`,
				rateLimit: 60,
				authMethod: "api_key",
			} as AuthResult;
		} else {
			console.log(
				JSON.stringify({
					t: "auth_fail",
					error: auth.error,
					wallet: request.headers.get("X-Morscan-Wallet") || null,
					ip: request.headers.get("CF-Connecting-IP") || "unknown",
					path: path,
				}),
			);
			const errBody: Record<string, unknown> = {
				error: auth.error || "Authentication required",
			};
			if (auth.serverTime) errBody.server_time = auth.serverTime;
			const status = 401;
			return new Response(JSON.stringify(errBody), { status, headers: HEADERS });
		}
	}
	// Introspection is FREE and IP-rate-limited, not key-metered. Checking your
	// remaining capacity must never cost capacity, so /mor/v1/capacity REPORTS
	// quota without SPENDING it: gated on a per-IP budget only, skipping the
	// per-key minute/day/month meter below. (/health
	// and /mor/v1/price are served free upstream in routes/public.ts.) Real data
	// endpoints past this point stay key-metered at a flat 1 tick per call.
	if (path === "/mor/v1/capacity") {
		const ipCheck = await checkIpRateLimit(request, env, auth, 60);
		if (!ipCheck.allowed)
			return rateLimitResponse(ipCheck.retryAfter || 60, ipCheck.reason);
		return await commerce.capacity(env, auth, HEADERS);
	}

	const rateCheck = await checkRateLimit(request, env, auth);
	if (!rateCheck.allowed) {
		console.log(
			JSON.stringify({
				t: "rate_limit",
				wallet: auth.stakingWallet || null,
				keyId: auth.keyId || null,
				path: path,
			}),
		);
		return rateLimitResponse(
			rateCheck.retryAfter || 60,
			rateCheck.reason,
			rateCheck.limits,
		);
	}

	// Prepaid call balances (the pack door). Burst first, balance second: only
	// requests that passed the rate gate reach the debit, so a flood cannot
	// grind D1. When the composed provider meters prepaid keys, one metered
	// call debits ONE call; an exhausted balance returns 402 with the purchase
	// menu (buy more calls), never a 429. Reference builds omit the hook.
	if (auth.keyId && commerce.debitCallBalance) {
		const denied = await commerce.debitCallBalance(env, auth.keyId);
		if (denied) return denied;
	}

	// x402: rate gate passed - now accept the payment. The insert is the atomic
	// nonce gate (UNIQUE(payer, nonce)), so a replayed authorization dies here
	// with a 402 and never reaches the data handler. In facilitator mode this
	// also broadcasts on-chain; in verify-only mode it queues for batch settlement.
	let x402Ack: string | null = null;
	if (x402Pending) {
		const settle = await commerce.settlePayment(
			env,
			x402Pending.payment,
			x402Pending.payer,
			request.url,
		);
		if (!settle.ok) {
			return commerce.paymentRequired(env, request.url, settle.error);
		}
		x402Ack = settle.ackHeader || null;
		console.log(
			JSON.stringify({
				t: "x402_accept",
				payer: x402Pending.payer,
				path: path,
				ip: request.headers.get("CF-Connecting-IP") || "unknown",
			}),
		);
	}

	// Structured auth log for every request
	console.log(
		JSON.stringify({
			t: "auth",
			method: auth.authMethod || "unknown",
			wallet: auth.stakingWallet || null,
			tier: auth.walletAuth ? (auth.isCiWallet ? "ci" : "sdk") : "api_key",
			keyId: auth.keyId || null,
			path: path,
			ip: request.headers.get("CF-Connecting-IP") || "unknown",
		}),
	);

	// Everything past here is a metered data endpoint. Dispatch it, then merge the
	// X-RateLimit-* headers onto whatever the handler returned (one place).
	const rlLimits = rateCheck.limits;
	const dispatch = async (): Promise<Response> => {
		// D1 rows-read budget backstop (Free plan). The heavy UNCACHED endpoints
		// are the ones that can silently blow the ~5M/day free rows-read quota under
		// a flood; when the UTC day is at budget, shed them to a 503 with
		// Retry-After instead of hard-crashing the quota (the cached endpoints stay
		// up). Admin bypasses. Non-guarded paths return 0 and are untouched.
		const readEst = heavyUncachedEstimate(path);
		if (readEst > 0 && !admin.isAdmin(auth, env)) {
			if (await isOverReadBudget(env)) {
				const retry = secondsToUtcMidnight();
				console.log(
					JSON.stringify({
						t: "d1_budget_shed",
						path,
						dayReads: estimatedDayReads(),
						budget: readBudget(env),
					}),
				);
				return new Response(
					JSON.stringify({
						error:
							"MorScan is shedding load to stay within its daily data budget. Cached endpoints still work; retry this query later.",
						retry_after: retry,
					}),
					{ status: 503, headers: { ...HEADERS, "Retry-After": String(retry) } },
				);
			}
			noteRowsRead(env, ctx, readEst);
		}
		// Fatboy blob for SPA (not in OpenAPI docs)
		// ui-init is the SPA's primary data blob, fetched on every explorer load. It
		// runs several full-table GROUP BY / COUNT(*) scans over ~100k sessions rows
		// (~700k rows read per call), so an uncached blob was a top D1 rows-read
		// driver. KV-cache it (global, 30s) so bursty page loads share one compute.
		// The explorer tolerates a few seconds of staleness, same as v1:all (30s).
		if (path === "/mor/v1/ui-init")
			return await withKvCache(env, "v1:ui-init", 30, () => handleUiInit(env, HEADERS));
		if (path === "/mor/v1/all" || path === "/mor/v1/marketplace")
			return await withKvCache(env, "v1:all", 30, () => handleAll(env, HEADERS));
		if (path === "/mor/v1/providers")
			return await withKvCache(env, "v1:providers", 30, () =>
				handleProviders(env, HEADERS),
			);
		{
			const m = path.match(/^\/mor\/v1\/providers\/(0x[0-9a-fA-F]{40})$/);
			if (m) {
				const addr = m[1].toLowerCase();
				return await withCfCache(`v1:providers:${addr}`, 300, () =>
					handleProviderDetail(env, addr, HEADERS),
				);
			}
		}
		if (path === "/mor/v1/bids")
			return await withKvCache(env, "v1:bids", 30, () => handleBids(env, HEADERS));
		if (path === "/mor/v1/price")
			return await withCfCache("v1:price", 60, () => handlePrice(env, HEADERS));
		if (path === "/mor/v1/price/chart") {
			// Normally served keyless by routes/public.ts; kept here window-aware so a
			// keyed SDK call to the same path behaves identically.
			const days = chartWindowDays(url.searchParams.get("window"));
			return await withKvCache(env, `v1:price:chart:${days}`, 600, () =>
				handlePriceChart(env, HEADERS, days),
			);
		}
		// Analytics aggregates gas + session-duration stats over the whole sessions
		// table (an un-indexed ORDER BY closed_at scan + a NOT IN pending-receipt
		// scan, ~400k rows read per call). It was uncached; the underlying numbers
		// move slowly, so KV-cache it (global, 300s) to collapse repeat page loads
		// onto one compute. Pairs with the idx_sessions_closed_at index below.
		if (path === "/mor/v1/analytics")
			return await withKvCache(env, "v1:analytics", 300, () =>
				analytics.overview(env, HEADERS),
			);
		if (path === "/mor/v1/leaderboard") {
			return await withKvCache(env, "v1:leaderboard:", 600, () =>
				handleLeaderboard(env, HEADERS, url),
			);
		}
		if (path === "/mor/v1/models") return await handleGetModels(env, HEADERS);
		if (path === "/mor/v1/models/lookup") return await handleModelLookup(env, HEADERS);
		if (path === "/mor/v1/models/demand")
			return await withKvCache(env, "v1:models:demand", 600, () =>
				handleModelDemand(env, HEADERS),
			);
		if (path === "/mor/v1/reputation")
			return await withCfCache("v1:reputation", 60, () => handleReputation(env));
		if (path === "/mor/v1/disputes") return await handleDisputes(env);
		if (path.match(/^\/mor\/v1\/reputation\/0x[0-9a-fA-F]{40}$/))
			return await handleProviderReputation(env, path.split("/").pop() || "");
		// BQ admin: status + backfill (Phase 1 of D1->BQ tier migration).
		if (path === "/mor/v1/bq/status") return await analytics.bqStatus(env, HEADERS);
		if (path === "/mor/v1/bq/backfill" && request.method === "POST") {
			if (!admin.isAdmin(auth, env)) {
				return new Response(JSON.stringify({ error: "admin key required" }), {
					status: 403,
					headers: HEADERS,
				});
			}
			return await analytics.bqBackfill(request, env, HEADERS);
		}
		if (path === "/mor/v1/upgrades") {
			try {
				const rows = await listDiamondUpgrades(env.DB);
				const upgrades = rows.map((r: Record<string, unknown>) => ({
					block: r.block_number,
					txHash: r.tx_hash,
					logIndex: r.log_index,
					facetCount: r.facet_count,
					facetChanges:
						typeof r.facet_changes === "string"
							? JSON.parse(r.facet_changes as string)
							: r.facet_changes,
					timestamp: r.block_timestamp,
				}));
				return new Response(JSON.stringify({ upgrades, count: upgrades.length }), {
					headers: HEADERS,
				});
			} catch {
				return new Response(JSON.stringify({ upgrades: [], count: 0 }), {
					headers: HEADERS,
				});
			}
		}
		// Cache key MUST include limit: the analytics page requests ?limit=1 (page
		// defaults to 1), and without limit in the key that 1-row response poisoned
		// the holders page's page-1 (limit=250) request - page 1 showed a single row.
		if (path === "/mor/v1/holders")
			return await withCfCache(
				`v1:holders:${url.searchParams.get("page") || "1"}:${url.searchParams.get("limit") || "250"}`,
				300,
				() => handleHolders(env, HEADERS, url),
			);
		if (path === "/mor/v1/holders/dust")
			return await withCfCache("v1:holders:dust", 300, () =>
				handleDustHolders(env, HEADERS, url),
			);
		if (path === "/mor/v1/provenance") return await handleProvenance(env, HEADERS, url);
		// Pools
		if (path === "/mor/v1/pools") {
			const { handlePools } = await import("../handlers/pools");
			return await handlePools(env);
		}
		// Builder staking plane
		if (path === "/mor/v1/builder/subnets") return await handleBuilderSubnets(env, url);
		if (path === "/mor/v1/builder/stats") return await handleBuilderStats(env);
		if (path === "/mor/v1/builder/events") return await handleBuilderEvents(env, url);
		if (path === "/mor/v1/builder/all") return await handleBuilderAll(env);
		if (path.match(/^\/mor\/v1\/builder\/subnets\/0x[0-9a-fA-F]{64}$/)) {
			return await handleBuilderSubnetDetail(env, path.split("/").pop() || "");
		}
		if (path.match(/^\/mor\/v1\/builder\/stakes\/0x[0-9a-fA-F]{40}$/i)) {
			return await handleBuilderWalletStakes(env, path.split("/").pop() || "");
		}
		if (path === "/mor/v1/sessions/analytics")
			return await handleSessionAnalytics(env, HEADERS);
		if (path === "/mor/v1/sessions/daily")
			return await withKvCache(env, "v1:sessions:daily", 600, () =>
				handleDailySessions(env, HEADERS),
			);
		if (path.match(/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}\/transactions$/))
			return await handleWalletTransactions(env, path.split("/")[4], HEADERS);
		if (path.match(/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}\/gas$/))
			return await handleWalletGas(env, path.split("/")[4], HEADERS);
		if (path.match(/^\/mor\/v1\/sessions\/0x[0-9a-fA-F]{40}$/))
			return await handleWalletSessions(env, path.split("/").pop() || "", HEADERS);
		if (path === "/mor/v1/sessions") {
			// KV-cache per query shape (limit/page/status) for 30s. The list + COUNT is a
			// hot read (landing feed + the sessions page), so caching collapses bursty
			// loads onto one compute the same way providers/bids/all do.
			const limit = url.searchParams.get("limit") || "";
			const page = url.searchParams.get("page") || "";
			const status = url.searchParams.get("status") || "";
			return await withKvCache(env, `v1:sessions:${limit}:${page}:${status}`, 30, () =>
				handleAllSessions(env, HEADERS, url),
			);
		}
		if (path === "/mor/v1/sync-status") return await handleSyncStatus(env, HEADERS);
		// Model detail - one model's bids, sessions, providers, and demand series.
		// Must match before the generic /mor/v1/models/<id> name lookup below.
		const modelDetail = path.match(/^\/mor\/v1\/models\/(0x[0-9a-fA-F]{64})\/detail$/);
		if (modelDetail) {
			const mid = modelDetail[1].toLowerCase();
			return await withCfCache(`v1:models:${mid}:detail`, 300, () =>
				handleModelDetail(env, mid, HEADERS),
			);
		}
		// Models - GET for specific model, POST for setting name
		if (path.startsWith("/mor/v1/models/") && request.method === "POST") {
			if (!admin.isAdmin(auth, env)) {
				return new Response(JSON.stringify({ error: "admin key required" }), {
					status: 403,
					headers: HEADERS,
				});
			}
			const body = (await request.json()) as Record<string, unknown>;
			return await handleSetModelName(
				env,
				path.split("/").pop() || "",
				body.name as string,
				(body.description as string) || null,
				HEADERS,
			);
		}
		if (path.startsWith("/mor/v1/models/"))
			return await handleGetModelName(env, path.split("/").pop() || "", HEADERS);
		// Wallet detail (full breakdown with balances)
		if (path.match(/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}$/))
			return await handleWalletDetail(env, path.split("/").pop() || "", HEADERS);
		if (path.match(/^\/mor\/v1\/wallet\/0x[0-9a-fA-F]{40}\/audit$/)) {
			const addr = path.split("/")[4];
			return await handleWalletAudit(env, addr, HEADERS);
		}

		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: HEADERS,
		});
	};
	let resp = await dispatch();
	if (rlLimits) resp = withRateLimitHeaders(resp, rlLimits);
	if (x402Ack) {
		// x402 settlement ack (spec: base64 JSON in X-PAYMENT-RESPONSE).
		const headers = new Headers(resp.headers);
		headers.set("X-PAYMENT-RESPONSE", x402Ack);
		resp = new Response(resp.body, {
			status: resp.status,
			statusText: resp.statusText,
			headers,
		});
	}
	return resp;
}
