/**
 * Snapshot prune handler - daily R2 garbage collector.
 *
 * Called from the `0 3 * * *` cron branch in src/index.ts scheduled().
 * Deletes `marketplace-<ts>.json` objects older than 7 days from the
 * SNAPSHOT_BUCKET R2 bucket. `marketplace-latest.json` is always preserved.
 *
 * Thin wrapper over utils/snapshot-store.ts → pruneMarketplaceSnapshots so the
 * cron-level file layout keeps snapshot logic out of the handlers directory.
 */

import type { Env } from "../types";
import { pruneMarketplaceSnapshots } from "../utils/snapshot-store";

export async function handleSnapshotPrune(
	env: Env,
): Promise<{ deleted: number; kept: number }> {
	return pruneMarketplaceSnapshots(env);
}
