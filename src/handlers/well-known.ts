// /.well-known/morscan-keys.json - v2 key discovery reading from key_history D1 table.
// Emits the drm3-keys/v2 schema so third-party verifiers can walk `current` and
// `history`, interpreting status + validity windows. Prior rotations (if any)
// live in the table as non-`current` rows.

import type { Env } from "../types";
import {
	getKeyHistory,
	getLatestServiceAttestation,
	type KeyHistoryRow,
} from "../db/ops";

function rowToRecord(row: KeyHistoryRow): Record<string, unknown> {
	const r: Record<string, unknown> = {
		path: row.path,
		key: row.key,
		valid_from: row.valid_from,
	};
	if (row.valid_until) r.valid_until = row.valid_until;
	if (row.expected_valid_until) r.expected_valid_until = row.expected_valid_until;
	r.status = row.status;
	if (row.rotation_reason) r.rotation_reason = row.rotation_reason;
	if (row.note) r.note = row.note;
	return r;
}

export async function handleWellKnownKeys(env: Env): Promise<Response> {
	const all = await getKeyHistory(env.DB);
	const current = all.filter((r) => r.status === "current").map(rowToRecord);
	const history = all.filter((r) => r.status !== "current").map(rowToRecord);

	// Query latest service attestation from D1 - MorScan-specific extension,
	// unchanged from v1 shape.
	let latestAttestation: Record<string, unknown> | null = null;
	try {
		const row = await getLatestServiceAttestation(env.DB);
		if (row) {
			latestAttestation = {
				id: row.id,
				merkle_root: row.merkle_root,
				receipt_count: row.receipt_count,
				from_timestamp: row.from_timestamp,
				to_timestamp: row.to_timestamp,
				signature: row.signature,
				public_key: row.public_key,
				created_at: row.created_at,
			};
		}
	} catch (_e) {
		// Table may not exist on fresh deploy.
	}

	const body = {
		schema: "drm3-keys/v2",
		service: "morscan",
		product: "MorScan",
		algorithm: "Ed25519",
		current,
		history,
		latest_attestation: latestAttestation,
		published: new Date().toISOString(),
	};

	return new Response(JSON.stringify(body, null, 2), {
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			"Cache-Control": "public, max-age=60",
		},
	});
}
