/**
 * Compute Sync - schema bootstrap + derived stat refreshers
 *
 * Idempotent table creation (wallet_stats, diamond_upgrades), the DiamondCut
 * data parser, and the incremental / bulk wallet_stats + provider_stats
 * recompute helpers.
 *
 * Split out of compute.ts (2026-06-17). Behavior is byte-for-byte identical to
 * the original inline code.
 */

import type { Env } from "../types";
import {
	probeWalletStatsSchema,
	dropWalletStatsTable,
	createWalletStatsTable,
	upsertWalletStats,
	clearWalletStats,
	insertAllWalletStats,
	countWalletStats,
	upsertProviderStats,
	createDiamondUpgradesTable,
} from "../db/sync";

// Decode DiamondCut((address,uint8,bytes4[])[],address,bytes) event data.
// Head: [0-32] offset to FacetCut[], [32-64] init address, [64-96] offset to init calldata.
// FacetCut[] data: length word, then per-element offsets relative to the word
// after the length; each struct is (facetAddress, action, rel offset to bytes4[]),
// selectors left-aligned in their 32-byte slots.
// Actions per EIP-2535: 0=Add, 1=Replace, 2=Remove.
const CUT_ACTIONS = ["add", "replace", "remove"] as const;

export function parseDiamondCutData(
	data: string,
): Array<{ facet: string; action: "add" | "replace" | "remove"; selectors: string[] }> {
	try {
		const hex = data.startsWith("0x") ? data.slice(2) : data;
		if (hex.length < 192) return [];
		const word = (pos: number): string => hex.slice(pos, pos + 64);

		const cutsBase = parseInt(word(0), 16) * 2;
		const cutCount = parseInt(word(cutsBase), 16);
		if (!(cutCount >= 0 && cutCount <= 256)) return [];

		const changes: Array<{
			facet: string;
			action: "add" | "replace" | "remove";
			selectors: string[];
		}> = [];
		const elemsBase = cutsBase + 64;
		for (let i = 0; i < cutCount; i++) {
			const structBase = elemsBase + parseInt(word(elemsBase + i * 64), 16) * 2;
			const facet = `0x${word(structBase).slice(24)}`;
			const action = CUT_ACTIONS[parseInt(word(structBase + 64), 16)];
			if (!action) return [];

			const selsBase = structBase + parseInt(word(structBase + 128), 16) * 2;
			const selCount = parseInt(word(selsBase), 16);
			if (
				!(selCount >= 0 && selCount <= 1024) ||
				selsBase + 64 + selCount * 64 > hex.length
			)
				return [];
			const selectors: string[] = [];
			for (let s = 0; s < selCount; s++) {
				selectors.push(`0x${word(selsBase + 64 + s * 64).slice(0, 8)}`);
			}
			changes.push({ facet, action, selectors });
		}
		return changes;
	} catch {
		return [];
	}
}

export async function ensureWalletStatsSchema(env: Env): Promise<void> {
	try {
		await probeWalletStatsSchema(env.DB);
	} catch {
		await dropWalletStatsTable(env.DB);
		await createWalletStatsTable(env.DB);
		console.log("[sync] Recreated wallet_stats with canonical schema");
	}
}

export async function refreshWalletStats(env: Env, wallets: string[]): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	for (const w of wallets) {
		try {
			await upsertWalletStats(env.DB, now, w);
		} catch {}
	}
}

export async function rebuildAllWalletStats(env: Env): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	try {
		await clearWalletStats(env.DB);
		await insertAllWalletStats(env.DB, now);
		const count = await countWalletStats(env.DB);
		console.log(`[sync] Rebuilt wallet_stats for ${count?.c || 0} wallets (bulk SQL)`);
	} catch (e) {
		console.error("[sync] rebuildAllWalletStats failed:", e);
	}
}

export async function refreshProviderStats(
	env: Env,
	pairs: Array<{ provider: string; model_id: string }>,
): Promise<void> {
	for (const { provider, model_id } of pairs) {
		try {
			await upsertProviderStats(
				env.DB,
				Math.floor(Date.now() / 1000),
				provider,
				model_id,
			);
		} catch {}
	}
}

export async function ensureDiamondUpgradesTable(env: Env): Promise<void> {
	try {
		await createDiamondUpgradesTable(env.DB);
	} catch {}
}
