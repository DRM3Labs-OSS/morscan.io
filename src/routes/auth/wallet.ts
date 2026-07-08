/**
 * Wallet front door - the primary way in. Connect a wallet, prove ownership by
 * personal_sign, get a session AND a free bottom-tier API key.
 *   GET  /console/wallet/challenge - mint a single-use nonce to sign
 *   POST /console/wallet/verify    - recover the signer, create session + key
 *   GET  /console/wallet/status    - no-store "who am I" probe
 *   POST /console/wallet/disconnect - sign out (key row stays put)
 */

import { getApiKeyValue, insertApiKeyIfAbsent, updateApiKeyCaps } from "../../db/auth";
import type { Env } from "../../types";
import {
	checkRateLimit,
	rateLimitResponse,
	jwtSecret,
	sessionPayload,
} from "../../utils/auth";
import { signJwt, sessionCookie, clearSessionCookie } from "../../utils/jwt";
import { eip191Digest, ecrecover } from "../../utils/crypto";
import { stakeMorFor } from "../../utils/stake-tier";
import { getProviders } from "../../providers";
import { JSON_NO_STORE, walletChallengeMessage, shortAddr } from "./helpers";

export async function handleWalletRoutes(
	path: string,
	method: string,
	_url: URL,
	request: Request,
	env: Env,
): Promise<Response | null> {
	// GET /console/wallet/challenge - the wallet front door, step 1. NOT
	// session-gated: the wallet IS the login. Mints a single-use nonce (KV,
	// 5 min TTL) and returns the exact message the wallet must personal_sign.
	if (path === "/console/wallet/challenge" && method === "GET") {
		const rate = await checkRateLimit(request, env, undefined, 30);
		if (!rate.allowed) return rateLimitResponse(rate.retryAfter || 60, rate.reason);
		if (!env.NONCE_CACHE) {
			return new Response(
				JSON.stringify({
					error: "Wallet connect is not configured (NONCE_CACHE KV binding missing)",
				}),
				{ status: 503, headers: JSON_NO_STORE },
			);
		}
		const nonce = crypto.randomUUID().replace(/-/g, "");
		await env.NONCE_CACHE.put(`wchal:${nonce}`, "1", { expirationTtl: 300 });
		return new Response(
			JSON.stringify({ nonce, message: walletChallengeMessage(nonce) }),
			{ headers: JSON_NO_STORE },
		);
	}

	// POST /console/wallet/verify - the wallet front door, step 2. Recovers the
	// EIP-191 personal_sign signer of the challenge message; on match it CREATES
	// the session (keyId wallet:<addr>) and auto-issues the bottom-tier API key
	// row if absent (60/min, 2,000/day, 40,000/month; stake MOR to raise it).
	if (path === "/console/wallet/verify" && method === "POST") {
		const rate = await checkRateLimit(request, env, undefined, 30);
		if (!rate.allowed) return rateLimitResponse(rate.retryAfter || 60, rate.reason);
		if (!env.NONCE_CACHE) {
			return new Response(
				JSON.stringify({
					error: "Wallet connect is not configured (NONCE_CACHE KV binding missing)",
				}),
				{ status: 503, headers: JSON_NO_STORE },
			);
		}
		const body = await request
			.json<{ wallet?: string; signature?: string; nonce?: string }>()
			.catch(() => null);
		const wallet = (body?.wallet || "").trim();
		const signature = (body?.signature || "").trim();
		const nonce = (body?.nonce || "").trim();
		if (
			!/^0x[0-9a-fA-F]{40}$/.test(wallet) ||
			!signature ||
			!/^[0-9a-f]{32}$/.test(nonce)
		) {
			return new Response(
				JSON.stringify({ error: "Expected { wallet, signature, nonce }" }),
				{ status: 400, headers: JSON_NO_STORE },
			);
		}
		const seen = await env.NONCE_CACHE.get(`wchal:${nonce}`);
		if (!seen) {
			return new Response(
				JSON.stringify({
					error: "Challenge expired or already used. Request a new one.",
				}),
				{ status: 400, headers: JSON_NO_STORE },
			);
		}
		await env.NONCE_CACHE.delete(`wchal:${nonce}`); // single-use
		let recovered = "";
		try {
			recovered = ecrecover(eip191Digest(walletChallengeMessage(nonce)), signature);
		} catch (e) {
			return new Response(
				JSON.stringify({
					error: `Signature verification failed: ${e instanceof Error ? e.message : e}`,
				}),
				{ status: 401, headers: JSON_NO_STORE },
			);
		}
		const addr = wallet.toLowerCase();
		if (recovered !== addr) {
			return new Response(
				JSON.stringify({ error: "Signature does not match the wallet address" }),
				{ status: 401, headers: JSON_NO_STORE },
			);
		}
		const keyId = `wallet:${addr}`;
		// Auto-issue the key row on first connect; caps follow the live stake.
		const stakeMor = await stakeMorFor(env, addr);
		const caps = getProviders().commerce.capsForStake(stakeMor);
		const existing = await getApiKeyValue(env.DB, keyId);
		let newKey: string | undefined;
		if (!existing) {
			newKey = `mor_${crypto.randomUUID().replace(/-/g, "")}`;
			await insertApiKeyIfAbsent(
				env.DB,
				keyId,
				newKey,
				shortAddr(addr),
				caps.burst,
				caps.daily,
				caps.monthly,
				Math.floor(Date.now() / 1000),
			);
		} else {
			// Existing identity: re-apply live-stake caps right now (the cron would
			// catch it within a minute; this makes connect feel instant).
			await updateApiKeyCaps(env.DB, caps.burst, caps.daily, caps.monthly, keyId);
		}
		const session = await signJwt({ keyId, name: shortAddr(addr) }, jwtSecret(env));
		const respBody: Record<string, unknown> = { ok: true, wallet: addr, stakeMor, caps };
		if (newKey) respBody.key = newKey;
		return new Response(JSON.stringify(respBody), {
			headers: { ...JSON_NO_STORE, "Set-Cookie": sessionCookie(session) },
		});
	}

	// GET /console/wallet/status - no-store "who am I" probe. Powers the
	// verified-owner badge on wallet profile pages and the playground key fill
	// (cached pages can never embed a per-user secret, so clients ask here).
	// Signed-out visitors get 200 with nulls, not 401: every explorer page
	// probes this on load and a red console error per pageview is noise.
	if (path === "/console/wallet/status" && method === "GET") {
		const payload = await sessionPayload(request, env);
		if (!payload)
			return new Response(JSON.stringify({ wallet: null, key: null }), {
				headers: JSON_NO_STORE,
			});
		const row = await getApiKeyValue(env.DB, payload.keyId).catch(() => null);
		if (!payload.keyId.startsWith("wallet:")) {
			return new Response(JSON.stringify({ wallet: null, key: row?.key || null }), {
				headers: JSON_NO_STORE,
			});
		}
		const addr = payload.keyId.slice("wallet:".length);
		const stakeMor = await stakeMorFor(env, addr);
		const caps = getProviders().commerce.capsForStake(stakeMor);
		return new Response(
			JSON.stringify({ wallet: addr, stakeMor, caps, key: row?.key || null }),
			{ headers: JSON_NO_STORE },
		);
	}

	// POST /console/wallet/disconnect - the wallet IS the identity, so
	// disconnecting is signing out. The key row (and its caps) stay put for the
	// next connect.
	if (path === "/console/wallet/disconnect" && method === "POST") {
		return new Response(JSON.stringify({ ok: true }), {
			headers: { ...JSON_NO_STORE, "Set-Cookie": clearSessionCookie() },
		});
	}

	return null;
}
