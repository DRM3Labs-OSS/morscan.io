/**
 * SSO route - the per-app IdP launch handshake.
 */

import type { Env } from "../../types";
import { verifyLaunchToken } from "../../utils/sso-launch";
import { jwtSecret } from "../../utils/auth";
import { signJwt, sessionCookie } from "../../utils/jwt";

export async function handleSsoRoutes(
	path: string,
	method: string,
	url: URL,
	_request: Request,
	env: Env,
): Promise<Response | null> {
	// GET /sso/callback - the per-app IdP launch handshake. The hub 302s here
	// with a short-lived, audience-bound, single-use token signed with THIS
	// app's derived key (SSO_APP_KEY). Verify failure must NOT bounce back into
	// the launch flow (that loops) - send to the plain sign-in instead.
	if (path === "/sso/callback" && method === "GET") {
		const token = url.searchParams.get("token") || "";
		const next = url.searchParams.get("next") || "/console";
		const appKey = env.SSO_APP_KEY;
		const appId = env.SSO_APP_ID || "morscan";
		// No hub configured -> fall back to the local console instead of an IdP.
		const signInUrl = env.SSO_HUB_URL ? `${env.SSO_HUB_URL}/account?login` : "/console";
		const toSignIn = () =>
			new Response(null, {
				status: 302,
				headers: { Location: signInUrl, "Cache-Control": "no-store" },
			});
		if (!appKey || !token) return toSignIn();
		const claims = await verifyLaunchToken(appKey, token, appId);
		if (!claims) return toSignIn();
		// Single-use: reject a replayed jti within its lifetime (KV seen-set, TTL
		// safely past the 60s token life). If KV is unavailable, the tight TTL and
		// one-time URL remain the guard.
		if (env.NONCE_CACHE) {
			const seenKey = `sso_jti:${claims.jti}`;
			if (await env.NONCE_CACHE.get(seenKey)) return toSignIn();
			await env.NONCE_CACHE.put(seenKey, "1", { expirationTtl: 120 });
		}
		let dest = "/console";
		try {
			const n = new URL(next, url.origin);
			if (n.hostname === url.hostname) dest = n.pathname + n.search;
		} catch {}
		const session = await signJwt(
			{ keyId: `user:${claims.sub}`, name: claims.name || claims.email || "Account" },
			jwtSecret(env),
		);
		return new Response(null, {
			status: 302,
			headers: {
				Location: dest,
				"Set-Cookie": sessionCookie(session),
				"Cache-Control": "no-store",
			},
		});
	}

	return null;
}
