/**
 * Wallet front door - the primary way in. Connect a wallet, prove ownership by
 * personal_sign of an EIP-4361 (Sign-In with Ethereum) message, get a session
 * AND a free bottom-tier API key.
 *   GET  /console/wallet/challenge?wallet=0x.. - mint a single-use, host- and
 *                                    wallet-bound message to sign
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
import {
	JSON_NO_STORE,
	WALLET_CHALLENGE_TTL_SECS,
	type WalletChallenge,
	walletChallengeMessage,
	shortAddr,
} from "./helpers";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** What the KV row behind a nonce holds (short keys: the row is tiny and hot). */
interface StoredChallenge {
	w: string; // wallet (lowercase)
	d: string; // domain (the minting request's host)
	u: string; // uri
	t: string; // issuedAt (ISO 8601)
}

function parseStoredChallenge(raw: string | null): StoredChallenge | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as Partial<StoredChallenge>;
		if (
			typeof v.w === "string" &&
			typeof v.d === "string" &&
			typeof v.u === "string" &&
			typeof v.t === "string"
		)
			return v as StoredChallenge;
	} catch {
		// A pre-2.50.9 row ("1") or anything else unreadable: treat as expired.
	}
	return null;
}

export async function handleWalletRoutes(
	path: string,
	method: string,
	url: URL,
	request: Request,
	env: Env,
): Promise<Response | null> {
	// GET /console/wallet/challenge?wallet=0x.. - the wallet front door, step 1.
	// NOT session-gated: the wallet IS the login. Mints a single-use nonce (KV,
	// 5 min TTL) bound to THIS host and THAT wallet, and returns the exact
	// EIP-4361 message the wallet must personal_sign. The wallet is required up
	// front because the message names it: that is what lets a wallet app parse
	// the message as a sign-in request and warn when the asking site is not
	// this host.
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
		const wallet = (url.searchParams.get("wallet") || "").trim();
		if (!ADDRESS_RE.test(wallet)) {
			return new Response(
				JSON.stringify({
					error:
						"Expected ?wallet=0x<40 hex chars>. The challenge is minted for one wallet on this host; sign the returned message with that wallet.",
				}),
				{ status: 400, headers: JSON_NO_STORE },
			);
		}
		const challenge: WalletChallenge = {
			domain: url.host,
			uri: `${url.origin}/console`,
			address: wallet.toLowerCase(),
			nonce: crypto.randomUUID().replace(/-/g, ""),
			issuedAt: new Date().toISOString(),
		};
		const stored: StoredChallenge = {
			w: challenge.address,
			d: challenge.domain,
			u: challenge.uri,
			t: challenge.issuedAt,
		};
		await env.NONCE_CACHE.put(`wchal:${challenge.nonce}`, JSON.stringify(stored), {
			expirationTtl: WALLET_CHALLENGE_TTL_SECS,
		});
		return new Response(
			JSON.stringify({
				nonce: challenge.nonce,
				message: walletChallengeMessage(challenge),
				wallet: challenge.address,
				domain: challenge.domain,
				issuedAt: challenge.issuedAt,
				expiresInSeconds: WALLET_CHALLENGE_TTL_SECS,
			}),
			{ headers: JSON_NO_STORE },
		);
	}

	// POST /console/wallet/verify - the wallet front door, step 2. Rebuilds the
	// EIP-4361 message from what the mint stored (host, wallet, nonce, time),
	// recovers its EIP-191 personal_sign signer, and on match CREATES the
	// session (keyId wallet:<addr>) and auto-issues the bottom-tier API key row
	// if absent (60/min, 2,000/day, 40,000/month; stake MOR to raise it). A
	// signature over any other text, or one minted for another wallet or
	// another host, recovers to the wrong address or is refused outright.
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
		if (!ADDRESS_RE.test(wallet) || !signature || !/^[0-9a-f]{32}$/.test(nonce)) {
			return new Response(
				JSON.stringify({ error: "Expected { wallet, signature, nonce }" }),
				{ status: 400, headers: JSON_NO_STORE },
			);
		}
		const stored = parseStoredChallenge(await env.NONCE_CACHE.get(`wchal:${nonce}`));
		if (!stored) {
			return new Response(
				JSON.stringify({
					error: "Challenge expired or already used. Request a new one.",
				}),
				{ status: 400, headers: JSON_NO_STORE },
			);
		}
		await env.NONCE_CACHE.delete(`wchal:${nonce}`); // single-use
		const addr = wallet.toLowerCase();
		if (stored.w !== addr) {
			return new Response(
				JSON.stringify({
					error: "Challenge was minted for a different wallet. Request a new one.",
				}),
				{ status: 401, headers: JSON_NO_STORE },
			);
		}
		if (stored.d !== url.host) {
			return new Response(
				JSON.stringify({
					error: "Challenge was minted for a different host. Request a new one.",
				}),
				{ status: 401, headers: JSON_NO_STORE },
			);
		}
		const message = walletChallengeMessage({
			domain: stored.d,
			uri: stored.u,
			address: stored.w,
			nonce,
			issuedAt: stored.t,
		});
		let recovered = "";
		try {
			recovered = ecrecover(eip191Digest(message), signature);
		} catch (e) {
			return new Response(
				JSON.stringify({
					error: `Signature verification failed: ${e instanceof Error ? e.message : e}`,
				}),
				{ status: 401, headers: JSON_NO_STORE },
			);
		}
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
