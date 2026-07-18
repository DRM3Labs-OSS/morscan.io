/**
 * LLMs.txt Handler - machine-readable site descriptions for AI agents.
 *
 * Serves /llms.txt (summary) and /llms-full.txt (with response examples).
 * Plain text, publicly cached for 24 hours, no auth required.
 *
 * All absolute URLs are derived from the configured PUBLIC_BASE_URL (see
 * src/config.ts) so they reflect wherever the explorer is actually deployed.
 */

import { baseUrl } from "../config";
import { listModelSlugs } from "./model-detail";
import { accessDoorsMarkdown } from "../providers/commerce/offers";
import type { Env } from "../types";

const PLAIN_HEADERS = {
	"Content-Type": "text/plain; charset=utf-8",
	"Cache-Control": "public, max-age=86400",
	"Access-Control-Allow-Origin": "*",
};

const llmsTxt = async (env: Env) => `# MorScan
> Morpheus blockchain explorer and real-time API by DRM3 Labs. A real-time indexed data source for the Morpheus AI network on Base. All data sourced from attested on-chain state with cryptographic provenance receipts.

## What It Is
MorScan indexes Morpheus compute, builder, and token contracts on Base L2 and serves instant API responses. It tracks AI compute providers, model marketplace bids, MOR token staking sessions, builder subnets, token pricing, and network economics. Data is indexed in real time and every API response is signed with a provenance receipt for auditability.

## For Agents (quickstart)
- Auth: send X-Morscan-Key on every /mor/v1/* request (exception: /mor/v1/price is public)

Access (every listed door is live today):
${await accessDoorsMarkdown(env)}

- Errors: 200 success; 401 invalid key; 402 keyless on a metered endpoint (x402 payment envelope - pay per call or mint the free key); 429 over your per-minute budget or a day/month volume cap (day caps reset 00:00 UTC), Retry-After header set; 500 unexpected, retry with backoff, check /health
- Pagination: list endpoints return at most 100 rows per page (limit clamped server-side, applied value echoed in pagination meta); use page to paginate, max depth 1000
- Provenance: every response row carries a _receipt id and responses are Ed25519-signed; public keys at ${baseUrl()}/.well-known/morscan-keys.json for offline verification; human-facing in-browser check at ${baseUrl()}/verify
- Registration + limits guide (markdown): ${baseUrl()}/auth.md
- API catalog (RFC 9727): ${baseUrl()}/.well-known/api-catalog
- Agent skills (task-level how-tos with sha256-pinned docs): ${baseUrl()}/.well-known/agent-skills/index.json
- MCP server card (HTTP API integration point; no MCP JSON-RPC transport today): ${baseUrl()}/.well-known/mcp/server-card.json
- Markdown pages: GET /, /about, /contribute, /stake with "Accept: text/markdown" returns markdown

## Getting a Key
Connect a wallet at ${baseUrl()}/console - signing a challenge message is the
whole registration and issues your personal key immediately. Fully headless
works too (no browser): GET /console/wallet/challenge, sign the returned
message with EIP-191 personal_sign, POST the result to /console/wallet/verify -
the 3-step recipe with examples is in ${baseUrl()}/auth.md. Staking MOR on the
MorScan builder subnet raises that same key's capacity. Pass the key via the
X-Morscan-Key header on all /mor/v1/* requests.

## API Endpoints

### No Auth Required
- GET /health - service status, block heights, sync lag, version
- GET /mor/v1/price - MOR/USD read on-chain from the Base DEX (Uniswap v3 MOR/WETH), ETH/USD from Chainlink on Base (~30s cache)
- GET /chart.svg - pre-rendered 90-day MOR price chart (SVG)
- GET /teaser - public summary stats for the login page
- GET /openapi.json - OpenAPI 3.1 specification
- GET /llms.txt - this file
- GET /llms-full.txt - extended version with response examples
- GET /auth.md - how agents register and authenticate (markdown)
- GET /.well-known/api-catalog - RFC 9727 API catalog linkset
- GET /.well-known/agent-skills/index.json - agent skill docs index
- GET /.well-known/mcp/server-card.json - MCP-style server card (describes the HTTP API)

### Marketplace (X-Morscan-Key required)
- GET /mor/v1/all - full marketplace state (providers, bids, models, economics)
- GET /mor/v1/providers - registered AI compute providers
- GET /mor/v1/providers/:address - provider detail (bids, sessions, reputation)
- GET /mor/v1/bids - all model bids with pricing

### Sessions and Analytics (X-Morscan-Key required)
- GET /mor/v1/sessions - all sessions (paginated)
- GET /mor/v1/sessions/:wallet - sessions for a specific wallet
- GET /mor/v1/sessions/analytics - per-wallet analytics
- GET /mor/v1/sessions/daily - daily session counts (30-day history)
- GET /mor/v1/wallet/:wallet - full wallet detail with balances
- GET /mor/v1/wallet/:wallet/transactions - wallet transaction history
- GET /mor/v1/wallet/:wallet/gas - wallet gas cost breakdown
- GET /mor/v1/analytics - gas costs, network economics

### Models (X-Morscan-Key required)
- GET /mor/v1/models - all registered models with names
- GET /mor/v1/models/lookup - model ID to name mapping
- GET /mor/v1/models/demand - model demand heatmap (sessions, pricing, providers)
- GET /mor/v1/models/:modelId - model name and description
- GET /mor/v1/models/:modelId/detail - the canonical-model picture: every on-chain listing of the model aggregated (any listing id of the model returns the same content) - description, active bids with providers and pricing, session demand + 30-day daily series, per-provider reputation, the listing inventory with web/TEE capability flags, and the model family rollup. Human page: /compute/models/:modelId

### Provider Reputation (X-Morscan-Key required)
- GET /mor/v1/reputation - all provider reputation scores
- GET /mor/v1/reputation/:provider - detailed reputation for a provider
- GET /mor/v1/disputes - recent disputed sessions
- GET /mor/v1/leaderboard - top providers and wallets

### Pricing (X-Morscan-Key required)
- GET /mor/v1/price/chart - 90-day price history data

### Provenance (X-Morscan-Key required)
- GET /mor/v1/provenance - audit trail of signed API responses (receipt chain, signer public key)

### Sync Status (X-Morscan-Key required)
- GET /mor/v1/sync-status - blockchain sync state

## Provenance
Every API response from MorScan is signed with a cryptographic provenance receipt. Receipts form a hash chain for auditability. Query the receipt chain at /mor/v1/provenance.

## Links
- Explorer: ${baseUrl()}
- OpenAPI Spec: ${baseUrl()}/openapi.json
- Agent auth guide: ${baseUrl()}/auth.md
- API catalog: ${baseUrl()}/.well-known/api-catalog
- Feedback and feature requests: https://github.com/DRM3Labs-OSS/morscan.io/issues`;

const llmsFullTxt = async (env: Env) => `${await llmsTxt(env)}

## Response Examples

### GET /mor/v1/all
Returns the full marketplace state: all providers with their active and retracted bids, session statistics, network economics, and staking data.

\`\`\`json
{
  "meta": {
    "lastBlock": 43500000,
    "currentBlock": 43500005,
    "startBlock": 24386400,
    "lastSync": "2026-03-24T12:00:00.000Z",
    "blocksBehind": 5
  },
  "providerCount": 12,
  "totalBids": 45,
  "totalRetractedBids": 8,
  "activeSessions": 3,
  "totalSessions": 150,
  "totalSuccessful": 120,
  "totalDisputed": 5,
  "totalEarlyTermination": 10,
  "morStaked": "250.00",
  "morStakedWei": "250000000000000000000",
  "economics": {
    "computeBalance": 500000,
    "stakingFactor": 0.00315,
    "todaysBudget": 3456,
    "updatedAt": "2026-03-24T12:00:00.000Z"
  },
  "providers": [
    {
      "address": "0x1234...abcd",
      "endpoint": "https://provider.example.com",
      "bidCount": 5,
      "retractedBidCount": 1,
      "totalSessions": 30,
      "successCount": 28,
      "bids": [
        {
          "bidId": "0xabc123...",
          "modelId": "0xdef456...",
          "model": "LLaMa 3.1 70B",
          "pricePerSecond": "1000000000000",
          "priceMorPerDay": "0.086400"
        }
      ]
    }
  ]
}
\`\`\`

### GET /mor/v1/price
Returns current MOR token price in USD with 24h change and market cap, plus ETH price. MOR/USD is read on-chain from the Base DEX (Uniswap v3 MOR/WETH pool) and ETH/USD from a Chainlink feed on Base; the response is provenance-signed. Cached ~30s. CoinGecko is only a last-resort fallback if the on-chain read fails.

\`\`\`json
{
  "usd": 12.45,
  "change24h": -3.21,
  "marketCap": 125000000,
  "eth": { "usd": 3450.00, "change24h": 1.5 },
  "cached": true,
  "fetchedAt": 1711324800
}
\`\`\`

### GET /mor/v1/sessions/:wallet
Returns all staking sessions for a specific wallet address, with active/expired status.

\`\`\`json
{
  "wallet": "0x1234...abcd",
  "total": 5,
  "active": 1,
  "sessions": [
    {
      "id": "0xsession123...",
      "userAddress": "0x1234...abcd",
      "provider": "0x5678...ef01",
      "modelId": "0xdef456...",
      "stake": "100000000000000000000",
      "openedAt": 1711000000,
      "endsAt": 1711086400,
      "isActive": true
    }
  ]
}
\`\`\`

### GET /mor/v1/models
Returns all models registered on the Morpheus ModelRegistry with human-readable names.

\`\`\`json
{
  "count": 8,
  "models": [
    { "modelId": "0xdef456...", "name": "LLaMa 3.1 70B", "description": "Meta LLaMa 3.1 70B parameter model" }
  ]
}
\`\`\``;

const robotsTxt =
	() => `# MorScan is a public block explorer for the Morpheus AI network on Base.
# Search engines, AI crawlers, and AI agents are welcome to fetch, read, index,
# and cite the public pages. Only sensitive auth/sync endpoints are disallowed.
#
# AI agents: a machine-readable guide to this site and its API lives at
# ${baseUrl()}/llms.txt (extended: /llms-full.txt); both are listed in the sitemap.
#
# Content signals (https://contentsignals.org): we affirmatively ALLOW use of
# this site's public content for search indexing (search=yes) and for real-time
# AI answering (ai-input=yes): retrieval, grounding, and citation in AI answers.
# No opt-out is declared.
User-agent: *
# Content-Signal: search=yes,ai-input=yes
Allow: /
Disallow: /login
Disallow: /logout
Disallow: /console
Disallow: /mor/v1/register-signer
Disallow: /sync/
Disallow: /trigger-sync

# AI crawlers and agents are explicitly welcome to read and cite the public
# content (search=yes, ai-input=yes; no opt-out).
User-agent: GPTBot
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: ChatGPT-User
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: OAI-SearchBot
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: ClaudeBot
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: Claude-Web
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: anthropic-ai
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: Claude-User
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: PerplexityBot
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: Google-Extended
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: Applebot-Extended
# Content-Signal: search=yes,ai-input=yes
Allow: /

User-agent: CCBot
# Content-Signal: search=yes,ai-input=yes
Allow: /

Sitemap: ${baseUrl()}/sitemap.xml`;

// Canonical UI pages - URIs mirror the parent/sub tab structure. Priorities
// rank the high-intent explorer + definitional surfaces above legal/utility.
const UI_PAGES: Array<{ path: string; priority: string; changefreq: string }> = [
	{ path: "/about", priority: "0.9", changefreq: "monthly" },
	{ path: "/verify", priority: "0.6", changefreq: "monthly" },
	{ path: "/analytics/overview", priority: "0.8", changefreq: "daily" },
	{ path: "/compute/network", priority: "0.8", changefreq: "daily" },
	{ path: "/compute/providers", priority: "0.8", changefreq: "daily" },
	{ path: "/compute/consumers", priority: "0.8", changefreq: "daily" },
	{ path: "/compute/sessions", priority: "0.8", changefreq: "daily" },
	{ path: "/builder/subnets", priority: "0.8", changefreq: "daily" },
	{ path: "/builder/calculator", priority: "0.6", changefreq: "weekly" },
	{ path: "/holders/all", priority: "0.8", changefreq: "daily" },
	{ path: "/holders/dust", priority: "0.5", changefreq: "daily" },
	{ path: "/pools", priority: "0.7", changefreq: "daily" },
	{ path: "/api/playground", priority: "0.7", changefreq: "weekly" },
	{ path: "/api/docs", priority: "0.7", changefreq: "weekly" },
	{ path: "/stake", priority: "0.6", changefreq: "weekly" },
	{ path: "/contribute", priority: "0.5", changefreq: "monthly" },
	{ path: "/terms", priority: "0.3", changefreq: "yearly" },
	{ path: "/privacy", priority: "0.3", changefreq: "yearly" },
];

const sitemapXml = (modelSlugs: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl()}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${UI_PAGES.map(
	(p) => `  <url>
    <loc>${baseUrl()}${p.path}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
).join("\n")}
  <url>
    <loc>${baseUrl()}/health</loc>
    <changefreq>always</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>${baseUrl()}/llms.txt</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl()}/llms-full.txt</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl()}/openapi.json</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl()}/auth.md</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl()}/.well-known/api-catalog</loc>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
${modelSlugs
	.map(
		(slug) => `  <url>
    <loc>${baseUrl()}/compute/models/${slug}</loc>
    <changefreq>daily</changefreq>
    <priority>0.6</priority>
  </url>`,
	)
	.join("\n")}
</urlset>`;

export async function handleLlmsTxt(env: Env): Promise<Response> {
	return new Response(await llmsTxt(env), { headers: PLAIN_HEADERS });
}

export async function handleLlmsFullTxt(env: Env): Promise<Response> {
	return new Response(await llmsFullTxt(env), { headers: PLAIN_HEADERS });
}

export function handleRobotsTxt(): Response {
	return new Response(robotsTxt(), {
		headers: { ...PLAIN_HEADERS, "Content-Signal": "search=yes,ai-input=yes" },
	});
}

export async function handleSitemapXml(env: Env): Promise<Response> {
	// Canonical model pages ride the sitemap so the pretty slug URLs are the
	// ones crawlers discover; fail-soft to the static set if the read breaks.
	let modelSlugs: string[] = [];
	try {
		modelSlugs = await listModelSlugs(env);
	} catch {}
	return new Response(sitemapXml(modelSlugs), {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=86400",
			"Access-Control-Allow-Origin": "*",
		},
	});
}
