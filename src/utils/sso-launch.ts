/**
 * Identity-provider launch-token verification (the registered tier's front door).
 *
 * Protocol (DRM3 net-sso launch handshake, portable to any IdP that implements it):
 * the hub mints a SHORT-lived (~60s), audience-bound, single-use HS256 JWT signed
 * with THIS app's derived key, then 302s the browser to /sso/callback?token=...
 * The app verifies offline with only its own key (SSO_APP_KEY) and sets its own
 * host-scoped session. A token is valid at exactly one app; no app can replay or
 * forge a token for another.
 *
 * The token must name this app twice: `app` (the launch protocol) and `aud` (RFC
 * 7519), and its `iss` must be the hub. A token that names another audience, no
 * audience, or another issuer is refused. Its subject is then checked against the
 * hub's revocation feed (utils/sso-revocation.ts), so a banned account gets no
 * session. The verifiers are vendored from the SDK (src/vendor/drm3-sdk-sso.ts).
 * Configure via SSO_APP_KEY + SSO_APP_ID + SSO_HUB_URL (+ SSO_ISSUER to override
 * the hub host as the issuer); leave SSO_APP_KEY unset to disable IdP sign-in.
 */

import type { Env } from "../types";
import {
	type LaunchClaims,
	type RevocationGate,
	verifyActiveSsoToken,
	verifyLaunchToken,
} from "../vendor/drm3-sdk-sso";

export type { LaunchClaims };

/** The issuer a launch token must name: SSO_ISSUER, else the host of SSO_HUB_URL. */
export function ssoIssuer(env: Env): string | null {
	if (env.SSO_ISSUER) return env.SSO_ISSUER;
	if (!env.SSO_HUB_URL) return null;
	try {
		return new URL(env.SSO_HUB_URL).hostname || null;
	} catch {
		return null;
	}
}

/**
 * Verify a launch token: signature under this app's key, unexpired, `app` and `aud`
 * both equal to `appId`, `iss` equal to `issuer`, and a subject the revocation gate
 * does not list. Returns the claims or null. Never throws.
 */
export async function verifyActiveLaunchToken(
	appKey: string,
	token: string,
	appId: string,
	issuer: string | null,
	gate: RevocationGate,
): Promise<LaunchClaims | null> {
	try {
		if (!issuer) return null;
		const launch = await verifyLaunchToken(appKey, token, appId);
		if (!launch) return null;
		const active = await verifyActiveSsoToken(appKey, token, gate, {
			aud: appId,
			iss: issuer,
			requireAud: true,
		});
		if (!active || active.sub !== launch.sub) return null;
		return launch;
	} catch {
		return null;
	}
}
