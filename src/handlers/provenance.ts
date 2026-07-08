/**
 * Provenance Handler - Audit trail of all signed API responses
 */

import type { Env } from "../types";
import { provenanceEnabled, signingMnemonic } from "../config";
import { getSignerPublicKey } from "../utils/provenance";
import {
	getProvenanceReceiptsByAction,
	getProvenanceReceipts,
	getProvenanceActionCounts,
	countProvenanceReceipts,
	getProvenanceChains,
} from "../db/ops";

/**
 * GET /mor/v1/provenance - receipt chain, signer public key, counts
 * Query params: ?action=blockchain.marketplace&limit=50
 */
export async function handleProvenance(
	env: Env,
	headers: Record<string, string>,
	url: URL,
): Promise<Response> {
	const action = url.searchParams.get("action");
	// Hard cap, server-enforced: max 100 receipts per call (NaN falls to 50).
	const limit = Math.min(
		100,
		Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50),
	);

	// Get signer public key. With PROVENANCE_ENABLED="false" the WASM signer is
	// never touched: publicKey stays null and an honest marker is added below.
	const mnemonic = signingMnemonic(env);
	const publicKey = mnemonic ? getSignerPublicKey(mnemonic) : null;
	const signing = provenanceEnabled(env) ? "enabled" : "disabled";

	// Query receipts
	let receipts: Record<string, unknown>[];
	if (action) {
		receipts = await getProvenanceReceiptsByAction(env.DB, action, limit);
	} else {
		receipts = await getProvenanceReceipts(env.DB, limit);
	}

	// Get totals by action
	const actionCounts = await getProvenanceActionCounts(env.DB);

	// Total count
	const totalResult = await countProvenanceReceipts(env.DB);

	// Chain summary
	const chains = await getProvenanceChains(env.DB);

	return new Response(
		JSON.stringify({
			service: "morscan",
			signing,
			...(signing === "disabled"
				? {
						note: "PROVENANCE_ENABLED is false on this deployment: responses are served without receipts. Any receipts listed below are historical rows signed while provenance was enabled.",
					}
				: {}),
			signer: {
				publicKey,
				derivationPath: "morscan/cache",
				algorithm: "Ed25519",
			},
			total: totalResult?.total || 0,
			actions: actionCounts.map((r: Record<string, unknown>) => ({
				action: r.action,
				count: r.count,
			})),
			chains,
			receipts: receipts.map((r: Record<string, unknown>) => ({
				id: r.id,
				action: r.action,
				timestamp: r.timestamp,
				inputHash: r.input_hash,
				outputHash: r.output_hash,
				publicKey: r.public_key,
				signature: r.signature,
				chainRoot: r.chain_root,
				chainId: r.chain_id,
			})),
		}),
		{ headers },
	);
}
