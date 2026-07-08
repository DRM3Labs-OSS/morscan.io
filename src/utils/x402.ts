/**
 * x402 agent micropayments (https://www.x402.org) - "exact" scheme on Base.
 *
 * Behavior: a request WITHOUT any credential (no X-Morscan-Key, no Bearer, no
 * wallet-signature headers) hitting a METERED /mor/v1 data endpoint gets HTTP
 * 402 Payment Required with a spec-shaped x402 envelope instead of a bare 401.
 * The client retries with an X-PAYMENT header carrying a signed EIP-3009
 * `transferWithAuthorization` payload for USDC on Base. We verify it fully
 * server-side (asset domain, payTo, amount, validity window, nonce-unused, and
 * the EIP-712 signature recovering the payer).
 *
 * Settlement is honest and mode-controlled:
 *  - verify-only (DEFAULT, X402_FACILITATOR_URL unset): the authorization is
 *    cryptographically verified at request time, the response is served, and
 *    the signed authorization is queued in D1 (`x402_payments`, status
 *    'pending') for later batch on-chain settlement. transferWithAuthorization
 *    payloads stay valid within their window and can be broadcast by anyone,
 *    so deferred settlement loses nothing except time. NO on-chain broadcast
 *    happens in this mode (the worker holds no relayer key, by design).
 *  - facilitator (X402_FACILITATOR_URL set): POST the payment to an external
 *    x402 facilitator's /verify + /settle, which broadcasts on-chain and
 *    returns the tx hash.
 *
 * Sending a key that is INVALID stays a plain 401 (bad key != no key). Free
 * endpoints (price, health, capacity) are untouched. The whole feature is OFF
 * unless X402_PAY_TO is configured.
 */

import type { Env } from "../types";
import { countPendingX402ForPayer, insertX402Payment, isX402NonceUsed } from "../db/x402";
// Canonical access doors (import cycle with offers.ts is intentional and safe:
// all cross-references are inside function bodies, nothing at module eval).
import { accessHint, liveAccessDoors } from "../providers/commerce/offers";
// Registry (same intentional function-body-only cycle): the 402 envelope's
// offers menu renders from the ACTIVE provider, so a composed provider's extra
// doors (the pack door) appear in every 402 without touching the spec fields.
import { getProviders } from "../providers";
import { ecrecover, hexToBytes, keccak256 } from "./crypto";
import { CONNECTED_CAPS } from "./stake-tier";

// USDC (native, Circle) on Base mainnet.
export const X402_ASSET_USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN_ID = 8453n; // eip155:8453 (Base)
const NETWORK = "base";
// Circle FiatTokenV2 EIP-712 domain on Base.
const DOMAIN_NAME = "USD Coin";
const DOMAIN_VERSION = "2";
const DEFAULT_PRICE_ATOMIC = 10000n; // 0.01 USDC at 6 decimals
const MAX_TIMEOUT_SECONDS = 60;
/** Abuse guard: max unsettled (pending) authorizations per payer address. */
export const MAX_PENDING_PER_PAYER = 100;

const JSON_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

/** x402 is live only when the operator configured a valid pay-to address. */
export function x402Enabled(env: Env): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(env.X402_PAY_TO || "");
}

/** Per-call price in atomic USDC units (6 decimals). Config: X402_PRICE_USDC. */
export function x402PriceAtomic(env: Env): bigint {
	const usd = Number.parseFloat(env.X402_PRICE_USDC || "");
	if (!Number.isFinite(usd) || usd <= 0) return DEFAULT_PRICE_ATOMIC;
	return BigInt(Math.round(usd * 1e6));
}

/** Human price string for docs ("0.01"). */
export function x402PriceUsdc(env: Env): string {
	return (Number(x402PriceAtomic(env)) / 1e6).toString();
}

/** The single `accepts` entry we advertise (x402 "exact" scheme, Base USDC). */
export function x402Requirements(env: Env, resource: string): Record<string, unknown> {
	return {
		scheme: "exact",
		network: NETWORK,
		maxAmountRequired: x402PriceAtomic(env).toString(),
		resource,
		description: `MorScan metered API call (${x402PriceUsdc(env)} USDC). Alternative: mint a free API key (${CONNECTED_CAPS.burst} req/min) with one wallet signature - see /auth.md`,
		mimeType: "application/json",
		payTo: env.X402_PAY_TO,
		maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
		asset: X402_ASSET_USDC_BASE,
		// EIP-712 domain the client must sign under (per x402 exact/evm scheme).
		extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION },
	};
}

/**
 * Build the 402 Payment Required response: the spec-shaped x402 envelope
 * (x402Version + accepts, untouched for client compatibility) plus ADDITIVE
 * non-spec fields: `offers` is the machine-readable menu of every live access
 * door and `hint` a plain-language pointer. The menu comes from the ACTIVE
 * CommerceProvider's getOffers (reference = the canonical liveAccessDoors),
 * so a composed provider's extra doors appear in every 402 the moment - and
 * only the moment - the provider exposes them. x402 clients ignore unknown
 * top-level fields, so the additions cannot break them.
 */
export async function x402Response(
	env: Env,
	resource: string,
	error?: string,
): Promise<Response> {
	let offers: unknown;
	try {
		offers = await getProviders().commerce.getOffers(env);
	} catch {
		offers = liveAccessDoors(env); // the 402 must render even if a provider fails
	}
	const body: Record<string, unknown> = {
		x402Version: 1,
		accepts: [x402Requirements(env, resource)],
		offers,
		hint: accessHint(env),
	};
	if (error) body.error = error;
	return new Response(JSON.stringify(body), { status: 402, headers: JSON_HEADERS });
}

// ─── X-PAYMENT decoding ───

export interface X402Authorization {
	from: string;
	to: string;
	value: string;
	validAfter: string;
	validBefore: string;
	nonce: string;
}

export interface X402Payment {
	signature: string;
	authorization: X402Authorization;
}

/** Decode the base64 X-PAYMENT header. Returns null when malformed. */
export function decodePaymentHeader(header: string): {
	x402Version?: number;
	scheme?: string;
	network?: string;
	payload?: X402Payment;
} | null {
	try {
		const json = atob(header.trim());
		const parsed = JSON.parse(json) as Record<string, unknown>;
		return parsed as ReturnType<typeof decodePaymentHeader>;
	} catch {
		return null;
	}
}

// ─── EIP-712 / EIP-3009 verification ───

function encUint(v: bigint): Uint8Array {
	const out = new Uint8Array(32);
	let x = v;
	for (let i = 31; i >= 0 && x > 0n; i--) {
		out[i] = Number(x & 0xffn);
		x >>= 8n;
	}
	return out;
}

function encAddress(addr: string): Uint8Array {
	const out = new Uint8Array(32);
	out.set(hexToBytes(addr), 12);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

const enc = new TextEncoder();
const TYPEHASH = keccak256(
	enc.encode(
		"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
	),
);
const DOMAIN_TYPEHASH = keccak256(
	enc.encode(
		"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
	),
);

/** EIP-712 domain separator for USDC on Base. */
function domainSeparator(): Uint8Array {
	return keccak256(
		concat(
			DOMAIN_TYPEHASH,
			keccak256(enc.encode(DOMAIN_NAME)),
			keccak256(enc.encode(DOMAIN_VERSION)),
			encUint(CHAIN_ID),
			encAddress(X402_ASSET_USDC_BASE),
		),
	);
}

/** EIP-712 digest of a TransferWithAuthorization struct. */
export function transferAuthDigest(a: X402Authorization): Uint8Array {
	const structHash = keccak256(
		concat(
			TYPEHASH,
			encAddress(a.from),
			encAddress(a.to),
			encUint(BigInt(a.value)),
			encUint(BigInt(a.validAfter)),
			encUint(BigInt(a.validBefore)),
			hexToBytes(a.nonce),
		),
	);
	return keccak256(concat(new Uint8Array([0x19, 0x01]), domainSeparator(), structHash));
}

export type X402VerifyResult =
	| { ok: true; payment: X402Payment; payer: string }
	| { ok: false; error: string };

/**
 * Full server-side verification of an X-PAYMENT header: envelope shape,
 * scheme/network, payTo, amount, validity window, nonce freshness, per-payer
 * pending cap, and the EIP-712 signature recovering the payer. The signature
 * is bound to USDC-on-Base by the EIP-712 domain (verifyingContract +
 * chainId), so a signature for any other asset or chain cannot verify.
 */
export async function verifyX402Payment(
	env: Env,
	header: string,
): Promise<X402VerifyResult> {
	const decoded = decodePaymentHeader(header);
	if (!decoded || !decoded.payload?.authorization || !decoded.payload.signature) {
		return {
			ok: false,
			error:
				"malformed X-PAYMENT header (expected base64 JSON with payload.signature + payload.authorization)",
		};
	}
	if (decoded.x402Version !== 1)
		return { ok: false, error: "unsupported x402Version (expected 1)" };
	if (decoded.scheme !== "exact")
		return { ok: false, error: "unsupported scheme (expected exact)" };
	if (decoded.network !== NETWORK)
		return { ok: false, error: `unsupported network (expected ${NETWORK})` };

	const p = decoded.payload;
	const a = p.authorization;
	const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s || "");
	if (!isAddr(a.from) || !isAddr(a.to))
		return { ok: false, error: "invalid from/to address" };
	if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce || ""))
		return { ok: false, error: "invalid nonce (expected bytes32 hex)" };

	// payTo must be OUR configured address.
	if (a.to.toLowerCase() !== (env.X402_PAY_TO || "").toLowerCase()) {
		return { ok: false, error: "authorization.to does not match required payTo" };
	}

	// Amount: the exact scheme pays the advertised price.
	let value: bigint;
	try {
		value = BigInt(a.value);
	} catch {
		return { ok: false, error: "invalid value" };
	}
	const price = x402PriceAtomic(env);
	if (value < price) {
		return {
			ok: false,
			error: `insufficient amount: ${value} < required ${price} (atomic USDC units)`,
		};
	}

	// Validity window (unix seconds), with a small grace so the authorization
	// does not expire while the request is in flight.
	const now = BigInt(Math.floor(Date.now() / 1000));
	let validAfter: bigint;
	let validBefore: bigint;
	try {
		validAfter = BigInt(a.validAfter);
		validBefore = BigInt(a.validBefore);
	} catch {
		return { ok: false, error: "invalid validity window" };
	}
	if (now < validAfter)
		return { ok: false, error: "authorization not yet valid (validAfter in the future)" };
	if (now + 6n > validBefore)
		return { ok: false, error: "authorization expired (validBefore too soon)" };

	// EIP-712 signature must recover the payer.
	let recovered: string;
	try {
		recovered = ecrecover(transferAuthDigest(a), p.signature);
	} catch (e) {
		return {
			ok: false,
			error: `signature verification failed: ${e instanceof Error ? e.message : e}`,
		};
	}
	if (recovered.toLowerCase() !== a.from.toLowerCase()) {
		return { ok: false, error: "signature does not recover authorization.from" };
	}
	const payer = a.from.toLowerCase();

	// Nonce must be unused (the D1 unique index closes the check-then-insert race).
	if (await isX402NonceUsed(env.DB, payer, a.nonce.toLowerCase())) {
		return { ok: false, error: "nonce already used" };
	}

	// Abuse guard: cap unsettled authorizations per payer.
	const pending = await countPendingX402ForPayer(env.DB, payer);
	if (pending >= MAX_PENDING_PER_PAYER) {
		return {
			ok: false,
			error: `too many unsettled authorizations for this payer (max ${MAX_PENDING_PER_PAYER}); retry after settlement`,
		};
	}

	return { ok: true, payment: p, payer };
}

// ─── Settlement (accept + record, or facilitator) ───

export interface X402SettleResult {
	ok: boolean;
	error?: string;
	/** Base64 X-PAYMENT-RESPONSE ack header value (set when ok). */
	ackHeader?: string;
}

/**
 * Accept a verified payment. In verify-only mode (default) the signed
 * authorization is stored in D1 (`x402_payments`, status 'pending') for later
 * batch on-chain settlement; nothing is broadcast. In facilitator mode the
 * payment is POSTed to the facilitator's /settle, which broadcasts on-chain.
 * The D1 insert is also the atomic nonce gate (UNIQUE(payer, nonce)).
 */
export async function settleX402Payment(
	env: Env,
	payment: X402Payment,
	payer: string,
	resource: string,
): Promise<X402SettleResult> {
	const a = payment.authorization;
	let txHash = "";
	let status = "pending";

	if (env.X402_FACILITATOR_URL) {
		// Facilitator mode: external verify+settle (broadcasts on-chain).
		try {
			const base = env.X402_FACILITATOR_URL.replace(/\/$/, "");
			const body = JSON.stringify({
				x402Version: 1,
				paymentPayload: {
					x402Version: 1,
					scheme: "exact",
					network: NETWORK,
					payload: payment,
				},
				paymentRequirements: x402Requirements(env, resource),
			});
			const resp = await fetch(`${base}/settle`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			const out = (await resp.json()) as {
				success?: boolean;
				transaction?: string;
				errorReason?: string;
				error?: string;
			};
			if (!resp.ok || !out.success) {
				return {
					ok: false,
					error: `facilitator settle failed: ${out.errorReason || out.error || resp.status}`,
				};
			}
			txHash = out.transaction || "";
			status = "settled";
		} catch (e) {
			return {
				ok: false,
				error: `facilitator unreachable: ${e instanceof Error ? e.message : e}`,
			};
		}
	}

	// Record (and enforce nonce-once atomically via the unique index).
	try {
		await insertX402Payment(env.DB, {
			payer,
			payTo: a.to.toLowerCase(),
			asset: X402_ASSET_USDC_BASE.toLowerCase(),
			amountAtomic: BigInt(a.value).toString(),
			validAfter: Number(a.validAfter),
			validBefore: Number(a.validBefore),
			nonce: a.nonce.toLowerCase(),
			signature: payment.signature,
			authorizationJson: JSON.stringify(a),
			resource,
			status,
			txHash: txHash || null,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("UNIQUE")) return { ok: false, error: "nonce already used" };
		return { ok: false, error: `payment store failed: ${msg}` };
	}

	const ack = {
		success: true,
		network: NETWORK,
		payer,
		// Honest: empty in verify-only mode (no on-chain tx yet; the signed
		// authorization is queued for batch settlement), tx hash in facilitator mode.
		transaction: txHash,
		...(txHash
			? {}
			: { note: "authorization verified and queued for batch on-chain settlement" }),
	};
	return { ok: true, ackHeader: btoa(JSON.stringify(ack)) };
}
