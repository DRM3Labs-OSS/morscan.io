/**
 * VENDORED: @drm3/sdk/sso at v0.6.0 (source commit
 * d4447b2209f2facf290c815b75a545ddf0d8d845): src/sso/jwt.ts (verifySsoToken, mintSsoToken,
 * audienceOf), src/sso/launch.ts (verifyLaunchToken) and src/sso/revocation.ts
 * (parseRevocationFeed, createRevocationGate, mintRevocationProof, verifyActiveSsoToken),
 * joined into one file and
 * formatted to this repo's style. Logic unchanged.
 *
 * Vendored rather than a dependency so a fresh clone of this repo builds with no private
 * dependency. Re-sync: copy those three files from the SDK at the new tag, keep only the exports
 * below, update the tag and SHA in this header, run `npm run test:unit`, one commit.
 */

// ── Token core (src/sso/jwt.ts) ──

export interface SsoClaims {
	sub: string;
	email?: string;
	name?: string;
	apps?: string[];
	handle?: string;
	/** Who minted it (the hub). A verifier that passes `iss` pins it. */
	iss?: string;
	/** Which app(s) the token is addressed to. A token that names an audience verifies ONLY at a
	 *  verifier that states a matching one (RFC 7519 section 4.1.3). */
	aud?: string | string[];
	iat: number;
	exp: number;
}

/** What a verifier requires of a token beyond signature + expiry. */
export interface VerifySsoOptions {
	/** The audience this verifier is: the token's `aud` must include it. */
	aud?: string;
	/** The issuer to pin: the token's `iss` must equal it. */
	iss?: string;
	/** Fail closed when the token carries no `aud` at all. */
	requireAud?: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlBytes(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
	return b64urlBytes(enc.encode(s));
}
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

/** Mint a signed token. Default TTL 15 minutes. `aud` and `iss` are covered by the HMAC. */
export async function mintSsoToken(
	secret: string,
	claims: {
		sub: string;
		email?: string;
		name?: string;
		apps?: string[];
		handle?: string;
		iss?: string;
		aud?: string | string[];
	},
	ttlSec = 900,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const payload: SsoClaims = { ...claims, iat: now, exp: now + ttlSec };
	const data = `${b64urlStr(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64urlStr(JSON.stringify(payload))}`;
	const sig = new Uint8Array(
		await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(data)),
	);
	return `${data}.${b64urlBytes(sig)}`;
}

/** The audience(s) a token names, or null when it names none. */
export function audienceOf(claims: Pick<SsoClaims, "aud">): string[] | null {
	if (typeof claims.aud === "string") return claims.aud ? [claims.aud] : null;
	if (Array.isArray(claims.aud))
		return claims.aud.length ? claims.aud.filter((a) => typeof a === "string") : null;
	return null;
}

/**
 * Verify a token's signature + expiry, then its audience and issuer. Returns the claims or null.
 * Never throws. Only `alg: HS256` is accepted. A token that carries `aud` is admitted only where
 * `opts.aud` is one of those values; with `requireAud` a token without one is refused.
 */
export async function verifySsoToken(
	secret: string,
	token: string,
	opts: VerifySsoOptions = {},
): Promise<SsoClaims | null> {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const header = JSON.parse(dec.decode(b64urlDecode(parts[0]))) as { alg?: unknown };
		if (header?.alg !== "HS256") return null;
		const data = `${parts[0]}.${parts[1]}`;
		const ok = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(secret, ["verify"]),
			b64urlDecode(parts[2]) as BufferSource,
			enc.encode(data),
		);
		if (!ok) return null;
		const claims = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as SsoClaims;
		if (
			!claims.sub ||
			typeof claims.exp !== "number" ||
			claims.exp < Math.floor(Date.now() / 1000)
		)
			return null;
		if (opts.iss !== undefined && claims.iss !== opts.iss) return null;
		const aud = audienceOf(claims);
		if (aud) {
			if (!opts.aud || !aud.includes(opts.aud)) return null;
		} else if (opts.requireAud) return null;
		return claims;
	} catch {
		return null;
	}
}

// ── Launch token (src/sso/launch.ts) ──

export interface LaunchClaims {
	sub: string;
	email?: string;
	name?: string;
	app: string; // the EXACT app this token is valid for (audience binding)
	jti: string; // single-use id; the consuming app keeps its own seen-set
	iat: number;
	exp: number;
}

/**
 * Verify a launch token with THIS app's derived key: signature under `appKey`, unexpired, and its
 * `app` claim equals `appId`. Does NOT enforce single use; the app keeps its own jti seen-set.
 * Never throws.
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

// ── Revocation feed (src/sso/revocation.ts) ──
// Offline verification cannot see a ban that happened AFTER a token was minted. The hub publishes
// the revoked subjects; the gate caches the list per `ttlMs` (one small fetch per isolate per
// window, an O(1) lookup per request). FAIL-OPEN by design: when the feed is unreachable it keeps
// the last list it read, or an empty one, so an outage never locks every user out.
//
// TWO KINDS OF ENTRY (0.6.0). A BAN refuses every token for the subject. A CUTOFF ({ sub, before })
// refuses only the tokens issued before `before` (unix seconds): a password reset or a "sign out
// everywhere" ends the tokens already minted, and the fresh sign-in after it (issued at or after
// `before`) is honoured. Cutoffs travel in their own field, `cutoffs`, which a 0.5.x gate never
// reads. This gate reads both fields and both shapes, so it also reads an old feed.

/** One feed entry. No `before` is a ban; a numeric `before` is a cutoff. */
export interface RevocationEntry {
	sub: string;
	/** unix seconds: a token for `sub` whose `iat` is below this is refused. Absent = always refused. */
	before?: number;
}

export interface RevocationFeed {
	/** Banned subjects (user.id = sub). Plain strings; a 0.6.0 gate also accepts RevocationEntry here. */
	revoked: Array<string | RevocationEntry>;
	/** Cutoffs (0.6.0). Ignored by 0.5.x gates. An entry here without `before` is read as a ban. */
	cutoffs?: RevocationEntry[];
	/** unix seconds the hub computed this list (informational). */
	asOf: number;
}

/** What the gate holds for one subject: Infinity = banned, a number = the cutoff. */
type Table = Map<string, number>;

/** Parse either feed shape into one table. Junk entries are skipped, never thrown on. A ban beats
 *  a cutoff; of two cutoffs the later one wins. Pure. */
export function parseRevocationFeed(data: unknown): Table {
	const table: Table = new Map();
	const put = (e: unknown) => {
		const sub =
			typeof e === "string"
				? e
				: e && typeof e === "object"
					? (e as RevocationEntry).sub
					: undefined;
		if (typeof sub !== "string" || !sub) return;
		const before = typeof e === "object" && e ? (e as RevocationEntry).before : undefined;
		// No `before` is a ban. A `before` that is not a finite number is a malformed cutoff:
		// skipped, like any junk entry (a bad cutoff must not become a ban of fresh sign-ins).
		if (before !== undefined && !(typeof before === "number" && Number.isFinite(before)))
			return;
		const limit = before ?? Number.POSITIVE_INFINITY;
		if (limit > (table.get(sub) ?? Number.NEGATIVE_INFINITY)) table.set(sub, limit);
	};
	const d = (data || {}) as Partial<RevocationFeed>;
	if (Array.isArray(d.revoked)) for (const e of d.revoked) put(e);
	if (Array.isArray(d.cutoffs)) for (const e of d.cutoffs) put(e);
	return table;
}

/** The audience an app's revocation-feed proof is addressed to. Nothing else accepts it. */
export const REVOCATION_PROOF_AUD = "drm3.network/api/sso/revocations";

/** The proof an app sends with its feed read: a short-lived token signed with the app's OWN
 *  derived key, `sub: "app:<app>"`, `iss: <app>`, `aud: REVOCATION_PROOF_AUD`. */
export async function mintRevocationProof(
	app: string,
	appKey: string,
	ttlSec = 120,
): Promise<string> {
	return mintSsoToken(
		appKey,
		{ sub: `app:${app}`, iss: app, aud: REVOCATION_PROOF_AUD },
		ttlSec,
	);
}

export interface RevocationGate {
	/** True iff a token for `sub` issued at `iat` (unix seconds) is revoked: the subject is banned,
	 *  or it has a cutoff and `iat` is below it. Without `iat` only a ban counts (a cutoff cannot be
	 *  judged without the issue time), so pass the token's `iat`. Refreshes the list when stale. */
	isRevoked(sub: string, iat?: number): Promise<boolean>;
}

/** Build a cached gate over the hub's revocation feed. */
export function createRevocationGate(opts: {
	url: string;
	ttlMs?: number; // cache window; default 60s
	timeoutMs?: number; // per-fetch timeout; default 3s
	fetchImpl?: typeof fetch; // injectable for tests
	now?: () => number; // injectable clock for tests
	/** This app's id, as the hub knows it. Set with `appKey` to prove the read. */
	app?: string;
	/** This app's derived key. With `app`, every feed fetch carries `X-DRM3-App` and a Bearer proof. */
	appKey?: string;
}): RevocationGate {
	const ttlMs = opts.ttlMs ?? 60_000;
	const timeoutMs = opts.timeoutMs ?? 3_000;
	const doFetch = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	let cache: Table | null = null;
	let fetchedAt = 0;
	let inflight: Promise<void> | null = null;

	async function refresh(): Promise<void> {
		try {
			const headers: Record<string, string> = {};
			if (opts.app && opts.appKey) {
				headers["X-DRM3-App"] = opts.app;
				headers.Authorization = `Bearer ${await mintRevocationProof(opts.app, opts.appKey)}`;
			}
			const res = await doFetch(opts.url, {
				signal: AbortSignal.timeout(timeoutMs),
				headers,
			});
			if (!res.ok) throw new Error(`revocation feed ${res.status}`);
			cache = parseRevocationFeed(await res.json());
		} catch {
			// Fail-open: keep the last-known table; if we never had one, nothing is revoked.
			if (cache === null) cache = new Map();
		} finally {
			fetchedAt = now();
		}
	}

	return {
		async isRevoked(sub: string, iat?: number): Promise<boolean> {
			if (cache === null || now() - fetchedAt >= ttlMs) {
				if (!inflight)
					inflight = refresh().finally(() => {
						inflight = null;
					});
				await inflight;
			}
			const limit = cache?.get(sub);
			if (limit === undefined) return false;
			if (limit === Number.POSITIVE_INFINITY) return true;
			return typeof iat === "number" && iat < limit;
		},
	};
}

/** Verify a token AND confirm it is not revoked (subject banned, or issued before its cutoff).
 *  Returns claims or null. Never throws. */
export async function verifyActiveSsoToken(
	secret: string,
	token: string,
	gate: RevocationGate,
	opts: VerifySsoOptions = {},
): Promise<SsoClaims | null> {
	const claims = await verifySsoToken(secret, token, opts);
	if (!claims) return null;
	if (await gate.isRevoked(claims.sub, claims.iat)) return null;
	return claims;
}
