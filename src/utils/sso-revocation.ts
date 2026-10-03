/**
 * The hub's revocation feed as a cached gate, one per isolate.
 *
 * A launch token lives a minute, but the session MorScan sets from it lives a day.
 * The hub lists banned accounts at <SSO_HUB_URL>/api/sso/revocations; this gate
 * reads that list (cached REVOCATION_TTL_MS), and both the launch verify and every
 * read of an IdP (`user:`) session ask it. A banned account is refused inside the
 * cache window instead of at its session's expiry. A cutoff (a password reset or a
 * "sign out everywhere" on the hub) refuses only what was issued before it: the
 * launch token's `iat` at the callback, the session's `iat` on every read. The
 * fresh sign-in after the cutoff is admitted.
 *
 * Every read proves this app to the hub: `X-DRM3-App: <SSO_APP_ID>` and a short
 * Bearer proof signed with SSO_APP_KEY (the key never leaves the worker).
 *
 * FAILS OPEN when the feed cannot be read: the gate keeps the last list it read,
 * or an empty one, so a hub outage never signs every user out. A non-200 answer
 * is logged, because a refused proof also fails open.
 */

import type { Env } from "../types";
import { createRevocationGate, type RevocationGate } from "../vendor/drm3-sdk-sso";

export const REVOCATION_TTL_MS = 30_000;
const NOTHING_REVOKED: RevocationGate = { isRevoked: async () => false };

let memo: { url: string; app: string; appKey: string; gate: RevocationGate } | null =
	null;

/** The gate for this env, or a gate that revokes nothing when no hub is configured. */
export function revocationGate(env: Env): RevocationGate {
	const appKey = env.SSO_APP_KEY || "";
	if (!env.SSO_HUB_URL || !appKey) return NOTHING_REVOKED;
	const url = `${env.SSO_HUB_URL.replace(/\/+$/, "")}/api/sso/revocations`;
	const app = env.SSO_APP_ID || "morscan";
	if (!memo || memo.url !== url || memo.app !== app || memo.appKey !== appKey) {
		const gate = createRevocationGate({
			url,
			app,
			appKey,
			ttlMs: REVOCATION_TTL_MS,
			timeoutMs: 2_000,
			// Read the global at call time (tests stub it) and log a refusal.
			fetchImpl: async (input, init) => {
				const res = await fetch(input, init);
				if (!res.ok) console.warn("[revocations] feed answered", res.status);
				return res;
			},
		});
		memo = { url, app, appKey, gate };
	}
	return memo.gate;
}

/**
 * True iff a session keyId names an IdP account the hub has revoked: banned, or
 * with a cutoff later than `iat` (the session's issue time, unix seconds).
 */
export async function sessionRevoked(
	env: Env,
	keyId: string,
	iat: number,
): Promise<boolean> {
	if (!keyId.startsWith("user:")) return false;
	try {
		return await revocationGate(env).isRevoked(keyId.slice("user:".length), iat);
	} catch {
		return false;
	}
}

/** Drop the cached gate (tests). */
export function resetRevocationGate(): void {
	memo = null;
}
