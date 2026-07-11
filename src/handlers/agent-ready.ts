/**
 * Agent-ready discovery surfaces.
 *
 * Machine-readable endpoints that let AI agents discover, understand, and use
 * the MorScan API without human help:
 *
 *   /.well-known/api-catalog                 RFC 9727 api-catalog linkset
 *   /.well-known/oauth-protected-resource    RFC 9728 protected-resource metadata
 *   /.well-known/mcp/server-card.json        MCP server card (SEP-1649 draft)
 *   /.well-known/agent-skills/index.json     Agent Skills Discovery (v0.2.0)
 *   /.well-known/agent-skills/<name>/SKILL.md  the skill docs themselves
 *   /auth.md                                 agent registration instructions
 *   /webmcp.js                               WebMCP page tools (feature-detected)
 *
 * These documents describe the system as it actually is: key auth is a wallet
 * connect at /console that mints an X-Morscan-Key. There is no OAuth
 * authorization server and no MCP JSON-RPC transport.
 *
 * All absolute URLs derive from PUBLIC_BASE_URL (src/config.ts).
 */

import { baseUrl } from "../config";
import {
	accessDoorsMarkdown,
	freeCapsPhrase,
	perCallPricePhrase,
	stakeScalingPhrase,
} from "../providers/commerce/offers";
import type { Env } from "../types";
import { x402Enabled, x402PriceAtomic, x402PriceUsdc } from "../utils/x402";
import { MORSCAN_VERSION } from "../version";

const CACHE_1H = "public, max-age=3600";

function jsonResponse(body: unknown, contentType: string): Response {
	return new Response(JSON.stringify(body, null, 2), {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": CACHE_1H,
			"Access-Control-Allow-Origin": "*",
		},
	});
}

function markdownResponse(body: string, extra?: Record<string, string>): Response {
	return new Response(body, {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": CACHE_1H,
			"Access-Control-Allow-Origin": "*",
			...extra,
		},
	});
}

// ─── RFC 8288 Link header advertised on HTML pages ───

/** Link relations pointing agents at the discovery surfaces (RFC 8288). */
export const AGENT_LINK_HEADER = [
	'</.well-known/api-catalog>; rel="api-catalog"',
	'</openapi.json>; rel="service-desc"; type="application/json"',
	'</llms.txt>; rel="service-doc"; type="text/plain"',
].join(", ");

// ─── RFC 9727 api-catalog ───

/** GET /.well-known/api-catalog - RFC 9727 linkset (application/linkset+json). */
export function handleApiCatalog(): Response {
	const b = baseUrl();
	const body = {
		linkset: [
			{
				anchor: `${b}/mor/v1`,
				"service-desc": [{ href: `${b}/openapi.json`, type: "application/json" }],
				"service-doc": [
					{ href: `${b}/llms.txt`, type: "text/plain" },
					{ href: `${b}/llms-full.txt`, type: "text/plain" },
					{ href: `${b}/auth.md`, type: "text/markdown" },
					{ href: `${b}/api/docs`, type: "text/html" },
				],
				"service-meta": [
					{ href: `${b}/.well-known/morscan-keys.json`, type: "application/json" },
				],
				status: [{ href: `${b}/health`, type: "application/json" }],
			},
		],
	};
	return jsonResponse(body, "application/linkset+json");
}

// ─── RFC 9728 protected resource metadata (honest: no OAuth server exists) ───

/** GET /.well-known/oauth-protected-resource - RFC 9728, truthful. */
export function handleOauthProtectedResource(): Response {
	const b = baseUrl();
	const body = {
		resource: `${b}/mor/v1`,
		resource_name: "MorScan API",
		// The issuer below publishes RFC 8414 metadata at
		// /.well-known/oauth-authorization-server with EMPTY grant lists (no
		// OAuth flows exist) and an agent_auth block describing the real
		// scheme: MorScan API keys (mor_...) minted by a wallet-signature
		// challenge at /console, accepted as `Authorization: Bearer <key>` or
		// the canonical `X-Morscan-Key: <key>` header. See /auth.md.
		authorization_servers: [baseUrl()],
		bearer_methods_supported: ["header"],
		resource_documentation: `${b}/auth.md`,
		// Non-standard but honest extensions describing the real scheme:
		morscan_auth_scheme: {
			type: "api_key",
			canonical_header: "X-Morscan-Key",
			also_accepted: "Authorization: Bearer <key>",
			registration: `${b}/console`,
			registration_method:
				"Sign a one-time challenge message with an EVM wallet (EIP-191 personal_sign). No email, no signup, no payment. Works fully headless over plain HTTP: GET /console/wallet/challenge, sign the returned message, POST { wallet, signature, nonce } to /console/wallet/verify - the response includes the API key. Humans can do the same via the /console UI (WalletConnect or injected wallet). See /auth.md for the recipe.",
			docs: [`${b}/auth.md`, `${b}/llms.txt`],
		},
	};
	return jsonResponse(body, "application/json");
}

// ─── RFC 8414 authorization server metadata (honest: no OAuth grants) ───

/** GET /.well-known/oauth-authorization-server - RFC 8414 shape, truthful.
 * MorScan runs NO OAuth flows: the empty grant/response lists say so
 * explicitly, and the agent_auth block (WorkOS auth.md agent-registration
 * draft) describes the real scheme - wallet-signature key mint + x402 - so
 * an agent that discovers this document knows exactly how to get in. */
export function handleOauthAuthServer(): Response {
	const b = baseUrl();
	const body = {
		issuer: b,
		// HONEST: no authorization/token endpoints exist. Empty capability
		// lists are the RFC-shaped way to say "no OAuth grants here"; the
		// agent_auth block below is how you actually authenticate.
		grant_types_supported: [],
		response_types_supported: [],
		token_endpoint_auth_methods_supported: [],
		service_documentation: `${b}/auth.md`,
		agent_auth: {
			register_uri: `${b}/console/wallet/challenge`,
			registration_flow:
				"GET /console/wallet/challenge -> sign the returned message with EIP-191 personal_sign -> POST { wallet, signature, nonce } to /console/wallet/verify. The response includes the API key. No email, no signup, no payment.",
			identity_types_supported: ["evm_wallet"],
			credential_types_supported: ["api_key", "x402_payment"],
			credential_header: "X-Morscan-Key",
			also_accepted: "Authorization: Bearer <key>",
			claim_uri: `${b}/console/wallet/verify`,
			status_uri: `${b}/console/wallet/status`,
			pricing_uri: `${b}/auth.md`,
			documentation: `${b}/auth.md`,
		},
	};
	return jsonResponse(body, "application/json");
}

// ─── /auth.md - agent registration instructions ───

const authMd = async (env: Env) => `# Auth.md

> MorScan API access for agents

MorScan is the block explorer and real-time API for the Morpheus AI network on
Base L2. This page tells an agent (or its operator) exactly how to get and use
an API key. There is no OAuth flow: authentication is a single API key minted
by a wallet signature.

## Access at a glance

${await accessDoorsMarkdown(env)}

## Getting a key

Registration is a wallet signature - nothing else. No email, no signup, no
payment. There are two ways in; both mint the same key (format
\`mor_<32 chars>\`).

### Headless (for agents - no browser needed)

The mint endpoints are plain HTTP. Three steps:

1. \`GET ${baseUrl()}/console/wallet/challenge\` returns
   \`{ "nonce": "...", "message": "..." }\`. The nonce is single-use and
   expires in 5 minutes.
2. Sign the returned \`message\` string with EIP-191 \`personal_sign\` using
   your EVM private key. The signature is the standard 65-byte \`r||s||v\` hex
   (v = 27 or 28).
3. \`POST ${baseUrl()}/console/wallet/verify\` with JSON
   \`{ "wallet": "0x...", "signature": "0x...", "nonce": "..." }\`. On first
   connect the response includes your \`key\` (\`mor_...\`) plus your \`caps\`
   and \`stakeMor\`. It also sets a session cookie; a returning wallet (key
   already minted) can read its existing key from
   \`GET /console/wallet/status\` using that cookie.

\`\`\`bash
# 1. challenge
CHAL=$(curl -s ${baseUrl()}/console/wallet/challenge)
NONCE=$(echo "$CHAL" | jq -r .nonce)
MSG=$(echo "$CHAL" | jq -r .message)
# 2. sign $MSG with your wallet key (any EVM lib), e.g. in JS:
#      const sig = await wallet.signMessage(msg);   // ethers: EIP-191 personal_sign
# 3. verify -> key
curl -s -X POST ${baseUrl()}/console/wallet/verify \\
  -H "Content-Type: application/json" \\
  -d "{\\"wallet\\":\\"$WALLET\\",\\"signature\\":\\"$SIG\\",\\"nonce\\":\\"$NONCE\\"}"
# -> { "ok": true, "wallet": "0x...", "key": "mor_...", "caps": {...}, "stakeMor": 0 }
\`\`\`

### Browser (for humans)

Open ${baseUrl()}/console with an EVM wallet (WalletConnect or an injected
wallet), connect, and sign the same one-time challenge. The console shows your
key immediately.

Rotate (\`POST /console/key\`) and delete (\`POST /console/key/revoke\`) are
done from /console while signed in. Deleting stops the key immediately; the
wallet session stays signed in, so a fresh key can be minted anytime with
\`POST /console/key\`. Once minted, the key itself is all an agent needs.

## Using the key

Send the key on every \`/mor/v1/*\` request. The canonical header:

\`\`\`
X-Morscan-Key: mor_yourkeyhere
\`\`\`

\`Authorization: Bearer mor_yourkeyhere\` is also accepted.

\`\`\`bash
curl -s ${baseUrl()}/mor/v1/providers -H "X-Morscan-Key: mor_yourkeyhere"
\`\`\`

## Free vs metered endpoints

Free, no key required:

- \`GET /health\` - sync status, block heights, service health
- \`GET /mor/v1/price\` - MOR/USD from the Base DEX (keyless calls are free;
  the same call WITH a key routes through metering and counts as 1)
- \`GET /mor/v1/price/chart\` - price history (same keyless/keyed rule)
- \`GET /mor/v1/capacity\` - your remaining quota (free even with a key)
- \`GET /openapi.json\`, \`/llms.txt\`, \`/llms-full.txt\`, \`/chart.svg\`, \`/teaser\`

Metered (key required, a flat 1 call each): everything else under \`/mor/v1/\`,
e.g. \`/mor/v1/all\`, \`/mor/v1/providers\`, \`/mor/v1/bids\`, \`/mor/v1/sessions\`,
\`/mor/v1/models\`, \`/mor/v1/holders\`, \`/mor/v1/builder/*\`, \`/mor/v1/analytics\`,
\`/mor/v1/reputation\`, \`/mor/v1/provenance\`. The full list with schemas is in
\`${baseUrl()}/openapi.json\`.

## Pay per call (x402)
${
	x402Enabled(env)
		? ""
		: `
NOTE: x402 is NOT enabled on this deployment (no pay-to address is
configured), so keyless calls to metered endpoints return 401, not 402. The
description below applies only to deployments with x402 enabled.
`
}
No key at all? Metered endpoints also accept **x402 micropayments**
(https://www.x402.org): **${perCallPricePhrase(env)}** on Base, paid to a
self-custodied address, no account anywhere.

How it works:

1. Call a metered endpoint with no key. The response is **HTTP 402** with an
   x402 envelope: \`accepts\` advertises scheme \`exact\`, network \`base\`
   (eip155:8453), asset USDC
   (\`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`), the \`payTo\` address,
   and \`maxAmountRequired\` in atomic units (${x402PriceAtomic(env)} =
   ${x402PriceUsdc(env)} USDC at 6 decimals). The 402 body also
   carries additive \`offers\` (every live access door, machine-readable) and
   \`hint\` fields alongside the spec-shaped \`accepts\`.
2. Sign an EIP-3009 \`transferWithAuthorization\` for exactly that transfer
   (any x402 client library does this) and retry with the \`X-PAYMENT\`
   header (base64 JSON: \`{ x402Version: 1, scheme: "exact", network:
   "base", payload: { signature, authorization } }\`).
3. The server verifies the payment cryptographically (payTo, amount, validity
   window, unused nonce, and the EIP-712 signature recovering the payer),
   serves the response, and acks with an \`X-PAYMENT-RESPONSE\` header.

Settlement is honest and explicit: **payment authorizations are verified
cryptographically at request time and settled on-chain in batches.** A signed
\`transferWithAuthorization\` stays valid within its window and can be
broadcast by anyone later, so deferred settlement loses nothing except time;
the ack's \`transaction\` field is empty until the batch lands. A failed or
replayed payment gets 402 again with an \`error\` field. An INVALID key still
gets a plain 401 (bad key is not the same as no key). Abuse guard: at most
100 unsettled authorizations per payer, plus the normal per-IP limits.

The free-key path above is usually the better deal for sustained use
(${freeCapsPhrase()}, at no cost); x402 exists so an agent holding only a
funded wallet can pay per call without registering anything.

## Rate limits

- Free connected-wallet key: **${freeCapsPhrase()}**.
- Staking MOR on the MorScan builder subnet raises the SAME key's capacity:
  ${stakeScalingPhrase()}. Details: ${baseUrl()}/stake
- Daily caps reset at 00:00 UTC; monthly caps on the 1st (UTC). A separate
  per-IP limit (100/min) applies to keyless traffic.
- Paginated list endpoints (sessions, holders, builder events, provenance)
  return at most **100 rows per page**, server-enforced; a higher \`limit\` is
  clamped and the applied value is echoed in the response's pagination meta.
  Use \`page\` to paginate (max depth 1000).

On over-limit you get \`429\` with a \`Retry-After\` header (seconds) and a JSON
body with \`reason\` and \`retry_after\`. Successful keyed responses carry
\`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\`, plus
\`X-RateLimit-Limit-Day\`/\`-Remaining-Day\` and \`-Month\` variants when volume
caps apply. Errors: \`401\` = missing/invalid key, \`500\` = retry with backoff
and check /health.

## Provenance verification

Every API response is Ed25519-signed: rows carry a \`_receipt\` id and the
receipt chain is queryable at \`GET /mor/v1/provenance\`. Public keys are
published at \`${baseUrl()}/.well-known/morscan-keys.json\` (schema drm3-keys/v2)
so responses can be verified offline with the MIT-licensed
\`@drm3labs-oss/provenance\` package, or with the ~50-line runnable verifier
that ships in the repo (\`npm run verify:receipt\`, see
\`scripts/verify-receipt.mjs\` at https://github.com/DRM3Labs-OSS/morscan.io).
A step-by-step agent skill:
\`${baseUrl()}/.well-known/agent-skills/verify-provenance-receipt/SKILL.md\`.
For humans, \`${baseUrl()}/verify\` runs the same check in the browser; the
CLI verifier above remains the agent path.

## More machine-readable surfaces

- \`/.well-known/api-catalog\` - RFC 9727 catalog of this API
- \`/openapi.json\` - OpenAPI 3.1 spec
- \`/llms.txt\` and \`/llms-full.txt\` - agent-oriented site guide
- \`/.well-known/agent-skills/index.json\` - task-level skill docs
- \`/.well-known/mcp/server-card.json\` - integration card (HTTP API; no MCP
  JSON-RPC transport is offered today)
- \`GET /\`, \`/about\`, \`/contribute\`, \`/stake\` with \`Accept: text/markdown\`
  return markdown versions of those pages
`;

/** GET /auth.md - agent registration instructions (truthful, no OAuth pretense). */
export async function handleAuthMd(env: Env): Promise<Response> {
	return markdownResponse(await authMd(env));
}

// ─── MCP server card (SEP-1649 draft) - honest: HTTP API, no MCP transport ───

/** GET /.well-known/mcp/server-card.json */
export function handleMcpServerCard(env: Env): Response {
	const b = baseUrl();
	const body = {
		$schema: "https://modelcontextprotocol.io/schemas/draft/server-card.json",
		serverInfo: {
			name: "morscan",
			title: "MorScan - Morpheus AI network explorer API",
			version: MORSCAN_VERSION,
			description:
				"Real-time indexed data for the Morpheus decentralized-AI network on Base L2: providers, model bids, sessions, builder subnets, MOR holders, MOR/USD price, and network economics. Every response is Ed25519-signed with verifiable provenance receipts.",
			websiteUrl: b,
		},
		// HONEST: MorScan does not run an MCP JSON-RPC transport today. The
		// integration point is the plain HTTP API described below; this card
		// exists so MCP-aware agents can still discover and use the service.
		capabilities: {},
		transport: {
			type: "http",
			endpoint: `${b}/mor/v1`,
			note: "This is a plain REST API, NOT an MCP JSON-RPC endpoint. MorScan does not offer an MCP transport today; agents should call the HTTP API directly using the OpenAPI spec. In-page WebMCP tools (navigator.modelContext) are exposed on the website itself.",
		},
		authentication: {
			type: "apiKey",
			header: "X-Morscan-Key",
			registration: `${b}/console`,
			documentation: `${b}/auth.md`,
			// Rendered from the canonical access-doors source (offers.ts).
			note: `Free key via wallet connect + challenge signature at /console (${freeCapsPhrase()}). Stake MOR at /stake to raise the same key's caps (${stakeScalingPhrase()}).${x402Enabled(env) ? ` Keyless metered calls may instead pay per call with x402 (${perCallPricePhrase(env)}, USDC on Base) - see /auth.md.` : ""} No OAuth.`,
		},
		documentation: {
			openapi: `${b}/openapi.json`,
			llmsTxt: `${b}/llms.txt`,
			apiCatalog: `${b}/.well-known/api-catalog`,
			agentSkills: `${b}/.well-known/agent-skills/index.json`,
			authGuide: `${b}/auth.md`,
		},
	};
	return jsonResponse(body, "application/json");
}

// ─── Agent Skills Discovery (RFC v0.2.0) ───

interface SkillDef {
	name: string;
	description: string;
	body: () => string;
}

const SKILLS: SkillDef[] = [
	{
		name: "query-mor-price",
		description:
			"Get the live MOR token price in USD (with 24h change and market cap) from MorScan's on-chain Base DEX read. Free, no API key required.",
		body: () => `---
name: query-mor-price
description: Get the live MOR/USD price, 24h change, and market cap from MorScan.
---

# Query the MOR price

MorScan reads MOR/USD on-chain from the Base DEX (Uniswap v3 MOR/WETH pool)
and ETH/USD from Chainlink on Base. The endpoint is public market data: FREE
and unauthenticated when called WITHOUT a key (sending a key routes the call
through metering and counts as 1 request).

## Request

\`\`\`bash
curl -s ${baseUrl()}/mor/v1/price
\`\`\`

No headers needed. Cached about 30-60 seconds at the edge.

## Response shape

\`\`\`json
{
  "usd": 12.45,
  "change24h": -3.21,
  "marketCap": 125000000,
  "eth": { "usd": 3450.0, "change24h": 1.5 },
  "cached": true,
  "fetchedAt": 1711324800
}
\`\`\`

- \`usd\` - current MOR price in USD (number)
- \`change24h\` - 24-hour percent change (number, may be negative)
- \`marketCap\` - MOR market cap in USD
- \`stale\` - present and true only if the price feed is delayed

## Price history

\`GET ${baseUrl()}/mor/v1/price/chart?window=24h|7d|30d|90d|all\` (also free
keyless) returns \`{ "prices": [{ "t": <ms epoch>, "v": <usd> }, ...] }\`.
`,
	},
	{
		name: "list-providers",
		description:
			"List all registered Morpheus AI compute providers with endpoints and stake. Requires a free X-Morscan-Key (wallet connect at /console).",
		body: () => `---
name: list-providers
description: List registered Morpheus AI compute providers via the MorScan API.
---

# List Morpheus providers

Returns every AI compute provider registered on the Morpheus Diamond contract
(Base L2), as indexed in real time by MorScan.

## Auth

Requires an API key. Get one free: connect a wallet at ${baseUrl()}/console and
sign the challenge (free tier: ${freeCapsPhrase()}). Full details:
${baseUrl()}/auth.md

## Request

\`\`\`bash
curl -s ${baseUrl()}/mor/v1/providers -H "X-Morscan-Key: mor_yourkeyhere"
\`\`\`

## Response shape

\`\`\`json
{
  "meta": { "lastBlock": 43500000, "lastSync": "2026-07-05T12:00:00.000Z" },
  "total": 12,
  "providers": [
    {
      "address": "0x1234...abcd",
      "endpoint": "https://provider.example.com:8545",
      "stake": "200000000000000000",
      "createdAt": 1726500000,
      "_receipt": "rcpt_..."
    }
  ]
}
\`\`\`

Each row carries a \`_receipt\` provenance id (see the
verify-provenance-receipt skill). Related endpoints: \`/mor/v1/providers/{address}\`
(detail dashboard), \`/mor/v1/bids\` (per-model price offers), \`/mor/v1/all\`
(full marketplace in one call). Schemas: ${baseUrl()}/openapi.json
`,
	},
	{
		name: "get-network-health",
		description:
			"Check MorScan service health and Morpheus network sync state (block heights, lag, coverage). Free, no API key required.",
		body: () => `---
name: get-network-health
description: Check MorScan sync/service health and current block heights.
---

# Get network health

Reports how live MorScan's index is: chain head vs indexed block, sync lag,
dataset backfill coverage, and service status. FREE, no key.

## Request

\`\`\`bash
curl -s ${baseUrl()}/health
\`\`\`

## Reading the response

Key fields (top level or under \`extended\`):

- \`status\` - overall service state
- \`syncedBlock\` / \`currentBlock\` - indexed block vs chain head on Base
- \`blocksBehind\` - the sync gap (Base blocks are ~2s; under ~10 is live)
- \`lastSyncTimestamp\` - when the indexer last advanced
- \`coverage.datasets\` - per-dataset deep-history backfill percentages
- \`version\` - deployed MorScan version

Use this before heavy queries: if \`blocksBehind\` is large or the last sync is
stale, recent rows may lag the chain. Poll politely (the page UI polls every
5-25s; agents should not need more than that).
`,
	},
	{
		name: "verify-provenance-receipt",
		description:
			"Verify the Ed25519 provenance receipt on a MorScan API response offline against the published public keys.",
		body: () => `---
name: verify-provenance-receipt
description: Verify MorScan's Ed25519 provenance receipts offline.
---

# Verify a provenance receipt

Every MorScan API response is signed. Data rows carry a \`_receipt\` id, and
receipts chain into Merkle roots, so any response can be verified offline
against published keys instead of trusted.

## 1. Fetch the published public keys

\`\`\`bash
curl -s ${baseUrl()}/.well-known/morscan-keys.json
\`\`\`

Schema \`drm3-keys/v2\`: \`current\` holds the active Ed25519 keys by signing
path (\`morscan/cache\` for indexed on-chain state, \`morscan/signer\` for
derived aggregates), \`history\` holds prior rotations with validity windows.

## 2. Fetch receipts

\`\`\`bash
curl -s "${baseUrl()}/mor/v1/provenance?limit=50" -H "X-Morscan-Key: mor_yourkeyhere"
\`\`\`

(Metered; key required - see ${baseUrl()}/auth.md.) Each receipt has \`id\`,
\`action\`, \`timestamp\`, \`inputHash\`, \`outputHash\`, \`publicKey\`,
\`signature\`, and its chain linkage (\`chainRoot\`, \`chainId\`).

## 3. Verify offline

Use the MIT-licensed verifier (npm: \`@drm3labs-oss/provenance\`):

\`\`\`js
import { Receipt } from "@drm3labs-oss/provenance";
const receipt = Receipt.fromJson(receiptJson);
const ok = await receipt.verify(); // Ed25519 signature check
// Then confirm receipt.publicKey matches a key published at
// /.well-known/morscan-keys.json whose validity window covers the timestamp.
\`\`\`

A valid signature + published-key match proves the bytes were attested by the
holder of MorScan's signing key. \`GET /version\` additionally carries a signed
build receipt for the running deployment itself.

## Or run the ready-made verifier

The Fair Source repo (https://github.com/DRM3Labs-OSS/morscan.io) ships a
~50-line dependency-light Node verifier that does all of the above:

\`\`\`bash
git clone https://github.com/DRM3Labs-OSS/morscan.io.git && cd morscan.io
npm install
npm run verify:receipt                                  # verifies /mor/v1/price
node scripts/verify-receipt.mjs ${baseUrl()}/version    # any signed endpoint
\`\`\`

It rebuilds the canonical signing payload from the response's receipt, checks
the Ed25519 signature with @noble/curves, and confirms the key is published in
/.well-known/morscan-keys.json with a validity window covering the receipt
timestamp. Prints PASS or FAIL with the key path.
`,
	},
];

/** Compute the hex sha256 of a UTF-8 string via WebCrypto. */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** GET /.well-known/agent-skills/index.json - Agent Skills Discovery v0.2.0. */
export async function handleAgentSkillsIndex(): Promise<Response> {
	const b = baseUrl();
	const skills = await Promise.all(
		SKILLS.map(async (s) => ({
			name: s.name,
			type: "skill",
			description: s.description,
			url: `${b}/.well-known/agent-skills/${s.name}/SKILL.md`,
			// sha256 of the exact bytes served at `url` (same generator, same
			// baseUrl), recomputed here so the digest can never drift from the doc.
			sha256: await sha256Hex(s.body()),
		})),
	);
	const body = {
		$schema: "https://agentskills.io/schemas/v0.2.0/discovery.json",
		version: "0.2.0",
		provider: {
			name: "morscan",
			url: b,
			documentation: `${b}/llms.txt`,
		},
		skills,
	};
	return jsonResponse(body, "application/json");
}

/** GET /.well-known/agent-skills/<name>/SKILL.md - serve one skill doc. */
export function handleAgentSkill(name: string): Response | null {
	const skill = SKILLS.find((s) => s.name === name);
	if (!skill) return null;
	return markdownResponse(skill.body());
}

/** Route dispatcher for all agent-ready paths. Returns null when not ours. */
export async function handleAgentReadyRoutes(
	path: string,
	env: Env,
): Promise<Response | null> {
	if (path === "/.well-known/api-catalog") return handleApiCatalog();
	if (path === "/.well-known/oauth-protected-resource")
		return handleOauthProtectedResource();
	if (path === "/.well-known/oauth-authorization-server") return handleOauthAuthServer();
	if (path === "/auth.md") return handleAuthMd(env);
	if (path === "/.well-known/mcp/server-card.json") return handleMcpServerCard(env);
	if (path === "/.well-known/agent-skills/index.json")
		return await handleAgentSkillsIndex();
	const skillMatch = path.match(
		/^\/\.well-known\/agent-skills\/([a-z0-9-]+)\/SKILL\.md$/,
	);
	if (skillMatch) return handleAgentSkill(skillMatch[1]);
	if (path === "/webmcp.js") return handleWebMcpJs();
	return null;
}

// ─── WebMCP page tools ───

// Served as /webmcp.js and loaded by the HTML pages. Feature-detects
// navigator.modelContext (WebMCP draft); a browser without it is unaffected.
// Tools are read-only and hit only the public keyless endpoints.
const WEBMCP_JS = `(function () {
  'use strict';
  var mc = typeof navigator !== 'undefined' && navigator.modelContext;
  if (!mc || typeof mc.provideContext !== 'function') return; // no WebMCP: no-op
  function getJson(path) {
    return fetch(path, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + path);
      return r.json();
    }).then(function (d) {
      return { content: [{ type: 'text', text: JSON.stringify(d) }] };
    });
  }
  try {
    mc.provideContext({
      tools: [
        {
          name: 'getMorPrice',
          description: 'Get the live MOR token price in USD with 24h change and market cap, read on-chain from the Base DEX by MorScan. Free public data.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          execute: function () { return getJson('/mor/v1/price'); }
        },
        {
          name: 'getNetworkHealth',
          description: 'Get MorScan sync and service health: indexed block vs chain head, blocks behind, last sync time, dataset coverage.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          execute: function () { return getJson('/health'); }
        },
        {
          name: 'getNetworkStats',
          description: 'Get summary Morpheus network stats from MorScan: provider count, model bids, active and total sessions.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          execute: function () { return getJson('/teaser'); }
        }
      ]
    });
  } catch (e) { /* WebMCP registration must never break the page */ }
})();
`;

/** GET /webmcp.js - WebMCP tool registration script (self-hosted, CSP-safe). */
export function handleWebMcpJs(): Response {
	return new Response(WEBMCP_JS, {
		headers: {
			"Content-Type": "application/javascript; charset=utf-8",
			"Cache-Control": CACHE_1H,
		},
	});
}
