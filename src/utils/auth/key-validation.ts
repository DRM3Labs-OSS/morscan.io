/**
 * API Key Authentication
 *
 * Keys have format: mor_<32 random chars>. A second namespace, mspk_<hex>,
 * is minted by the commerce purchase door (CommerceProvider.purchaseOffer)
 * for prepaid call-pack keys; both are ordinary api_keys rows and validate
 * identically - the prefix gate below only exists to skip DB lookups on
 * obvious garbage.
 */

/** Cheap shape gate before any DB lookup. Accepts both key namespaces. */
function wellFormedKey(key: string): boolean {
	return (key.startsWith("mor_") || key.startsWith("mspk_")) && key.length >= 25;
}

import { getApiKeyByKey, touchApiKeyLastUsed } from "../../db/auth";
import type { Env } from "../../types";

// Wallet-signature auth lives in ./wallet-validation; re-exported so callers
// keep importing it from this module (and the ./auth barrel).
export { validateWalletAuth } from "./wallet-validation";

const _HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

// Constant-time string comparison (prevents timing attacks on key checks)
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const enc = new TextEncoder();
	const bufA = enc.encode(a);
	const bufB = enc.encode(b);
	// crypto.subtle.timingSafeEqual not available in all CF runtimes - manual XOR
	let diff = 0;
	for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
	return diff === 0;
}

// Validate a raw key string (used by POST /login and API auth)
export async function validateKey(key: string, env: Env): Promise<AuthResult> {
	if (!wellFormedKey(key)) {
		return { valid: false, error: "Invalid key format. Expected: mor_<key>" };
	}

	if (env.MORSCAN_DEMO_KEY && timingSafeEqual(key, env.MORSCAN_DEMO_KEY)) {
		return { valid: true, keyId: "demo", name: "Serving Key", rateLimit: 1000000 };
	}

	try {
		const result = await getApiKeyByKey(env.DB, key);

		if (!result) {
			return { valid: false, error: "Invalid API key" };
		}

		// Fire-and-forget: last_used_at is a rough "last seen" timestamp, not an audit log.
		// Not awaited - adding latency to every auth'd request for a non-critical write isn't worth it.
		// If real usage auditing is needed later, use a separate analytics table with batch writes.
		touchApiKeyLastUsed(env.DB, Date.now(), result.id);

		return {
			valid: true,
			keyId: result.id,
			name: result.name,
			rateLimit: result.rate_limit,
		};
	} catch (e) {
		console.error("Key validation error:", e);
		return { valid: false, error: "Key validation failed" };
	}
}

export interface AuthResult {
	valid: boolean;
	keyId?: string;
	name?: string;
	rateLimit?: number;
	error?: string;
	// Wallet auth fields (set when auth is via EIP-712 signature, not API key)
	walletAuth?: boolean;
	stakingWallet?: string;
	derivedAddress?: string;
	version?: string;
	/** Server time - included in error responses for clock skew detection */
	serverTime?: number;
	/** CI wallet - rate limited to free tier */
	isCiWallet?: boolean;
	/** Auth method used - for migration tracking and telemetry */
	authMethod?: "wallet_sig" | "api_key" | "demo_key";
}

/**
 * Admin-auth gate used for internal paths (/sync/*, /mor/v1/bq/*, workers.dev).
 *
 * The `admin` api_keys row is the operator kill-switch key and the default
 * admin identity. This helper centralizes the check so future identities
 * (e.g. MORSCAN_ADMIN_KEY_IDS wrangler var, per-operator keys) can be added
 * in one place without hunting through index.ts.
 *
 * Current behavior: accepts `admin` OR a keyId listed in the
 * `MORSCAN_ADMIN_KEY_IDS` var (comma-separated). Forward-compatible; today
 * only `admin` is configured.
 */
export function isAdminAuth(auth: AuthResult, env: Env): boolean {
	if (!auth.valid) return false;
	if (auth.keyId === "admin") return true;
	const extra = (env as unknown as { MORSCAN_ADMIN_KEY_IDS?: string })
		.MORSCAN_ADMIN_KEY_IDS;
	if (!extra) return false;
	const allowed = extra
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return allowed.includes(auth.keyId || "");
}

/**
 * Validate API key from request
 * Checks X-Morscan-Key header or Authorization: Bearer header
 */
export async function validateApiKey(request: Request, env: Env): Promise<AuthResult> {
	const morscanKey = request.headers.get("X-Morscan-Key");
	const authHeader = request.headers.get("Authorization");

	let apiKey: string | null = null;

	if (morscanKey) {
		apiKey = morscanKey;
	} else if (authHeader?.startsWith("Bearer ")) {
		apiKey = authHeader.slice(7);
	}

	if (!apiKey) {
		return { valid: false, error: "Missing API key. Use X-Morscan-Key header." };
	}

	// Check format (mor_ or mspk_ namespace; see the module header)
	if (!wellFormedKey(apiKey)) {
		return { valid: false, error: "Invalid key format. Expected: mor_<key>" };
	}

	// Check the UI serving key first (no DB lookup needed, timing-safe).
	// High per-key aggregate (every page script on the site shares it), but the
	// per-IP layer in checkRateLimit still applies - see rate-limit.ts.
	if (env.MORSCAN_DEMO_KEY && timingSafeEqual(apiKey, env.MORSCAN_DEMO_KEY)) {
		return {
			valid: true,
			keyId: "demo",
			name: "Serving Key",
			rateLimit: 1000000,
		};
	}

	// Look up in DB
	try {
		const result = await getApiKeyByKey(env.DB, apiKey);

		if (!result) {
			return { valid: false, error: "Invalid API key" };
		}

		// Fire-and-forget: rough "last seen" timestamp (see validateKey for rationale)
		touchApiKeyLastUsed(env.DB, Date.now(), result.id);

		return {
			valid: true,
			keyId: result.id,
			name: result.name,
			rateLimit: result.rate_limit,
		};
	} catch (e) {
		console.error("API key lookup error:", e);
		return { valid: false, error: "Key validation failed" };
	}
}

/**
 * Generate a new API key using rejection sampling (no modulo bias).
 */
export function generateApiKey(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars
	const limit = 252; // largest multiple of 36 that fits in a byte (252 = 36 * 7)
	let key = "mor_";
	while (key.length < 36) {
		// mor_ (4) + 32 random chars
		const buf = new Uint8Array(1);
		crypto.getRandomValues(buf);
		if (buf[0] < limit) key += chars[buf[0] % 36];
	}
	return key;
}
