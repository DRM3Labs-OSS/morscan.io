/**
 * Auth Routes - thin dispatcher over the cohesive auth sub-modules.
 *
 * The wallet front door (/console/wallet/challenge + /console/wallet/verify) is
 * the primary way in: connect a wallet, get a session AND a free bottom-tier
 * API key. The pieces live in ./auth/:
 *   sso.ts     - GET /sso/callback (per-app IdP launch handshake)
 *   wallet.ts  - /console/wallet/{challenge,verify,status,disconnect}
 *   console.ts - GET /console + POST /console/key[/revoke]
 *   login.ts   - POST/GET /login, GET /logout
 */

import type { Env } from "../types";
import { handleSsoRoutes } from "./auth/sso";
import { handleWalletRoutes } from "./auth/wallet";
import { handleConsoleRoutes } from "./auth/console";
import { handleLoginRoutes } from "./auth/login";

export async function handleAuthRoutes(
	path: string,
	method: string,
	url: URL,
	request: Request,
	env: Env,
): Promise<Response | null> {
	// Order matters only for readability; the path/method guards are disjoint.
	// Wallet routes are checked before console so /console/wallet/* never falls
	// through to the /console page handler.
	return (
		(await handleSsoRoutes(path, method, url, request, env)) ??
		(await handleWalletRoutes(path, method, url, request, env)) ??
		(await handleConsoleRoutes(path, method, url, request, env)) ??
		(await handleLoginRoutes(path, method, url, request, env))
	);
}
