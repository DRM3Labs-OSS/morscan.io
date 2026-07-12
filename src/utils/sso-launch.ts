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
 * Ported from @drm3/sdk/sso (verifyLaunchToken); self-contained so a fresh clone
 * builds with no private deps. Configure via SSO_APP_KEY + SSO_APP_ID +
 * SSO_LAUNCH_URL; leave unset to disable the IdP sign-in path entirely.
 */

export interface LaunchClaims {
	sub: string; // IdP user id
	email?: string;
	name?: string;
	app: string; // the EXACT app this token is valid for (audience binding)
	jti: string; // single-use id
	iat: number;
	exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlDecode(s: string): Uint8Array {
	let t = s.replace(/-/g, "+").replace(/_/g, "/");
	while (t.length % 4) t += "=";
	const bin = atob(t);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function hmacKey(secret: string, usage: ("sign" | "verify")[]): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		usage,
	);
}

/**
 * Verify a launch token with this app's derived key. Returns the claims only if
 * the signature is valid, the token is unexpired, and its `app` claim equals
 * `appId`. Never throws.
 */
export async function verifyLaunchToken(
	appKey: string,
	token: string,
	appId: string,
): Promise<LaunchClaims | null> {
	try {
		if (!appId) return null;
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const data = `${parts[0]}.${parts[1]}`;
		const valid = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(appKey, ["verify"]),
			b64urlDecode(parts[2]) as BufferSource,
			enc.encode(data),
		);
		if (!valid) return null;
		const claims = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as LaunchClaims;
		if (!claims.sub || !claims.app || !claims.jti || !claims.exp) return null;
		if (claims.app !== appId) return null;
		if (claims.exp < Math.floor(Date.now() / 1000)) return null;
		return claims;
	} catch {
		return null;
	}
}
