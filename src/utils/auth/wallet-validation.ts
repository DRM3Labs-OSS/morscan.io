/**
 * Wallet-signature authentication (EIP-712 dual-auth path).
 *
 * Split out of key-validation.ts to keep both files within the per-file size
 * budget; re-exported from key-validation.ts so the auth barrel is unchanged.
 */

import { getCiWallet, getSignerAttestation } from "../../db/auth";
import type { Env } from "../../types";
import { validateWalletSignature } from "../wallet-auth";
import { type AuthResult, validateApiKey } from "./key-validation";

/**
 * Validate wallet signature auth from request headers.
 *
 * Auth resolution order for wallet-gated endpoints:
 * 1. Try X-Morscan-Key / Authorization: Bearer (existing API key path)
 * 2. If no API key found, try wallet signature headers (EIP-712)
 * 3. If wallet sig valid, return AuthResult with the staking wallet as the identity
 */
export async function validateWalletAuth(
	request: Request,
	env: Env,
): Promise<AuthResult> {
	// Rollback: dual-auth already works (API key tried first, wallet sig second).
	// The D1 config flag 'legacy_key_auth_enabled' is reserved for AFTER the migration
	// deadline, when we'd normally remove the API key path below. Setting it to 'true'
	// re-enables X-Morscan-Key auth post-migration. No behavioral change needed for v1 -
	// the flag would be checked here (post-deadline) by reading
	// "SELECT value FROM config WHERE key = 'legacy_key_auth_enabled'" via a db/
	// helper and accepting the API key when the value is 'true'.

	// Try API key first
	const morscanKey = request.headers.get("X-Morscan-Key");
	const authHeader = request.headers.get("Authorization");

	if (morscanKey || authHeader?.startsWith("Bearer ")) {
		const apiResult = await validateApiKey(request, env);
		if (apiResult.valid) {
			apiResult.authMethod = apiResult.keyId === "demo" ? "demo_key" : "api_key";
		}
		return apiResult;
	}

	// No API key - try wallet signature headers
	const walletHeader = request.headers.get("X-Morscan-Wallet");
	if (!walletHeader) {
		return {
			valid: false,
			error:
				"Missing authentication. Provide X-Morscan-Key header or wallet signature headers.",
		};
	}

	// Read body bytes for bodyHash verification (empty for GET requests)
	let body: Uint8Array | null = null;
	if (request.method !== "GET" && request.method !== "HEAD") {
		try {
			body = new Uint8Array(await request.clone().arrayBuffer());
		} catch {
			body = new Uint8Array(0);
		}
	}

	const result = validateWalletSignature(request, body);
	if (!result.valid) {
		const authResult: AuthResult = { valid: false, error: result.error };
		if (result.serverTime) authResult.serverTime = result.serverTime;
		return authResult;
	}
	const derivedAddress = result.derivedAddress;
	if (!derivedAddress) {
		return { valid: false, error: "Invalid wallet signature: missing derived address" };
	}

	// Attestation check: derived address must be linked to a staking wallet in DB
	let attestation = await getSignerAttestation(env.DB, derivedAddress);

	if (!attestation) {
		if (isLocalDevAuthBypass(request, env)) {
			const stakingWallet =
				request.headers.get("X-Morscan-Staking-Wallet")?.toLowerCase() ||
				walletFromPath(request) ||
				derivedAddress;
			attestation = {
				staking_wallet: isAddress(stakingWallet) ? stakingWallet : derivedAddress,
			};
		} else {
			return { valid: false, error: "attestation_required" };
		}
	}
	const stakingWallet = attestation.staking_wallet;

	// Nonce dedup via Workers KV: defense-in-depth, the 5s timestamp window is the
	// primary gate. TTL 60 is the KV minimum (a smaller expirationTtl is rejected
	// with a 400 and the write never lands); 60s still covers the 5s window plus
	// clock skew and widens the replay guard. The put is awaited so the write has
	// landed before the request is served (closes the same-isolate race), but a
	// KV failure is logged and the request continues: an outage of the dedup
	// store must not fail every SDK request. KV is eventually consistent across
	// isolates, so a cross-isolate replay inside the window is still possible.
	if (env.NONCE_CACHE) {
		const nonceHeader = request.headers.get("X-Morscan-Nonce");
		if (nonceHeader) {
			const nonceKey = `nonce:${nonceHeader}`;
			const existing = await env.NONCE_CACHE.get(nonceKey);
			if (existing) {
				return { valid: false, error: "Nonce already used" };
			}
			try {
				await env.NONCE_CACHE.put(nonceKey, "1", { expirationTtl: 60 });
			} catch (e) {
				console.error(
					"nonce dedup put failed:",
					e instanceof Error ? e.message : String(e),
				);
			}
		}
	}

	// Check if this is a CI wallet (rate limited to free tier)
	const ciWallet = await getCiWallet(env.DB, stakingWallet);

	if (ciWallet) {
		return {
			valid: true,
			walletAuth: true,
			stakingWallet,
			derivedAddress,
			version: result.version,
			keyId: `wallet:${stakingWallet}`,
			name: `CI: ${ciWallet.name}`,
			rateLimit: 60,
			isCiWallet: true,
			authMethod: "wallet_sig",
		};
	}

	// All wallet-auth users get the standard rate limit.
	return {
		valid: true,
		walletAuth: true,
		stakingWallet,
		derivedAddress,
		version: result.version,
		keyId: `wallet:${stakingWallet}`,
		name: `Wallet ${stakingWallet}`,
		rateLimit: 200, // standard wallet rate limit
		authMethod: "wallet_sig",
	};
}

function isLocalDevAuthBypass(request: Request, env: Env): boolean {
	try {
		const hostname = new URL(request.url).hostname.toLowerCase();
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "0.0.0.0" ||
			env.LOCAL_DEV_AUTH_BYPASS === "true" ||
			env.LOCAL_DEV_AUTH_BYPASS === true
		);
	} catch {
		return env.LOCAL_DEV_AUTH_BYPASS === "true" || env.LOCAL_DEV_AUTH_BYPASS === true;
	}
}

function isAddress(value: string | undefined): value is string {
	return /^0x[0-9a-f]{40}$/.test(value || "");
}

function walletFromPath(request: Request): string | undefined {
	try {
		const path = new URL(request.url).pathname.toLowerCase();
		return path.match(/0x[0-9a-f]{40}/)?.[0];
	} catch {
		return undefined;
	}
}
