/**
 * RPC utilities for blockchain queries
 */

import { getSyncStateValue } from "../db/ops";
import type { Env } from "../types";
import { MORSCAN_VERSION } from "../version";

const FALLBACK_RPCS = [
	// Wide-range, no-auth, reliable under load (proven for backfill getLogs too).
	"https://base.gateway.tenderly.co",
	"https://mainnet.base.org",
	"https://base.llamarpc.com",
	"https://base-rpc.publicnode.com",
	"https://base.drpc.org",
	"https://1rpc.io/base",
];

/** Parse hex string to integer, returning NaN guard value 0 on failure. */
export function safeParseHex(hex: string): number {
	if (!hex || hex === "0x") return 0;
	const n = parseInt(hex, 16);
	return Number.isNaN(n) ? 0 : n;
}

// Get current block number with RPC fallback
export async function getCurrentBlock(env: Env): Promise<number> {
	const endpoints = [env.RPC_URL, ...FALLBACK_RPCS];
	for (const rpc of endpoints) {
		try {
			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "eth_blockNumber",
					params: [],
					id: 1,
				}),
				signal: AbortSignal.timeout(2000),
			});
			const data = (await resp.json()) as { result?: string };
			if (data.result) {
				const block = safeParseHex(data.result);
				if (block > 0) return block;
			}
		} catch {
			/* try next RPC */
		}
	}
	throw new Error("All RPC endpoints failed for eth_blockNumber");
}

// 2026-04-27: Fetches REAL currentBlock from RPC instead of estimating from wall clock.
// The old estimation hid a 181,000-block stall behind "blocksBehind: 4" for 4 days.
// getCurrentBlock() is called once per health check (~30s cache), not per sync tick.
export async function getSyncState(env: Env): Promise<{
	lastBlock: number;
	currentBlock: number;
	startBlock: number;
	lastSyncTs: string;
}> {
	try {
		const [lastResult, startResult, tsResult, currentBlock] = await Promise.all([
			getSyncStateValue(env.DB, "last_block"),
			getSyncStateValue(env.DB, "start_block"),
			getSyncStateValue(env.DB, "last_sync_ts"),
			getCurrentBlock(env).catch(() => 0),
		]);
		const lastBlock = lastResult ? parseInt(lastResult.value as string, 10) : 0;
		const startBlock = startResult ? parseInt(startResult.value as string, 10) : 42400000;
		const lastSyncTs = tsResult ? (tsResult.value as string) : new Date().toISOString();
		// Fall back to wall-clock estimate only if RPC fails completely
		const chainHead =
			currentBlock > 0
				? currentBlock
				: lastBlock +
					Math.floor((Date.now() / 1000 - new Date(lastSyncTs).getTime() / 1000) / 2);
		return { lastBlock, currentBlock: chainHead, startBlock, lastSyncTs };
	} catch {
		const estimated = 42400000 + Math.floor((Date.now() / 1000 - 1700000000) / 2);
		return {
			lastBlock: estimated,
			currentBlock: estimated,
			startBlock: 42400000,
			lastSyncTs: new Date().toISOString(),
		};
	}
}

// Build response metadata
export function buildMeta(
	lastBlock: number,
	currentBlock: number,
	startBlock?: number,
	lastSyncTs?: string,
) {
	return {
		currentBlock,
		syncedBlock: lastBlock,
		startBlock: startBlock || 42400000,
		blocksBehind: currentBlock - lastBlock,
		lastSyncTs: lastSyncTs || new Date().toISOString(),
		timestamp: new Date().toISOString(),
		morscanVersion: MORSCAN_VERSION,
	};
}

// MOR token contract on Base
const MOR_TOKEN = "0x7431aDa8a591C955a994a21710752EF9b882b8e3";

// Get MOR balance of marketplace contract (total staked)
export async function getMarketplaceMorBalance(
	env: Env,
): Promise<{ balance: string; balanceFormatted: string }> {
	const diamondPadded = env.DIAMOND_ADDRESS.toLowerCase()
		.replace("0x", "")
		.padStart(64, "0");
	const data = `0x70a08231${diamondPadded}`; // balanceOf(address)

	const resp = await fetch(env.RPC_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "eth_call",
			id: 1,
			params: [{ to: MOR_TOKEN, data }, "latest"],
		}),
	});
	const rpcResp = (await resp.json()) as { result?: string };
	if (!rpcResp.result || rpcResp.result === "0x") {
		return { balance: "0", balanceFormatted: "0.00" };
	}

	const balanceWei = BigInt(rpcResp.result);
	const balanceMor = Number(balanceWei) / 1e18;
	return {
		balance: balanceWei.toString(),
		balanceFormatted: balanceMor.toFixed(2),
	};
}

// Get wallet balances: MOR token balance + ETH balance (with RPC fallback)
export async function getWalletBalances(
	env: Env,
	wallet: string,
): Promise<{
	morBalance: string;
	morBalanceFormatted: string;
	ethBalance: string;
	ethBalanceFormatted: string;
}> {
	const walletPadded = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
	const morData = `0x70a08231${walletPadded}`; // balanceOf(address)

	// Batch both calls
	const batchCalls = [
		{
			jsonrpc: "2.0",
			method: "eth_call",
			id: 1,
			params: [{ to: MOR_TOKEN, data: morData }, "latest"],
		},
		{ jsonrpc: "2.0", method: "eth_getBalance", id: 2, params: [wallet, "latest"] },
	];

	// Try primary RPC first, then fallbacks
	const endpoints = [env.RPC_URL, ...FALLBACK_RPCS];
	for (const rpc of endpoints) {
		try {
			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(batchCalls),
			});
			const results = (await resp.json()) as Array<{ id: number; result?: string }>;

			let morBalance = "0",
				morBalanceFormatted = "0.00";
			let ethBalance = "0",
				ethBalanceFormatted = "0.0000";
			let gotMor = false;

			for (const r of results) {
				if (r.id === 1 && r.result && r.result !== "0x") {
					const morWei = BigInt(r.result);
					morBalance = morWei.toString();
					morBalanceFormatted = (Number(morWei) / 1e18).toFixed(2);
					gotMor = true;
				}
				if (r.id === 2 && r.result) {
					const ethWei = BigInt(r.result);
					ethBalance = ethWei.toString();
					ethBalanceFormatted = (Number(ethWei) / 1e18).toFixed(4);
				}
			}

			// If we got at least the MOR balance, return. Otherwise try next RPC.
			if (gotMor) {
				return { morBalance, morBalanceFormatted, ethBalance, ethBalanceFormatted };
			}
		} catch {
			// Try next RPC
		}
	}

	// All RPCs failed
	return {
		morBalance: "0",
		morBalanceFormatted: "0.00",
		ethBalance: "0",
		ethBalanceFormatted: "0.0000",
	};
}

// Get user stakes on hold from Diamond contract
// getUserStakesOnHold(address user, uint8 iterations) returns (uint256 available_, uint256 hold_)
// Selector: 0x967885df
export async function getUserStakesOnHold(
	env: Env,
	wallet: string,
): Promise<{
	available: string;
	availableFormatted: string;
	onHold: string;
	onHoldFormatted: string;
}> {
	const walletPadded = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
	// iterations = 255 (0xff) to get all stakes, padded to 32 bytes
	const iterationsPadded = "ff".padStart(64, "0");
	const data = `0x967885df${walletPadded}${iterationsPadded}`;

	const endpoints = [env.RPC_URL, ...FALLBACK_RPCS];
	for (const rpc of endpoints) {
		try {
			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "eth_call",
					id: 1,
					params: [{ to: env.DIAMOND_ADDRESS, data }, "latest"],
				}),
			});
			const rpcResp = (await resp.json()) as { result?: string };
			if (!rpcResp.result || rpcResp.result === "0x" || rpcResp.result.length < 130) {
				return {
					available: "0",
					availableFormatted: "0.00",
					onHold: "0",
					onHoldFormatted: "0.00",
				};
			}

			const result = rpcResp.result.replace("0x", "");
			const availableWei = BigInt(`0x${result.slice(0, 64)}`);
			const holdWei = BigInt(`0x${result.slice(64, 128)}`);

			return {
				available: availableWei.toString(),
				availableFormatted: (Number(availableWei) / 1e18).toFixed(4),
				onHold: holdWei.toString(),
				onHoldFormatted: (Number(holdWei) / 1e18).toFixed(4),
			};
		} catch {
			// RPC failed (rate limit, timeout, non-JSON response) - try next
		}
	}
	return {
		available: "0",
		availableFormatted: "0.00",
		onHold: "0",
		onHoldFormatted: "0.00",
	};
}
