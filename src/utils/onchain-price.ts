/**
 * On-chain MOR/USD pricing - read straight from the Base DEX via the RPC pool.
 *
 * Why this exists: MorScan used to read MOR/USD and ETH/USD from CoinGecko.
 * CoinGecko rate-limits by IP, and our whole fleet shares a small set of
 * Cloudflare Worker egress IPs, so the shared quota kept getting exhausted and
 * the price went stale/delayed. Reading the price directly from the on-chain
 * DEX pool has no external rate limit - it rides the same free public Base RPC
 * pool (RPC_ENDPOINTS, with per-call failover across every endpoint) that the
 * rest of the explorer already uses for eth_getLogs / eth_call. No new RPC
 * path, no paid provider.
 *
 * Price source (documented constants below):
 *   MOR/WETH  -> Uniswap v3 0.3% pool slot0() sqrtPriceX96
 *   ETH/USD   -> Chainlink ETH/USD aggregator on Base (latestRoundData)
 *   MOR/USD   = (WETH per MOR) x (ETH/USD)
 *
 * How the pool was found (2026-07-03, reproducible via scripts):
 *   - eth_call the Uniswap v3 factory (0x33128a8fC17869897dcE68Ed026d694621f6FDfD)
 *     getPool(MOR, WETH, fee) across fee tiers 100/500/3000/10000, and the
 *     Aerodrome factory (0x420DD381b31aEf6683db6B902084cB0FFECe40Da)
 *     getPool(MOR, <WETH|USDC>, stable) - then compared MOR balanceOf each pool.
 *   - The Uniswap v3 MOR/WETH 0.3% pool below held ~14.4K MOR + ~16.3 WETH
 *     (~$30K), by far the deepest. No Aerodrome MOR pool existed. No MOR/USDC
 *     pool held meaningful liquidity. So this is the canonical price source.
 *   - Verified token0()/token1() on the pool: token0 = WETH, token1 = MOR.
 */

import {
	getLatestPriceHistoryTs,
	getPriceHistoryPointNear,
	insertPriceHistoryPoint,
} from "../db/ops";
import type { Env } from "../types";
import { RPC_ENDPOINTS } from "../sync/parsers-rpc";

// MOR token on Base (ERC-20, 18 decimals - verified on-chain).
export const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";
// WETH on Base (18 decimals).
export const WETH_TOKEN = "0x4200000000000000000000000000000000000006";

// The MOR price source: Uniswap v3 MOR/WETH 0.3% pool on Base.
// token0 = WETH, token1 = MOR (both 18 decimals). See file header for how this
// was discovered and verified. Deepest MOR pool on Base as of 2026-07-03.
export const MOR_POOL_ADDRESS = "0x37ecd41f5a01b23a3d9bb3b4ddfef4ed455d6fd3";
// Orientation of the pool. token0 is WETH here, so MOR is token1.
const POOL_MOR_IS_TOKEN0 = false;

// Chainlink ETH/USD aggregator on Base (8 decimals - verified via decimals()).
// Robust, deep, and decimated feed; preferred over a WETH/USDC pool for ETH/USD.
export const CHAINLINK_ETH_USD = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const CHAINLINK_DECIMALS = 8n;

// Function selectors (keccak256(sig)[:4]).
const SEL_SLOT0 = "0x3850c7bd"; // slot0() on a Uniswap v3 pool
const SEL_LATEST_ROUND_DATA = "0xfeaf968c"; // latestRoundData() on a Chainlink aggregator

// Sanity bounds. On-chain reads have no rate limit but a mis-decoded word or a
// manipulated thin pool could still yield garbage; reject the absurd and let the
// caller fall back to the last good cached value.
const MOR_USD_MIN = 0.01;
const MOR_USD_MAX = 1000;
const ETH_USD_MIN = 100;
const ETH_USD_MAX = 100_000;

export interface OnchainPrice {
	morUsd: number;
	ethUsd: number;
	wethPerMor: number;
}

interface RpcCall {
	to: string;
	data: string;
}
interface RpcResp {
	id: number;
	result?: string;
	error?: { message: string };
}

/**
 * Batched eth_call to (possibly different) targets, walking the full RPC pool
 * per HTTP attempt. Returns results keyed by call index, or null if every
 * endpoint failed / any call errored. Reuses RPC_ENDPOINTS - the SAME failover
 * pool the sync path uses - plus the configured RPC_URL and Alchemy fallback.
 */
async function ethCallBatchMulti(
	env: Env,
	calls: RpcCall[],
	timeoutMs = 6000,
): Promise<string[] | null> {
	const endpoints = Array.from(
		new Set(
			[...RPC_ENDPOINTS, env.RPC_URL, env.ALCHEMY_FALLBACK_URL].filter(
				Boolean,
			) as string[],
		),
	);
	const body = calls.map((c, i) => ({
		jsonrpc: "2.0",
		method: "eth_call",
		id: i + 1,
		params: [{ to: c.to, data: c.data }, "latest"],
	}));

	for (const rpc of endpoints) {
		try {
			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!resp.ok) continue;
			const results = (await resp.json()) as RpcResp[];
			if (!Array.isArray(results)) continue;
			const map = new Map<number, string>();
			let ok = true;
			for (const r of results) {
				if (r.error || typeof r.result !== "string" || r.result === "0x") {
					ok = false;
					break;
				}
				map.set(r.id, r.result);
			}
			if (!ok || map.size !== calls.length) continue;
			return calls.map((_, i) => map.get(i + 1) as string);
		} catch {
			// try next endpoint
		}
	}
	return null;
}

/**
 * Decode MOR/USD + ETH/USD from the raw slot0() and latestRoundData() return
 * words. Pure (no I/O): this is the single source of the price formula, shared
 * by the live read (readOnchainPrice) and the historical backfill
 * (tools/price-backfill) so both compute MOR/USD identically. `slot0` is the
 * Uniswap v3 pool slot0() return; `roundData` is the Chainlink
 * latestRoundData() return. Returns null on a zero/absurd read so the caller can
 * skip the sample or fall back to a cached value.
 */
export function decodeOnchainPrice(
	slot0: string,
	roundData: string,
): OnchainPrice | null {
	try {
		// slot0(): first 32-byte word is sqrtPriceX96 (uint160, fits in the word).
		const sqrtPriceX96 = BigInt(`0x${slot0.slice(2, 66)}`);
		if (sqrtPriceX96 <= 0n) return null;

		// Uniswap v3: price(token1 per token0) = (sqrtPriceX96 / 2^96)^2, with a
		// 10^(dec0-dec1) decimal adjustment. Both tokens are 18 decimals here, so no
		// adjustment. Scale by 1e18 in BigInt space to keep precision, then to float.
		const Q192 = 2n ** 192n;
		const scaled = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / Q192; // token1PerToken0 * 1e18
		const token1PerToken0 = Number(scaled) / 1e18;
		if (!(token1PerToken0 > 0)) return null;
		// token0 = WETH, token1 = MOR, so token1PerToken0 = MOR per WETH.
		const wethPerMor = POOL_MOR_IS_TOKEN0 ? token1PerToken0 : 1 / token1PerToken0;

		// Chainlink latestRoundData(): word[1] = answer (int256, positive for a price).
		const answer = BigInt(`0x${roundData.slice(2 + 64, 2 + 128)}`);
		if (answer <= 0n) return null;
		const ethUsd = Number(answer) / Number(10n ** CHAINLINK_DECIMALS);

		const morUsd = wethPerMor * ethUsd;

		if (!(morUsd >= MOR_USD_MIN && morUsd <= MOR_USD_MAX)) return null;
		if (!(ethUsd >= ETH_USD_MIN && ethUsd <= ETH_USD_MAX)) return null;

		return { morUsd, ethUsd, wethPerMor };
	} catch {
		return null;
	}
}

/**
 * Read MOR/USD and ETH/USD directly from the Base DEX pool + Chainlink feed.
 * One batched RPC round-trip (slot0 + latestRoundData), full-pool failover.
 * Returns null if the read fails or the result is outside sane bounds.
 */
export async function readOnchainPrice(env: Env): Promise<OnchainPrice | null> {
	const results = await ethCallBatchMulti(env, [
		{ to: MOR_POOL_ADDRESS, data: SEL_SLOT0 },
		{ to: CHAINLINK_ETH_USD, data: SEL_LATEST_ROUND_DATA },
	]);
	if (!results) return null;
	const [slot0, roundData] = results;
	return decodeOnchainPrice(slot0, roundData);
}

// --- Our own price history (the durable part) --------------------------------
// price_history(ts, usd, eth_usd) is written by us from the on-chain read, so
// MorScan owns its price series over time with zero external dependency. We
// dedupe to ~1 point per 10 minutes to keep the table light (the minute cron
// and on-demand /price reads both call recordPriceHistory).

const HISTORY_MIN_SPACING_SEC = 600; // ~10 min between recorded points

/**
 * Record one on-chain price point into price_history, deduped to the min spacing.
 * Best-effort: never throws. Pass an already-read price to avoid a second RPC
 * round-trip, or omit it to read on-chain here.
 */
export async function recordPriceHistory(
	env: Env,
	price?: OnchainPrice | null,
): Promise<void> {
	try {
		const nowSec = Math.floor(Date.now() / 1000);
		const last = await getLatestPriceHistoryTs(env.DB);
		if (last && nowSec - last.ts < HISTORY_MIN_SPACING_SEC) return; // too soon

		const p = price ?? (await readOnchainPrice(env));
		if (!p) return;

		await insertPriceHistoryPoint(
			env.DB,
			nowSec,
			Math.round(p.morUsd * 1e6) / 1e6,
			Math.round(p.ethUsd * 100) / 100,
		);
	} catch {
		// history is best-effort; never let it break a request or a tick
	}
}

/**
 * 24h change (%) computed from OUR price_history: latest price vs the point
 * closest to 24h ago (within a +/- 3h window). Returns null until we have both
 * a recent point and a ~24h-old point, so callers can fall back to a seeded
 * value on day one.
 */
export async function getChange24hFromHistory(
	env: Env,
	currentUsd: number,
): Promise<number | null> {
	try {
		const target = Math.floor(Date.now() / 1000) - 86_400;
		const row = await getPriceHistoryPointNear(
			env.DB,
			target - 10_800,
			target + 10_800,
			target,
		);
		if (!row || !(row.usd > 0)) return null;
		return ((currentUsd - row.usd) / row.usd) * 100;
	} catch {
		return null;
	}
}
