/**
 * Markdown content negotiation for the main HTML pages.
 *
 * Requests with `Accept: text/markdown` to /, /about, /contribute, and /stake
 * get a faithful markdown rendering of the same page (same canonical data -
 * the landing version carries the live SSR numbers from the shared metrics
 * source). Responses are `Content-Type: text/markdown` with `Vary: Accept` so
 * downstream caches split HTML vs markdown; inside the worker the markdown
 * branch is routed BEFORE the HTML page cache so the two can never mix.
 */

import type { Env } from "../types";
import { baseUrl } from "../config";
import { MORSCAN_VERSION } from "../version";
import { getNetworkMetrics } from "../utils/metrics";
import { getCachedPrice } from "./ui/shared";

const MD_PATHS = ["/", "/about", "/contribute", "/stake"];

/** True when the client asked for markdown (Accept: text/markdown). */
export function wantsMarkdown(request: Request, path: string): boolean {
	if (!MD_PATHS.includes(path)) return false;
	const accept = request.headers.get("Accept") || "";
	return accept.includes("text/markdown");
}

function md(body: string): Response {
	return new Response(body, {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "public, max-age=60, s-maxage=60",
			"Access-Control-Allow-Origin": "*",
			Vary: "Accept",
		},
	});
}

async function landingMd(env: Env): Promise<string> {
	// Same canonical sources the HTML SSR stats use (one KV read, one D1 read).
	let stats = "";
	try {
		const [price, metrics] = await Promise.all([
			getCachedPrice(env),
			getNetworkMetrics(env),
		]);
		const nf = new Intl.NumberFormat("en-US");
		const priceLine =
			price && price.usd > 0
				? `- MOR price: $${price.usd.toFixed(2)} (${price.change24h >= 0 ? "+" : ""}${price.change24h.toFixed(2)}% 24h)`
				: "- MOR price: see /mor/v1/price";
		const mcap =
			price && price.marketCap >= 1e6
				? `- Market cap: $${(price.marketCap / 1e6).toFixed(1)}M`
				: "";
		stats = `## Morpheus network at a glance (live)

${priceLine}
${mcap}
- Providers: ${nf.format(metrics.providers)}
- Active sessions: ${nf.format(metrics.activeSessions)}
- Total sessions: ${nf.format(metrics.totalSessions)}
- MOR staked: ${nf.format(metrics.morStaked)} MOR

Live on-chain data from Base, indexed by MorScan and signed with Ed25519
provenance receipts so every number is independently verifiable.
`;
	} catch {
		stats = "";
	}
	const b = baseUrl();
	return `# MorScan - Morpheus AI Block Explorer

Providers, models, sessions, staking, and MOR pricing on Base - indexed in
real time, verified with signed provenance receipts. Free and open.

${stats}
## What is Morpheus?

Morpheus is a decentralized AI (dAI) network: a permissionless AI inference
and compute marketplace on Base, an Ethereum L2. Providers run AI models and
post per-second bids, consumers stake MOR to open inference sessions, and
builder subnets earn MOR emissions. The MOR token is capped at 42,000,000,
and every bid, session, and stake settles on public smart contracts.

MorScan is the block explorer and real-time API for that economy. It indexes
the Morpheus contracts on Base, turns raw events into live analytics, and
signs every response, so every number is independently verifiable.

## Explore

- Explorer: ${b}/analytics/overview
- Compute (network, providers, consumers): ${b}/compute/network
- Builder subnets: ${b}/builder/subnets
- MOR holders: ${b}/holders/all
- Staking pools: ${b}/pools
- API playground: ${b}/api/playground

## For agents

- API guide + key registration: ${b}/auth.md
- OpenAPI 3.1 spec: ${b}/openapi.json
- llms.txt: ${b}/llms.txt
- API catalog (RFC 9727): ${b}/.well-known/api-catalog
- Agent skills: ${b}/.well-known/agent-skills/index.json
- Health: ${b}/health

## Support

MorScan is free for everyone. If it is useful to you, back it by staking MOR
on the MorScan builder subnet - your principal stays yours: ${b}/stake

Fair Source (FSL-1.1-MIT): https://github.com/DRM3Labs-OSS/morscan.io
MorScan v${MORSCAN_VERSION}, developed and operated by DRM3 Labs.
`;
}

function aboutMd(): string {
	const b = baseUrl();
	return `# About MorScan

MorScan is a real-time block explorer for the Morpheus AI network on Base L2.
It indexes Morpheus compute, builder, and token contracts and serves a signed
REST API plus a dashboard covering providers, models and their bids, sessions,
builder subnets, MOR holders, and a full OpenAPI playground.

## What you can see

- Sessions: every inference session - open, active, and closed - with its model, stake, and duration
- Models and bids: the models on offer and each provider's per-second price
- Providers and consumers: who serves compute and who buys it, with live demand and economics
- Builder subnets: emissions leaderboard, per-subnet MOR flow, emissions calculator
- Holders: MOR holders ranked by balance, classified by on-chain role
- API: OpenAPI 3.1 spec, interactive playground, every dashboard surface queryable

## What is Morpheus?

Morpheus is a decentralized AI (dAI) network: a permissionless AI inference
marketplace on Base. Providers run AI models and post bids stating what they
charge; consumers stake MOR to open inference sessions against those bids;
builder subnets let projects earn MOR emissions through staking. All of it
settles on public smart contracts.

## How it stays current

MorScan indexes Morpheus contract events as they land. Base produces a block
about every 2 seconds, so the index normally runs only a few blocks behind the
chain head. ${b}/health reports the exact gap at any moment.

## Provenance

Every API response is cryptographically signed with two Ed25519 keys
(morscan/cache for indexed on-chain state, morscan/signer for derived
aggregates). Each row carries a receipt that chains back to the DRM3 root.
Public keys: ${b}/.well-known/morscan-keys.json

## Contracts (Base L2)

- Morpheus Diamond: 0x6aBE1d282f72B474E54527D93b979A4f64d3030a
- Morpheus Builder: 0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9
- MOR Token: 0x7431aDa8a591C955a994a21710752EF9b882b8e3

## Who builds it

MorScan is developed, maintained, and operated by DRM3 Labs
(https://drm3.network). It is Fair Source under FSL-1.1-MIT:
https://github.com/DRM3Labs-OSS/morscan.io - contributions welcome
(${b}/contribute). Support the project by staking MOR on the MorScan subnet:
${b}/stake
`;
}

function contributeMd(): string {
	const b = baseUrl();
	return `# Contribute to MorScan

MorScan is source-open, and we love pull requests. It is the same code that
runs ${b}, so anything you fix or build here ships for everyone.

- Repo: https://github.com/DRM3Labs-OSS/morscan.io
- Issues: https://github.com/DRM3Labs-OSS/morscan.io/issues
- Contributor guide: https://github.com/DRM3Labs-OSS/morscan.io/blob/main/CONTRIBUTING.md

## Feedback and feature requests

Comments, concerns, feedback, and feature requests all live in GitHub issues:
https://github.com/DRM3Labs-OSS/morscan.io/issues - open one and say what you
saw and what you expected. We read them.

## The license, plainly

Fair Source: FSL-1.1-MIT - free to use, fork, and self-host; no competing
hosted service for 2 years; every release becomes MIT after two years,
guaranteed. For contributors that changes nothing: fork, branch, send a PR.

Want more than the license grants? Hosted offerings, commercial embedding, or MIT rights ahead of the two-year date: commercial licenses are available at morscan@drm3.io. Self-hosting and building your own providers never need one.

## Run it locally

One small codebase. Node.js 22+ and npm required; stack details are in the
README.

\`\`\`bash
git clone https://github.com/DRM3Labs-OSS/morscan.io.git
cd morscan.io
npm install
npm run dev        # local worker at http://localhost:8787

# before you open a PR, keep these green:
npm run typecheck  # tsc --noEmit
npm run lint       # biome lint src/
npm run build      # wrangler deploy --dry-run
\`\`\`

First-run setup is in docs/GETTING_STARTED.md. The explorer runs without
provenance signing, so no secrets are needed for a working local instance.

Style and workflow details are in CONTRIBUTING.md; CI runs the same checks
you run locally. Security issues go through SECURITY.md, not a public issue.
`;
}

function stakeMd(): string {
	const b = baseUrl();
	return `# Support MorScan - Stake MOR

MorScan is free and open to everyone: no account, no paywall, source-open.
Staking MOR on the MorScan builder subnet is how you keep it that way.

It is not a donation - you keep your MOR. Staking supports the project
through builder emissions while your principal stays yours.

## Where it goes

Stake on the MorScan subnet earns the project a proportional share of the
network's builder emissions pool. Those emissions fund sync infrastructure and
RPC capacity, hosting, monitoring, and continued development.

## What you get

API capacity: 1 MOR staked = 3 requests/min of burst capacity, plus daily and
monthly volume caps that rise with your stake (the daily cap is 5% of the
monthly cap; burst tops out at 10,000/min).

| Tier | Burst/min | Per day | Per month |
| --- | --- | --- | --- |
| Connected wallet (free) | 60 | 2,000 | 40,000 |
| 100 MOR staked | 300 | 5,000 | 100,000 |
| 500 MOR | 1,500 | 37,500 | 750,000 |

Every stake is public on-chain and shows on the backers wall at ${b}/stake.

## How to stake

1. Connect your wallet at ${b}/console - one signed message, nothing spent,
   and it issues your personal API key at the free tier.
2. Stake MOR on the MorScan subnet from that same wallet via the Morpheus
   dashboard: https://dashboard.mor.org/builders/morscan?subnet_id=0xe100f9d7c463008e46887113fa14bc0ba9caaf90d4465835795f53ebe5056059&network=Base
3. Capacity follows automatically - limits re-check against your live on-chain
   stake every minute. Unstake and they fall back; your principal stays yours.

## Good to know

- Unstaking from the MorScan subnet has a 90 day lock (this subnet's setting;
  the protocol minimum is 7 days and other subnets vary).
- Per-minute limits are exact; daily/monthly volume caps are enforced within
  a few minutes.
- Your MOR stays yours: staking is support, not a payment or donation.

Live subnet stats: ${b}/builder/subnet/0xe100f9d7c463008e46887113fa14bc0ba9caaf90d4465835795f53ebe5056059
`;
}

/** Serve the markdown rendering for a page path, or null if not covered. */
export async function handleMarkdownPage(
	path: string,
	env: Env,
): Promise<Response | null> {
	if (path === "/") return md(await landingMd(env));
	if (path === "/about") return md(aboutMd());
	if (path === "/contribute") return md(contributeMd());
	if (path === "/stake") return md(stakeMd());
	return null;
}
