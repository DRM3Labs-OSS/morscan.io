/**
 * Console - the wallet-first console page and API-key management.
 *   GET  /console            - connect page (no session) or key management
 *   POST /console/key        - create or rotate the identity's API key
 *   POST /console/key/revoke - delete the identity's API key
 */

import {
	deleteApiKey,
	getApiKeyCaps,
	getApiKeyConsoleRow,
	listUsageCounters,
	upsertApiKeyWithRotation,
} from "../../db/auth";
import type { Env } from "../../types";
import { sessionPayload } from "../../utils/auth";
import { stakeMorFor, FREE_VOLUME, type Caps } from "../../utils/stake-tier";
import { getProviders } from "../../providers";
import { baseUrl } from "../../config";
import { JSON_NO_STORE, shortAddr, capsLine } from "./helpers";
import { CSP, withWalletBadge } from "../../handlers/ui/shared";

// console.html was split into <200-LOC head/body/script fragments;
// recombine byte-identically (same pattern as app.html / api.html).
import consoleHead from "../../ui/partials/console-head.html";
import consoleBody from "../../ui/partials/console-body.html";
import consoleScript from "../../ui/partials/console-script.html";
// Shared interactive price widget (same one the landing hero renders): live
// price + hover chart + timeframe pills + network stats, all from public
// endpoints. Injected once here; it self-skips when the connect view is hidden.
import priceWidgetHtml from "../../ui/partials/price-widget.html";
// Vanilla WalletConnect EthereumProvider, pre-bundled to a browser IIFE by
// esbuild (npm run build:wc -> tools/wc-build/wc-entry.js). Self-served at
// GET /console/wc.js so the mobile deep-link connect flow works under CSP
// (script-src 'self') with no CDN. Exposes window.WalletConnectEthereumProvider.
import wcProvider from "../../ui/vendor/wc-provider.txt";

const consoleHtml = withWalletBadge(
	((consoleHead as string) + (consoleBody as string) + (consoleScript as string))
		.split("{{PRICE_WIDGET}}")
		.join(priceWidgetHtml as string),
);

// WalletConnect Cloud project id. A real 32-char id from cloud.reown.com is
// required for the relay to accept live pairings; the placeholder keeps the
// console rendering (extension wallets still work) until one is configured.
const WC_PROJECT_ID_DEFAULT = "morscan-placeholder";

// Masked key rendering (first 8 + last 4): the page ships the masked form as
// visible text; the full value rides in data-key for the Show/Copy affordances.
const maskKey = (k: string) => (k.length > 16 ? `${k.slice(0, 8)}...${k.slice(-4)}` : k);

export async function handleConsoleRoutes(
	path: string,
	method: string,
	_url: URL,
	request: Request,
	env: Env,
): Promise<Response | null> {
	// GET /console/wc.js - self-served WalletConnect EthereumProvider bundle.
	// Same-origin so it loads under CSP script-src 'self' (no CDN). Immutable
	// build artifact, so cache hard.
	if (path === "/console/wc.js" && method === "GET") {
		return new Response(wcProvider as string, {
			headers: {
				"Content-Type": "application/javascript; charset=utf-8",
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	}

	// GET /console - wallet-first console and the site's single sign-in door.
	// No session shows the connect page (Connect Wallet primary + a secondary
	// "have an API key" sign-in for returning key holders and SSO identities);
	// a session shows key management + live caps.
	if (path === "/console" && method === "GET") {
		const payload = await sessionPayload(request, env);
		const esc = (t: string) =>
			t
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;");
		// CSP is applied here (the canonical CSP incl. the WalletConnect relay hosts)
		// so the wallet connect flow runs without a policy violation.
		const htmlHeaders = {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Frame-Options": "DENY",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "strict-origin-when-cross-origin",
			"Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
			"Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
			"Content-Security-Policy": CSP,
		};
		const wcProjectId = env.MORSCAN_WALLETCONNECT_PROJECT_ID || WC_PROJECT_ID_DEFAULT;
		// IdP sign-in renders in the secondary key area only when the operator
		// configures SSO_LAUNCH_URL.
		const ssoButton = env.SSO_LAUNCH_URL
			? `<a href="${env.SSO_LAUNCH_URL}" style="display:block;width:100%;background:var(--green);border:1px solid var(--green);color:var(--bg);padding:0.65rem;font-family:inherit;font-size:0.72rem;font-weight:600;text-decoration:none;text-align:center;margin-bottom:0.6rem;letter-spacing:0.03em">Sign in with ${env.IDP_NAME || "SSO"} &rarr;</a>`
			: "";
		if (!payload) {
			const html = (consoleHtml as string)
				.split("{{BASE_URL}}")
				.join(baseUrl())
				.split("{{WC_PROJECT_ID}}")
				.join(wcProjectId)
				.split("{{SSO_BUTTON}}")
				.join(ssoButton)
				.split("{{CONNECT_DISPLAY}}")
				.join("block")
				.split("{{CONSOLE_DISPLAY}}")
				.join("none")
				.split("{{IDENTITY_NAME}}")
				.join("")
				.split("{{WALLET_ADDR}}")
				.join("")
				.split("{{WALLET_SHORT}}")
				.join("")
				.split("{{STAKE_MOR}}")
				.join("0")
				.split("{{CAPS_LINE}}")
				.join("")
				.split("{{WALLET_ROW_DISPLAY}}")
				.join("none")
				.split("{{KEY_VALUE}}")
				.join("")
				.split("{{KEY_MASKED}}")
				.join("")
				.split("{{HAS_KEY_DISPLAY}}")
				.join("none")
				.split("{{NO_KEY_DISPLAY}}")
				.join("none");
			return new Response(html, { headers: htmlHeaders });
		}
		const row = await getApiKeyConsoleRow(env.DB, payload.keyId).catch(() => null);
		const isWallet = payload.keyId.startsWith("wallet:");
		const isIdp = payload.keyId.startsWith("user:");
		const ownsKey = isWallet || isIdp;
		const addr = isWallet ? payload.keyId.slice("wallet:".length) : "";
		let stakeMor = 0;
		let caps: Caps;
		if (isWallet) {
			stakeMor = await stakeMorFor(env, addr);
			caps = getProviders().commerce.capsForStake(stakeMor);
		} else {
			caps = {
				burst: row?.rate_limit ?? 30,
				daily: row?.daily_cap ?? 2000,
				monthly: row?.monthly_cap ?? 40000,
			};
		}
		const html = (consoleHtml as string)
			.split("{{BASE_URL}}")
			.join(baseUrl())
			.split("{{WC_PROJECT_ID}}")
			.join(wcProjectId)
			.split("{{SSO_BUTTON}}")
			.join(ssoButton)
			.split("{{CONNECT_DISPLAY}}")
			.join("none")
			.split("{{CONSOLE_DISPLAY}}")
			.join("block")
			.split("{{IDENTITY_NAME}}")
			.join(esc(payload.name || payload.keyId))
			.split("{{WALLET_ADDR}}")
			.join(esc(addr))
			.split("{{WALLET_SHORT}}")
			.join(esc(addr ? shortAddr(addr) : ""))
			.split("{{STAKE_MOR}}")
			.join(
				esc(
					stakeMor >= 1000
						? Math.floor(stakeMor).toLocaleString("en-US")
						: stakeMor.toLocaleString("en-US", { maximumFractionDigits: 2 }),
				),
			)
			.split("{{CAPS_LINE}}")
			.join(capsLine(caps))
			.split("{{WALLET_ROW_DISPLAY}}")
			.join(isWallet ? "block" : "none")
			.split("{{KEY_VALUE}}")
			.join(ownsKey && row?.key ? esc(row.key) : "")
			.split("{{KEY_MASKED}}")
			.join(ownsKey && row?.key ? esc(maskKey(row.key)) : "")
			.split("{{HAS_KEY_DISPLAY}}")
			.join(ownsKey && row?.key ? "block" : "none")
			.split("{{NO_KEY_DISPLAY}}")
			.join(ownsKey && row?.key ? "none" : ownsKey ? "block" : "none");
		return new Response(html, { headers: htmlHeaders });
	}

	// POST /console/key - create or rotate the signed-in identity's API key.
	if (path === "/console/key" && method === "POST") {
		const payload = await sessionPayload(request, env);
		if (!payload)
			return new Response(JSON.stringify({ error: "Sign in first" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		const isWallet = payload.keyId.startsWith("wallet:");
		if (!isWallet && !payload.keyId.startsWith("user:")) {
			return new Response(
				JSON.stringify({
					error:
						"Personal keys are issued to connected wallets and signed-in accounts only",
				}),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		// Wallet identities insert at their live-stake caps; IdP identities keep
		// the legacy 30/min free tier. Rotation (the conflict path) never touches
		// caps - only the key value changes.
		let burst = 30;
		let daily: number | null = null;
		let monthly: number | null = null;
		if (isWallet) {
			const caps = getProviders().commerce.capsForStake(
				await stakeMorFor(env, payload.keyId.slice("wallet:".length)),
			);
			burst = caps.burst;
			daily = caps.daily;
			monthly = caps.monthly;
		}
		const newKey = `mor_${crypto.randomUUID().replace(/-/g, "")}`;
		await upsertApiKeyWithRotation(
			env.DB,
			payload.keyId,
			newKey,
			payload.name || payload.keyId,
			burst,
			daily,
			monthly,
			Math.floor(Date.now() / 1000),
		);
		return new Response(JSON.stringify({ ok: true, key: newKey }), {
			headers: JSON_NO_STORE,
		});
	}

	// GET /console/usage - the signed-in key's live consumption vs. its caps.
	// Reads today's + this month's usage_counters rows and the key's caps from
	// api_keys (NULL caps fall back to the free volume defaults). Session-gated.
	if (path === "/console/usage" && method === "GET") {
		const payload = await sessionPayload(request, env);
		if (!payload)
			return new Response(JSON.stringify({ error: "Sign in first" }), {
				status: 401,
				headers: JSON_NO_STORE,
			});
		const row = await getApiKeyCaps(env.DB, payload.keyId).catch(() => null);
		// UTC buckets: 'd:YYYY-MM-DD' and 'm:YYYY-MM' (see rate-limit.ts).
		const now = new Date();
		const y = now.getUTCFullYear();
		const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
		const da = String(now.getUTCDate()).padStart(2, "0");
		const dayBucket = `d:${y}-${mo}-${da}`;
		const monthBucket = `m:${y}-${mo}`;
		const counts = await listUsageCounters(
			env.DB,
			payload.keyId,
			dayBucket,
			monthBucket,
		).catch(() => null);
		let dayUsed = 0;
		let monthUsed = 0;
		for (const c of counts || []) {
			if (c.bucket === dayBucket) dayUsed = c.count;
			else if (c.bucket === monthBucket) monthUsed = c.count;
		}
		const dailyCap = row?.daily_cap ?? FREE_VOLUME.daily;
		const monthlyCap = row?.monthly_cap ?? FREE_VOLUME.monthly;
		const perMinCap = row?.rate_limit ?? 10;
		return new Response(
			JSON.stringify({
				today: { used: dayUsed, cap: dailyCap },
				month: { used: monthUsed, cap: monthlyCap },
				perMin: { cap: perMinCap },
			}),
			{ headers: JSON_NO_STORE },
		);
	}

	// POST /console/key/revoke
	if (path === "/console/key/revoke" && method === "POST") {
		const payload = await sessionPayload(request, env);
		if (!payload)
			return new Response(JSON.stringify({ error: "Sign in first" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		if (!payload.keyId.startsWith("user:") && !payload.keyId.startsWith("wallet:")) {
			return new Response(JSON.stringify({ error: "Nothing to revoke" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}
		await deleteApiKey(env.DB, payload.keyId);
		return new Response(JSON.stringify({ ok: true }), { headers: JSON_NO_STORE });
	}

	return null;
}
