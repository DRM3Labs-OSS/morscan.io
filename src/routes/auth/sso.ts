/**
 * SSO route - the per-app IdP launch handshake.
 */

import type { Env } from "../../types";
import { verifyLaunchToken } from "../../utils/sso-launch";
import { claimSsoJti } from "../../db/auth";
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
		// Single-use: the jti is claimed atomically in D1 (INSERT OR IGNORE on
		// its primary key). A replay, from any PoP or racing the first use, gets
		// no session; a D1 failure also gets none (fail closed).
		if (
			typeof claims.jti !== "string" ||
			!(await claimSsoJti(env.DB, claims.jti, claims.exp))
		) {
			return toSignIn();
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
