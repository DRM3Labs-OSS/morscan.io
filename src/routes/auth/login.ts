/**
 * Login / logout - key sign-in for returning key holders and SSO identities.
 * The console (wallet connect) is the primary door; /login 302s there.
 */

import type { Env } from "../../types";
import {
	checkRateLimit,
	rateLimitResponse,
	validateKey,
	jwtSecret,
} from "../../utils/auth";
import {
	signJwt,
	sessionCookie,
	clearSessionCookie,
	getSessionToken,
	verifyJwt,
} from "../../utils/jwt";
import { safeRedirect } from "../../providers/compose";

export async function handleLoginRoutes(
	path: string,
	method: string,
	url: URL,
	request: Request,
	env: Env,
): Promise<Response | null> {
	if (path === "/login" && method === "POST") {
		const loginRateCheck = await checkRateLimit(request, env, undefined, 10);
		if (!loginRateCheck.allowed) {
			return rateLimitResponse(loginRateCheck.retryAfter || 60);
		}
		const body = await request.json<{ key: string; return?: string }>().catch(() => null);
		if (!body?.key) {
			return new Response(JSON.stringify({ error: "Missing key" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}
		const auth = await validateKey(body.key, env);
		if (!auth.valid) {
			return new Response(JSON.stringify({ error: auth.error }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (!auth.keyId) {
			return new Response(
				JSON.stringify({ error: "Authenticated key is missing an id" }),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		const token = await signJwt(
			{ keyId: auth.keyId, name: auth.name || auth.keyId },
			jwtSecret(env),
		);
		const returnTo = safeRedirect(body.return);
		return new Response(JSON.stringify({ ok: true, redirect: returnTo }), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Set-Cookie": sessionCookie(token),
				"Cache-Control": "no-store",
			},
		});
	}

	// GET /login - the console IS the sign-in door now (keys only exist via
	// wallet connect). Valid sessions bounce straight to their destination;
	// everyone else lands on /console with the return path preserved.
	if (path === "/login") {
		const token = getSessionToken(request);
		if (token) {
			const payload = await verifyJwt(token, jwtSecret(env));
			if (payload) {
				const returnTo = safeRedirect(url.searchParams.get("return"));
				return new Response(null, {
					status: 302,
					headers: { Location: returnTo, "Cache-Control": "no-store" },
				});
			}
		}
		const ret = url.searchParams.get("return");
		const dest = ret
			? `/console?return=${encodeURIComponent(safeRedirect(ret))}`
			: "/console";
		return new Response(null, {
			status: 302,
			headers: { Location: dest, "Cache-Control": "no-store" },
		});
	}

	// GET /logout - clear session
	if (path === "/logout") {
		return new Response(null, {
			status: 302,
			headers: {
				Location: "/console",
				"Set-Cookie": clearSessionCookie(),
				"Cache-Control": "no-store",
			},
		});
	}

	return null;
}
