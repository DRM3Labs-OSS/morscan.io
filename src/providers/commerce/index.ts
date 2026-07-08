/**
 * CommerceProvider - the open-core seam for offers + payments + capacity.
 *
 * This is the future home of MorScan's offer/pricing engine and x402
 * settlement. The interface is deliberately forward-looking so a PRIVATE
 * payments provider can implement a real offer catalog and on-chain settlement
 * and be injected at src/providers/index.ts, while the bundled REFERENCE impl
 * below reproduces TODAY's behavior EXACTLY:
 *
 *   - caps: the free connected-wallet tier + stake-indexed caps (capsForStake).
 *   - capacity: the free /mor/v1/capacity readout.
 *   - payments: x402 in VERIFY-ONLY mode (verify + queue in D1, no settlement).
 *   - offers: the LIVE access doors (free key / stake / x402 per-call) from
 *     the canonical definition in ./offers.ts - the single source every public
 *     surface renders from.
 *
 * The methods that do not exist yet (real on-chain settlement, a call-balance
 * ledger) are stubbed to today's behavior, NOT invented. Precedent: Sentry's
 * getsentry, Grafana OSS + Enterprise plugins.
 */

import type { Env } from "../../types";
import type { AuthResult } from "../../utils/auth";
import { capsForStake, type Caps } from "../../utils/stake-tier";
import { handleCapacity } from "../../handlers/capacity";
import { liveAccessDoors, type Offer } from "./offers";
import {
	settleX402Payment,
	verifyX402Payment,
	x402Enabled,
	x402Requirements,
	x402Response,
	type X402Payment,
	type X402SettleResult,
	type X402VerifyResult,
} from "../../utils/x402";

export type { Offer } from "./offers";

/** Result of crediting a payer's call balance. Verify-only mode grants nothing. */
export interface GrantResult {
	granted: boolean;
	payer: string;
	calls: number;
	reason?: string;
}

export interface CommerceProvider {
	// --- Caps / tiers (live today) ---
	/** Map a live MOR stake to capacity caps (free tier at 0 stake). */
	capsForStake(mor: number): Caps;
	/** The FREE /mor/v1/capacity readout for a caller (never spends quota). */
	capacity(
		env: Env,
		auth: AuthResult,
		headers: Record<string, string>,
	): Promise<Response>;

	// --- x402 payments (live today, verify-only) ---
	/** x402 is live only when the operator configured a valid pay-to address. */
	paymentsEnabled(env: Env): boolean;
	/**
	 * Build the HTTP 402 Payment Required envelope for a keyless metered call.
	 * May be async: the envelope's additive `offers` menu renders from the
	 * ACTIVE provider's getOffers (see utils/x402.ts), so a composed provider's
	 * extra doors appear in every 402 without touching the spec fields.
	 */
	paymentRequired(
		env: Env,
		resource: string,
		error?: string,
	): Response | Promise<Response>;
	/** Full server-side verification of an X-PAYMENT header. */
	verifyPayment(env: Env, header: string): Promise<X402VerifyResult>;
	/** Accept a verified payment (verify-only: verify + queue; no broadcast). */
	settlePayment(
		env: Env,
		payment: X402Payment,
		payer: string,
		resource: string,
	): Promise<X402SettleResult>;

	// --- Offers (live) + forward-looking stubs ---
	/**
	 * The LIVE access doors (free / stake / per-call), machine-readable, from
	 * the canonical definition in ./offers.ts. Rendered into the 402 envelope.
	 */
	getOffers(env: Env): Promise<Offer[]>;
	/** A price quote for a metered call. Today: the flat x402 per-call price. */
	quote(env: Env, resource: string): Record<string, unknown>;
	/** Credit calls to a payer. Verify-only: no call-balance ledger, no grant. */
	grantCalls(payer: string, calls: number): Promise<GrantResult>;

	// --- Optional purchasable-offer capability (the pack door) ---
	/**
	 * Handle a keyless POST /mor/v1/keys/purchase - the request IS the purchase.
	 * Contract: without an X-PAYMENT header respond 402 with the purchasable
	 * offers as x402 `accepts` entries (the menu); with a verified X-PAYMENT,
	 * settle the payment on-chain FIRST and only then grant + mint (or top up)
	 * an API key (`mspk_` namespace) carrying a prepaid call balance. The
	 * reference build does not implement this, so the route 404s (door absent);
	 * the dispatcher (routes/api.ts) delegates here only when present.
	 */
	purchaseOffer?(env: Env, request: Request): Promise<Response>;
	/**
	 * Meter one metered call against a prepaid call balance. Called by the
	 * dispatcher after the burst gate for every keyed request when present.
	 * Return null to let the request proceed (key not balance-backed, or the
	 * debit succeeded); return a Response (a 402 with the purchase menu) to
	 * block it. The reference build has no call-balance ledger and omits this.
	 */
	debitCallBalance?(env: Env, keyId: string): Promise<Response | null>;
}

/**
 * Bundled REFERENCE CommerceProvider. Thin, behavior-preserving delegation to
 * the existing caps / capacity / x402 implementations - these stay the single
 * definition of each concern (DRY); this object is the injection seam.
 */
export const referenceCommerceProvider: CommerceProvider = {
	capsForStake(mor) {
		return capsForStake(mor);
	},
	capacity(env, auth, headers) {
		return handleCapacity(env, auth, headers);
	},
	paymentsEnabled(env) {
		return x402Enabled(env);
	},
	async paymentRequired(env, resource, error) {
		return x402Response(env, resource, error);
	},
	verifyPayment(env, header) {
		return verifyX402Payment(env, header);
	},
	settlePayment(env, payment, payer, resource) {
		return settleX402Payment(env, payment, payer, resource);
	},
	async getOffers(env) {
		// The three live access doors from the canonical source (./offers.ts).
		// A private CommerceProvider could add purchasable
		// offers here once real settlement exists.
		return liveAccessDoors(env);
	},
	quote(env, resource) {
		// Today there is exactly ONE price surface: the flat x402 per-call price.
		// Reuse the live x402 requirements so a quote matches the 402 envelope.
		return x402Requirements(env, resource);
	},
	async grantCalls(payer, calls) {
		// Verify-only: no call-balance ledger exists yet. A private settlement
		// provider would credit `calls` to `payer` here. Documented no-op today.
		return {
			granted: false,
			payer,
			calls,
			reason: "verify-only mode: no call-balance ledger",
		};
	},
};
