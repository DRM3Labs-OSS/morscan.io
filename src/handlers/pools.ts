/**
 * Pools API Handler -- /mor/v1/pools
 *
 * Only shows pools we can read from chain. Capital, Code, and Protection
 * are on Arbitrum behind a proxy with unknown ABI -- we cannot verify
 * those balances so we do not show them.
 *
 * For Capital/Code/Protection pool data, see: https://dashboard.mor.org
 */

import type { Env } from "../types";
import { getNetworkEconomics, getBuilderGlobalStats } from "../db/explorer-market";

const HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

const POOL_CONFIG = [
	{
		id: 2,
		name: "Compute Providers",
		detailUrl: "/compute/providers",
		contract: "0x6aBE1d282f72B474E54527D93b979A4f64d3030a",
		chain: "Base",
		docsUrl:
			"https://github.com/MorpheusAIs/Docs/blob/main/!KEYDOCS%20README%20FIRST!/Compute%20Providers/Morpheus%20Lumerin%20Model.md",
		desc: "GPU providers who serve AI inference on the Morpheus network. Staked MOR read from the Diamond contract on Base.",
	},
	{
		id: 3,
		name: "Builder Subnets",
		detailUrl: "/builder/subnets",
		contract: "0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9",
		chain: "Base",
		docsUrl:
			"https://github.com/MorpheusAIs/Docs/blob/main/!KEYDOCS%20README%20FIRST!/Builders/Builder%20Guide.md",
		desc: "Application builders who stake MOR toward specific subnets. Staked MOR read from the Builder contract on Base.",
	},
] as const;

function toWeiString(val: unknown): string {
	if (!val) return "0";
	const s = String(val);
	if (s === "0" || s === "") return "0";
	if (s.includes("e") || s.includes("E")) {
		try {
			return BigInt(Math.round(Number(s))).toString();
		} catch {
			return "0";
		}
	}
	return s;
}

function morNumber(wei: string): number {
	try {
		return Number(BigInt(wei)) / 1e18;
	} catch {
		return 0;
	}
}

export async function handlePools(env: Env): Promise<Response> {
	const [econRow, builderRow] = await Promise.all([
		getNetworkEconomics(env.DB),
		getBuilderGlobalStats(env.DB),
	]);

	const econ = econRow as Record<string, unknown> | null;
	const builderStats = builderRow ? JSON.parse(builderRow.value as string) : {};

	const computeWei = toWeiString(econ?.compute_balance);
	const totalSupplyWei = toWeiString(econ?.total_supply);
	const builderWei = toWeiString(builderStats.total_deposited);

	const computeMor = morNumber(computeWei);
	const builderMor = morNumber(builderWei);
	const totalSupplyMor = morNumber(totalSupplyWei);

	const pools = POOL_CONFIG.map((cfg) => {
		const stakedMor = cfg.id === 2 ? computeMor : cfg.id === 3 ? builderMor : 0;
		const source = cfg.id === 2 ? "Base Diamond contract" : "Base Builder contract";
		return {
			id: cfg.id,
			name: cfg.name,
			desc: cfg.desc,
			stakedMor: stakedMor > 0 ? Math.round(stakedMor) : null,
			detailUrl: cfg.detailUrl,
			source,
			contract: cfg.contract,
			chain: cfg.chain,
			docsUrl: cfg.docsUrl,
		};
	});

	return new Response(
		JSON.stringify({
			pools,
			totals: {
				totalSupplyMor,
				totalSupplySource: "Base MOR ERC-20 totalSupply",
				lastUpdate: econ?.updated_at || null,
			},
			note: "Capital, Code, and Protection pool data is not indexed by MorScan. See https://dashboard.mor.org for those pools.",
		}),
		{ headers: HEADERS },
	);
}
