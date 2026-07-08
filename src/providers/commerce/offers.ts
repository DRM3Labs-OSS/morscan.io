/**
 * THE CANONICAL ACCESS-DOORS DEFINITION - single source of truth for how a
 * caller gets MorScan API capacity. Every public surface that DESCRIBES access
 * (the 402 x402 envelope, /llms.txt, /auth.md, the MCP server card, the agent
 * skills, OpenAPI response descriptions) renders from this module. Do not
 * restate caps, prices, or door wording anywhere else - import from here.
 *
 * Three doors are LIVE today, and only live doors are ever rendered:
 *
 *   free     - connect a wallet at /console, sign one challenge, get a key.
 *              Caps: CONNECTED_CAPS (delegated to capsForStake(0)).
 *   stake    - stake MOR on the MorScan builder subnet; the SAME key's caps
 *              follow the live on-chain stake. The mapping is capsForStake
 *              (src/utils/stake-tier.ts) - never duplicate its numbers.
 *   per-call - keyless x402 micropayment (USDC on Base). Price comes from the
 *              live x402 config (X402_PRICE_USDC via x402PriceUsdc) - never a
 *              second copy. Only offered when the operator enabled x402.
 *
 * A FOURTH door exists as a provider capability, not a bundled door:
 *
 *   pack     - prepaid call packs bought with x402 via POST /mor/v1/keys/purchase
 *              (CommerceProvider.purchaseOffer). The reference build does not
 *              implement it (the route 404s); a composed provider that does
 *              exposes it by adding a kind:"pack" offer to getOffers, which is
 *              the single signal every surface (402 offers menu, this module's
 *              accessDoorsMarkdown) renders from.
 *
 * HONESTY LAW: a door appears here ONLY once it actually works end to end.
 * Unbuilt or unproven doors must NOT be added, priced, or hinted at on any
 * public surface until they are real.
 */

import { baseUrl } from "../../config";
// Registry import forms a cycle (providers/index -> commerce/index -> offers);
// intentional and safe: getProviders is referenced inside function bodies only,
// never at module eval (same pattern as the x402.ts <-> offers.ts cycle).
import { getProviders } from "../index";
import type { Env } from "../../types";
import {
	BURST_PER_MOR,
	capsForStake,
	type Caps,
	CONNECTED_CAPS,
	DAILY_FRACTION_OF_MONTHLY,
} from "../../utils/stake-tier";
import { X402_ASSET_USDC_BASE, x402Enabled, x402PriceUsdc } from "../../utils/x402";

/**
 * One live access door, machine-readable. Rendered verbatim into the 402
 * envelope's additive `offers` field and returned by CommerceProvider.getOffers.
 */
export interface Offer {
	id: string;
	kind: "free" | "stake" | "per-call" | "pack";
	/** Plain instruction an agent can follow without a human. */
	how: string;
	/** Capacity you get (free door). */
	caps?: Caps;
	/** Example caps by stake, computed from capsForStake (stake door). */
	capsByStakeMor?: Record<string, Caps>;
	/** Per-call price (per-call door). */
	price?: {
		amount: string;
		currency: "USDC";
		network: "base";
		asset: string;
		per: "call";
	};
	/** Purchasable prepaid call packs (pack door; composed providers only). */
	packs?: Array<{
		id: string;
		calls: number;
		price: { amount: string; currency: "USDC"; network: "base"; asset: string };
	}>;
	url: string;
}

/**
 * The flat call-pack rate (e.g. pay 1 USD, receive 10,000 calls). A composed
 * CommerceProvider implementing purchaseOffer prices its packs from this rate
 * (the private engine mirrors this constant; keep the two identical). The
 * REFERENCE build never renders a pack door: this constant stays absent from
 * liveAccessDoors, accessHint, and every reference-rendered surface. It goes
 * public only through a composed provider's kind:"pack" getOffers entry, which
 * exists only where the purchase + settlement + ledger path is live.
 */
export const INTERNAL_CALL_PACK_USD_PER_CALL = 0.0001;

const nf = new Intl.NumberFormat("en-US");

/** Canonical free-tier caps phrase: "60 req/min, 2,000/day, 40,000/month". */
export function freeCapsPhrase(): string {
	return `${CONNECTED_CAPS.burst} req/min, ${nf.format(CONNECTED_CAPS.daily)}/day, ${nf.format(CONNECTED_CAPS.monthly)}/month`;
}

/** Canonical stake-scaling phrase, derived from the capsForStake constants. */
export function stakeScalingPhrase(): string {
	return `${BURST_PER_MOR} req/min per MOR staked; volume caps rise with stake and the daily cap is ${Math.round(DAILY_FRACTION_OF_MONTHLY * 100)}% of the monthly cap`;
}

/** Canonical per-call price phrase, from the live x402 config: "0.01 USDC per call". */
export function perCallPricePhrase(env: Env): string {
	return `${x402PriceUsdc(env)} USDC per call`;
}

/**
 * The LIVE access doors, machine-readable. The per-call door is included only
 * when the operator actually enabled x402 (honest: never advertise a dead door).
 */
export function liveAccessDoors(env: Env): Offer[] {
	const b = baseUrl();
	const doors: Offer[] = [
		{
			id: "free-key",
			kind: "free",
			how: `Mint a free API key with one wallet signature (no email, no signup, no payment): connect at ${b}/console, or headless: GET /console/wallet/challenge, sign the message with EIP-191 personal_sign, POST { wallet, signature, nonce } to /console/wallet/verify. Send the key as X-Morscan-Key on /mor/v1/* requests.`,
			caps: capsForStake(0),
			url: `${b}/console`,
		},
		{
			id: "stake-mor",
			kind: "stake",
			how: `Raise the same key's caps by staking MOR on the MorScan builder subnet (${stakeScalingPhrase()}). Caps follow your live on-chain stake within a minute; your principal stays yours.`,
			capsByStakeMor: {
				"100": capsForStake(100),
				"500": capsForStake(500),
				"2500": capsForStake(2500),
			},
			url: `${b}/stake`,
		},
	];
	if (x402Enabled(env)) {
		doors.push({
			id: "x402-per-call",
			kind: "per-call",
			how: "Pay per call with x402, no key and no account: sign an EIP-3009 USDC transferWithAuthorization matching this envelope's accepts entry and retry with the X-PAYMENT header. This payment path works as-is.",
			price: {
				amount: x402PriceUsdc(env),
				currency: "USDC",
				network: "base",
				asset: X402_ASSET_USDC_BASE,
				per: "call",
			},
			url: `${b}/auth.md`,
		});
	}
	return doors;
}

/** Short agent hint for the 402 envelope, rendered from the live doors only. */
export function accessHint(env: Env): string {
	const b = baseUrl();
	const parts = [
		`Mint a FREE API key at ${b}/console with one wallet signature, no signup (${freeCapsPhrase()}).`,
		`Stake MOR at ${b}/stake to raise the same key's caps (${stakeScalingPhrase()}).`,
	];
	if (x402Enabled(env)) {
		parts.push(
			`Or pay per call right now (${perCallPricePhrase(env)} on Base): sign the accepted USDC authorization and retry with the X-PAYMENT header.`,
		);
	}
	return `${parts.join(" ")} Details: ${b}/auth.md`;
}

/**
 * The canonical access section for agent docs (llms.txt, auth.md). ONE wording
 * for every surface; only live doors are listed. Async because the composed
 * provider's extra doors (e.g. a purchasable call-pack door) come from the
 * ACTIVE CommerceProvider's getOffers - a door is rendered here if and only if
 * it is in that live offers menu, so docs can never advertise a dead door.
 */
export async function accessDoorsMarkdown(env: Env): Promise<string> {
	const b = baseUrl();
	const lines = [
		`- Free key: connect a wallet at ${b}/console and sign one challenge (no email, no signup, no payment) - ${freeCapsPhrase()}. Headless mint: GET /console/wallet/challenge, sign with EIP-191 personal_sign, POST /console/wallet/verify.`,
		`- Stake for more: stake MOR on the MorScan builder subnet and the same key's caps follow your live stake (${stakeScalingPhrase()}). Your principal stays yours. See ${b}/stake`,
	];
	if (x402Enabled(env)) {
		lines.push(
			`- Pay per call with x402: no key at all - a keyless call to a metered endpoint returns 402 with an x402 envelope (x402.org); pay ${perCallPricePhrase(env)} on Base (eip155:8453) via a signed EIP-3009 X-PAYMENT header. Verified at request time, settled on-chain in batches. See ${b}/auth.md`,
		);
	}
	// Provider-exposed doors beyond the bundled three (pack door, when live).
	// The offer's own `how` is the canonical wording - no second copy here.
	try {
		const offers = await getProviders().commerce.getOffers(env);
		for (const o of offers) {
			if (o.kind === "pack") lines.push(`- ${o.how}`);
		}
	} catch {
		// Docs must render even if the provider's offer lookup fails.
	}
	return lines.join("\n");
}
