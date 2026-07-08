/**
 * Teaser Handler - Public stats for login page
 */

import type { Env } from "../types";
import { getNetworkMetrics } from "../utils/metrics";

export async function handleTeaser(
	env: Env,
	headers: Record<string, string>,
): Promise<Response> {
	const m = await getNetworkMetrics(env);
	return new Response(
		JSON.stringify({
			providers: m.providers,
			bids: m.bids,
			activeSessions: m.activeSessions,
			totalSessions: m.totalSessions,
			morStaked: m.morStaked,
		}),
		{ headers },
	);
}
