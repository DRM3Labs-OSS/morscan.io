/**
 * UI session/JWT helpers for MorScan dashboard auth.
 */

import type { Env } from "../../types";
import { baseUrl } from "../../config";
import { verifyJwt, getSessionToken } from "../jwt";

const HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

// Dedicated UI-session signing secret - MUST be configured via wrangler secret.
// Deliberately NOT derived from MORSCAN_MNEMONIC: that mnemonic is the BIP39 seed
// for the published provenance keys (morscan/cache, morscan/signer). Coupling the
// two would mean one secret protects both user auth and the certification key.
// MORSCAN_JWT_SECRET is independent high-entropy random (openssl rand -hex 32) and
// can be rotated to invalidate all sessions without touching the signing identity.
export function jwtSecret(env: Env): string {
	if (!env.MORSCAN_JWT_SECRET) {
		throw new Error(
			"MORSCAN_JWT_SECRET not configured. Set it with: openssl rand -hex 32 | wrangler secret put MORSCAN_JWT_SECRET",
		);
	}
	return env.MORSCAN_JWT_SECRET;
}

// Check JWT session cookie for UI routes
export async function requireUiAuth(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const token = getSessionToken(request);
	if (token) {
		const payload = await verifyJwt(token, jwtSecret(env));
		if (payload) return null;
	}
	const url = new URL(request.url);
	const returnTo = encodeURIComponent(url.pathname + url.search);
	return new Response(null, {
		status: 302,
		headers: { Location: `/console?return=${returnTo}`, "Cache-Control": "no-store" },
	});
}

/**
 * Return 401 Unauthorized response
 */
export function unauthorizedResponse(error: string): Response {
	return new Response(JSON.stringify({ error, hint: `Get a key at ${baseUrl()}` }), {
		status: 401,
		headers: HEADERS,
	});
}

/** Verified session payload, or null. For pages that render identity. */
export async function sessionPayload(
	request: Request,
	env: Env,
): Promise<{ keyId: string; name?: string } | null> {
	const token = getSessionToken(request);
	if (!token) return null;
	const payload = await verifyJwt(token, jwtSecret(env));
	return payload ? { keyId: payload.keyId, name: payload.name } : null;
}
