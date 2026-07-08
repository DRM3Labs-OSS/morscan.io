/**
 * Marketplace Snapshot - R2 write + prune.
 *
 * Builds and signs a snapshot (see snapshot.ts) and publishes it to R2 every
 * few minutes via the scheduled() handler. No-ops gracefully when the optional
 * SNAPSHOT_BUCKET binding or MORSCAN_MNEMONIC secret is absent.
 *
 * Outputs (R2 bucket binding SNAPSHOT_BUCKET, optionally fronted by a public
 * host you configure as SNAPSHOT_PUBLIC_HOST):
 *   - `marketplace-<unix_ts>.json`  immutable, infinite edge TTL
 *   - `marketplace-latest.json`     pointer `{url, ts, signed_at, ...}`, 30s TTL
 */

import type { Env } from "../types";
import { resolveConfig, signingMnemonic } from "../config";
import {
	type SnapshotEnvelope,
	SNAPSHOT_MIN_SDK_VERSION,
	buildMarketplaceSnapshot,
	signEnvelope,
} from "./snapshot";

/** Shape of the -latest.json pointer object. */
export interface SnapshotPointer {
	v: 1;
	url: string;
	ts: number;
	signed_at: number;
	signer_key_id: string;
	min_sdk_version: string;
	public_key: string;
}

/**
 * Build, sign, and publish a new marketplace snapshot to R2.
 *
 * Non-fatal: logs + returns null on error so the scheduled() handler doesn't
 * crash the rest of the cron tick.
 */
export async function writeMarketplaceSnapshot(
	env: Env,
): Promise<{ ts: number; url: string } | null> {
	// PROVENANCE_ENABLED="false" behaves exactly like a missing mnemonic here:
	// the snapshot is a SIGNED artifact, so unsigned mode skips the write.
	const mnemonic = signingMnemonic(env);
	if (!mnemonic) {
		console.warn(
			"[snapshot] provenance signing unavailable (MORSCAN_MNEMONIC missing or PROVENANCE_ENABLED=false) - skipping snapshot write",
		);
		return null;
	}
	if (!env.SNAPSHOT_BUCKET) {
		console.warn("[snapshot] SNAPSHOT_BUCKET binding missing - skipping snapshot write");
		return null;
	}

	try {
		const ts = Math.floor(Date.now() / 1000);
		const signerKeyId = resolveConfig(env).snapshotSignerKeyId;
		const { providers, bids, models } = await buildMarketplaceSnapshot(env);

		const envelope: SnapshotEnvelope = {
			v: 1,
			type: "morscan.snapshot.marketplace",
			signed_at: ts,
			signer_key_id: signerKeyId,
			min_sdk_version: SNAPSHOT_MIN_SDK_VERSION,
			providers,
			bids,
			models,
		};

		const signed = signEnvelope(envelope, mnemonic);

		const versionedKey = `marketplace-${ts}.json`;
		const versionedBody = JSON.stringify({
			...signed.envelope,
			_signature: {
				algorithm: "Ed25519",
				envelope_b64: signed.envelope_b64,
				signature_b64: signed.signature_b64,
				public_key: signed.public_key,
				signer_key_id: envelope.signer_key_id,
			},
		});

		// Versioned object: infinite edge TTL, immutable.
		await env.SNAPSHOT_BUCKET.put(versionedKey, versionedBody, {
			httpMetadata: {
				contentType: "application/json",
				cacheControl: "public, max-age=31536000, immutable",
			},
			customMetadata: {
				signed_at: String(ts),
				signer_key_id: envelope.signer_key_id,
				min_sdk_version: envelope.min_sdk_version,
			},
		});

		// Latest pointer: short TTL so consumers converge quickly after a publish.
		const pointer: SnapshotPointer = {
			v: 1,
			url: versionedKey,
			ts,
			signed_at: ts,
			signer_key_id: envelope.signer_key_id,
			min_sdk_version: envelope.min_sdk_version,
			public_key: signed.public_key,
		};
		await env.SNAPSHOT_BUCKET.put("marketplace-latest.json", JSON.stringify(pointer), {
			httpMetadata: {
				contentType: "application/json",
				cacheControl: "public, max-age=30, s-maxage=30",
			},
		});

		console.log(
			`[snapshot] wrote ${versionedKey} (${providers.length} providers, ${bids.length} bids, ${models.length} models)`,
		);
		return { ts, url: versionedKey };
	} catch (e) {
		console.error("[snapshot] write failed:", e);
		return null;
	}
}

/**
 * Prune snapshot objects older than the cutoff (default 7 days). Called from
 * the daily cron. `marketplace-latest.json` is preserved regardless of age.
 */
export async function pruneMarketplaceSnapshots(
	env: Env,
	maxAgeSecs: number = 7 * 24 * 60 * 60,
): Promise<{ deleted: number; kept: number }> {
	if (!env.SNAPSHOT_BUCKET) {
		console.warn("[snapshot-prune] SNAPSHOT_BUCKET binding missing - skipping prune");
		return { deleted: 0, kept: 0 };
	}

	const cutoff = Math.floor(Date.now() / 1000) - maxAgeSecs;
	let deleted = 0;
	let kept = 0;
	let cursor: string | undefined;

	try {
		do {
			const listed = await env.SNAPSHOT_BUCKET.list({
				prefix: "marketplace-",
				cursor,
				limit: 1000,
			});

			const toDelete: string[] = [];
			for (const obj of listed.objects) {
				if (obj.key === "marketplace-latest.json") {
					kept++;
					continue;
				}
				const m = obj.key.match(/^marketplace-(\d+)\.json$/);
				if (!m) {
					kept++;
					continue;
				}
				const objTs = Number(m[1]);
				if (!Number.isFinite(objTs) || objTs >= cutoff) {
					kept++;
					continue;
				}
				toDelete.push(obj.key);
			}

			for (const key of toDelete) {
				try {
					await env.SNAPSHOT_BUCKET.delete(key);
					deleted++;
				} catch (e) {
					console.error(`[snapshot-prune] delete failed for ${key}:`, e);
				}
			}

			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor);
	} catch (e) {
		console.error("[snapshot-prune] list failed:", e);
	}

	console.log(`[snapshot-prune] deleted=${deleted} kept=${kept} cutoff=${cutoff}`);
	return { deleted, kept };
}
