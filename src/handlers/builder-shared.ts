/** Shared helpers + emission math for the builder-staking handlers. */

export const HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

// Builder pool weight was 24% at launch but has been adjusted. Fallback to
// 18.6% (observed May 2026) if data unavailable.
const BUILDER_WEIGHT = 0.186;

export function builderDailyEmissions(): number {
	const launchTs = 1707350400;
	const daysSinceLaunch = Math.floor((Date.now() / 1000 - launchTs) / 86400);
	const total = Math.max(0, 14400 - daysSinceLaunch * 2.468994701);
	return total * BUILDER_WEIGHT;
}

export function formatMor(wei: string): string {
	try {
		const n = BigInt(wei);
		const whole = n / BigInt(1e18);
		const frac = n % BigInt(1e18);
		const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
		return `${whole}.${fracStr}`;
	} catch {
		return "0.0000";
	}
}

export function morNumber(wei: string): number {
	try {
		return Number(BigInt(wei)) / 1e18;
	} catch {
		return 0;
	}
}
