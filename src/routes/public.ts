/**
 * Public Routes - no auth required
 */

import type { Env } from "../types";
import { BUILD_INFO } from "../build-info";
import { MORSCAN_VERSION } from "../version";
import { baseUrl, provenanceEnabled, signingMnemonic } from "../config";
import { signBuildReceipt } from "../utils/provenance";
import { handleHealth } from "../handlers/health";
import { handleOpenApi } from "../handlers/openapi";
import {
	handleLlmsTxt,
	handleLlmsFullTxt,
	handleRobotsTxt,
	handleSitemapXml,
} from "../handlers/llms";
import {
	handlePrice,
	handleChartSvg,
	handlePriceChart,
	chartWindowDays,
} from "../handlers/price";
import { handleTeaser } from "../handlers/teaser";
import { handleWellKnownKeys } from "../handlers/well-known";
import { handleAgentReadyRoutes } from "../handlers/agent-ready";
import { handleNotify } from "../handlers/notify";
import { handleSyncRoute } from "./sync";
import { getProviders, getOverriddenProviders } from "../providers";
import { getCompositionDeploy } from "../providers/compose";
import { validateApiKey, checkRateLimit, rateLimitResponse } from "../utils/auth";
import { withCfCache, withKvCache } from "../utils/cache";

export async function handlePublicRoutes(
	path: string,
	_method: string,
	request: Request,
	url: URL,
	env: Env,
	HEADERS: Record<string, string>,
): Promise<Response | null> {
	// Coming-soon launch-list capture (public, unauthenticated by design).
	if (path === "/notify") {
		return await handleNotify(request, env, HEADERS);
	}

	// Admin surface for those captures (admin-key gated). Lets operators - and
	// an operator admin console, which server-side-fetches /api/admin/notify - see the
	// launch list. Emails are PII, so this is never public.
	if (path === "/api/admin/notify" || path === "/admin/notify") {
		const notifyAdminResult = await getProviders().admin.handleNotify(
			path,
			request,
			url,
			env,
		);
		if (notifyAdminResult) return notifyAdminResult;
	}

	if (path === "/openapi.json" || path === "/openapi") {
		return handleOpenApi(HEADERS, url.origin);
	}
	if (path === "/llms.txt") {
		return handleLlmsTxt(env);
	}
	if (path === "/llms-full.txt") {
		return handleLlmsFullTxt(env);
	}
	if (path === "/robots.txt") {
		return handleRobotsTxt();
	}
	if (path === "/sitemap.xml") {
		return await withCfCache("sitemap:v2", 3600, () => handleSitemapXml(env));
	}

	// Health & Status (no key required)
	// 3s cache TTL - sync bar polls every 5s, needs fresh data
	if (path === "/health") {
		return await withCfCache("health:v1", 3, () => handleHealth(env, HEADERS));
	}

	// Build identity: which commit + provenance version is actually running.
	// The unsigned fields (backward compatible) are asserted by the build; the
	// additive `receipt` is an Ed25519 provenance receipt over that same build
	// identity, signed with MorScan's morscan/cache key (the one published at
	// /.well-known/morscan-keys.json). Signed once per deploy and memoized.
	if (path === "/version") {
		// Sovereignty switch honesty: with PROVENANCE_ENABLED="false" the build
		// receipt is never signed (the WASM signer is never initialized) and the
		// response carries the explicit marker provenance: "disabled".
		const provenance = provenanceEnabled(env) ? "enabled" : "disabled";
		const mnemonic = signingMnemonic(env);
		const receiptJson = mnemonic ? signBuildReceipt(mnemonic) : null;
		let receipt: unknown = null;
		try {
			receipt = receiptJson ? JSON.parse(receiptJson) : null;
		} catch {
			receipt = null;
		}
		const verification = receipt
			? {
					method: "ed25519-provenance-receipt",
					action: "morscan.build",
					signer_path: "morscan/cache",
					public_keys: `${baseUrl()}/.well-known/morscan-keys.json`,
					note: "A valid signature proves this exact build identity was attested by the holder of MorScan's morscan/cache key, not merely self-asserted. It does not by itself prove the deployed bytes were compiled from this commit. Verify offline: fetch the public key above, then Receipt.fromJson(receipt).verify() with @drm3labs-oss/provenance and confirm the receipt public key matches.",
				}
			: null;
		// Composition honesty marker (additive): which core this build is and
		// which provider seams the deployed composition overrode. The reference
		// build reports overrides: [] and omits `deploy`; a private composition
		// reports its injected seams plus its own deploy identity (repo commit,
		// pinned core ref, dirtiness). See docs/architecture/providers.md.
		const deploy = getCompositionDeploy();
		const composition = {
			core: { version: MORSCAN_VERSION, commit: BUILD_INFO.commit },
			overrides: getOverriddenProviders(),
			...(deploy ? { deploy } : {}),
		};
		return new Response(
			JSON.stringify(
				{
					version: MORSCAN_VERSION,
					...BUILD_INFO,
					provenance,
					composition,
					receipt,
					verification,
				},
				null,
				2,
			),
			{ headers: { ...HEADERS, "content-type": "application/json" } },
		);
	}

	if (path === "/.well-known/morscan-keys.json") {
		return await handleWellKnownKeys(env);
	}

	// Agent-ready discovery surfaces: RFC 9727 api-catalog, RFC 9728 protected
	// resource metadata, /auth.md, MCP server card, agent skills, /webmcp.js.
	const agentReadyResult = await handleAgentReadyRoutes(path, env);
	if (agentReadyResult) return agentReadyResult;

	// A request carrying a key must NOT be short-circuited to the free keyless
	// price paths below: it has to flow through the metered api.ts path so the
	// call actually decrements the caller's quota (a keyed playground RUN that
	// never dropped was this exact leak). Anonymous callers (no key) keep the
	// free, edge-cached price for the public widget. `Authorization: Bearer`
	// counts as a key too, matching validateWalletAuth's resolution order.
	const carriesKey =
		!!request.headers.get("X-Morscan-Key") ||
		(request.headers.get("Authorization")?.startsWith("Bearer ") ?? false);

	// MOR price (no key required - publicly available market data)
	if (path === "/mor/v1/price" && !carriesKey) {
		return await withCfCache("v1:price", 60, () => handlePrice(env, HEADERS));
	}

	// Pre-rendered 90-day price chart SVG (no key required - cached, public)
	if (path === "/chart.svg") {
		return await handleChartSvg(env);
	}

	// Price-chart JSON (no key required - same public market data as /chart.svg,
	// just the point series the interactive widget draws). ?window=24h|7d|30d|90d
	// selects the timeframe; cached per window.
	if (path === "/mor/v1/price/chart" && !carriesKey) {
		const days = chartWindowDays(url.searchParams.get("window"));
		return await withKvCache(env, `v1:price:chart:${days}`, 600, () =>
			handlePriceChart(env, HEADERS, days),
		);
	}

	// Public teaser stats (no key required) - for login page
	if (path === "/teaser") {
		const teaserRateCheck = await checkRateLimit(request, env, undefined, 30);
		if (!teaserRateCheck.allowed) {
			return rateLimitResponse(teaserRateCheck.retryAfter || 60);
		}
		return await withCfCache("teaser:v1", 30, () => handleTeaser(env, HEADERS));
	}

	// === SYNC/ADMIN ROUTES (admin-class keys only - internal operations) ===
	if (path === "/trigger-sync" || path.startsWith("/sync/")) {
		const auth = await validateApiKey(request, env);
		if (!getProviders().admin.isAdmin(auth, env)) {
			return new Response(
				JSON.stringify({ error: "Sync routes restricted to SDK key" }),
				{ status: 403, headers: HEADERS },
			);
		}
		return await handleSyncRoute(path, url, env, HEADERS);
	}

	return null;
}
