/**
 * OpenAPI 3.1 Specification for MorScan API
 */

import { baseUrl } from "../config";
import { freeCapsPhrase, stakeScalingPhrase } from "../providers/commerce/offers";
import { schemas } from "./openapi-schemas";
import { paths } from "./openapi-paths";

export const openApiSpec = {
	openapi: "3.1.0",
	info: {
		title: "MorScan - Morpheus Blockchain Explorer API",
		version: "2.0.0",
		description: `Real-time Morpheus blockchain explorer API. Provider, bid, session, and model data with sub-400ms response times. Fetches model names from on-chain ModelRegistry and tracks retracted bid history. Metered /mor/v1/* endpoints take a free API key via the X-Morscan-Key header (mint one with a wallet signature, see /auth.md) OR an x402 micropayment: keyless calls return 402 with an x402 envelope and accept 0.01 USDC per call on Base via the X-PAYMENT header (EIP-3009 transferWithAuthorization).`,
	},
	servers: [
		{ url: "https://morscan.io", description: "Production (set PUBLIC_BASE_URL)" },
	],
	paths,
	components: {
		securitySchemes: {
			apiKey: {
				type: "apiKey",
				in: "header",
				name: "X-Morscan-Key",
				description: "API key for authentication (format: mor_xxxxx)",
			},
		},
		responses: {
			RateLimited: {
				description:
					"Rate limited. Every key has a per-minute burst budget plus daily and monthly volume caps. " +
					`A connected-wallet key (free, connect at /console) is ${freeCapsPhrase()}; ` +
					`staking MOR on the MorScan builder subnet raises the same key's caps: ${stakeScalingPhrase()} (see /stake). ` +
					"Daily caps reset at 00:00 UTC and monthly caps on the 1st of the month (UTC). Volume caps are " +
					"checked against a 60-second cache, so enforcement lands within a minute or two of the boundary. " +
					"The Retry-After header says when to try again.",
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								error: { type: "string", example: "Rate limit exceeded" },
								reason: {
									type: "string",
									example: "Daily cap reached (2000/day). Resets at 00:00 UTC.",
								},
								retry_after: { type: "integer", example: 42 },
								docs_url: { type: "string", example: "https://morscan.io/stake" },
							},
						},
					},
				},
			},
			ServerError: {
				description:
					"Unexpected server error. Safe to retry with backoff; check /health for service status.",
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: { error: { type: "string", example: "Internal server error" } },
						},
					},
				},
			},
			PaymentRequired: {
				description:
					"Payment required (x402). Returned to KEYLESS requests on metered endpoints: the JSON body is an " +
					"x402 envelope (x402.org) advertising the accepted payment - scheme `exact`, network `base` " +
					"(eip155:8453), asset USDC, price per call in atomic units (default 10000 = 0.01 USDC). Retry with " +
					"an X-PAYMENT header carrying a signed EIP-3009 transferWithAuthorization payload; the response then " +
					"carries an X-PAYMENT-RESPONSE ack. Authorizations are verified cryptographically at request time " +
					`and settled on-chain in batches. Alternative: mint a free API key (${freeCapsPhrase()}) - see /auth.md. ` +
					"Requests with an INVALID key still get 401, and a failed payment gets 402 with an `error` field.",
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								x402Version: { type: "integer", example: 1 },
								error: {
									type: "string",
									example: "nonce already used",
									description: "Present when an X-PAYMENT was sent but rejected",
								},
								accepts: {
									type: "array",
									items: {
										type: "object",
										properties: {
											scheme: { type: "string", example: "exact" },
											network: { type: "string", example: "base" },
											maxAmountRequired: { type: "string", example: "10000" },
											resource: { type: "string" },
											description: { type: "string" },
											mimeType: { type: "string", example: "application/json" },
											payTo: { type: "string" },
											maxTimeoutSeconds: { type: "integer", example: 60 },
											asset: {
												type: "string",
												example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
											},
										},
									},
								},
								hint: { type: "string" },
							},
						},
					},
				},
			},
			Unauthorized: {
				description:
					"Missing or invalid API key. Send X-Morscan-Key on every request. Connect your wallet at /console " +
					`for a free key (${freeCapsPhrase()}) - no email, no signup. Need more? Stake MOR on the MorScan builder ` +
					"subnet and capacity scales with your live stake (see /stake). Keyless requests to metered " +
					"endpoints get 402 with an x402 payment envelope instead (pay per call in USDC on Base).",
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {
								error: { type: "string", example: "Invalid API key" },
							},
						},
					},
				},
			},
		},
		schemas,
	},
};

export function handleOpenApi(
	headers: Record<string, string>,
	origin?: string,
): Response {
	// servers[0] must be the origin actually serving this spec so the playground
	// "Try it" and any imported client hit a live surface. Prefer the request
	// origin (e.g. staging.morscan.io) over the configured PUBLIC_BASE_URL, which
	// can point at the coming-soon apex where /mor/v1/* is not served.
	const serverUrl = origin || baseUrl();
	const spec = JSON.parse(
		JSON.stringify({
			...openApiSpec,
			servers: [{ url: serverUrl, description: "Live API origin" }],
		}),
	);
	for (const pathItem of Object.values(
		spec.paths as Record<string, Record<string, { responses?: Record<string, unknown> }>>,
	)) {
		for (const op of Object.values(pathItem)) {
			if (!op || typeof op !== "object" || !("responses" in op) || !op.responses)
				continue;
			op.responses["401"] = op.responses["401"] || {
				$ref: "#/components/responses/Unauthorized",
			};
			op.responses["429"] = op.responses["429"] || {
				$ref: "#/components/responses/RateLimited",
			};
			op.responses["500"] = op.responses["500"] || {
				$ref: "#/components/responses/ServerError",
			};
		}
	}
	return new Response(JSON.stringify(spec, null, 2), {
		headers: { ...headers, "Content-Type": "application/json" },
	});
}
