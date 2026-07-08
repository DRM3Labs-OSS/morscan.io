/**
 * Marketplace Snapshot - build + Ed25519-sign a slim marketplace blob.
 *
 * A small signed JSON snapshot lets downstream consumers read marketplace
 * state from a CDN URL instead of hitting the Worker on every refresh. The
 * Worker becomes optional for reads, and the explorer can wobble without
 * taking consumers down.
 *
 * The R2 write/prune side lives in `snapshot-store.ts`; this module is pure
 * build + sign (no I/O beyond D1 reads).
 *
 * Envelope:
 *   { v, type, signed_at, signer_key_id, min_sdk_version, providers, bids, models }
 *
 * Signing: Ed25519 over canonical JSON of the envelope, derivation path
 * `drm3/snapshot/marketplace` on MORSCAN_MNEMONIC. The signer key id is
 * configurable (SNAPSHOT_SIGNER_KEY_ID) so the snapshot is not bound to any
 * operator's key-rotation scheme.
 */

import { listSnapshotBids, listSnapshotProviders } from "../db/ops";
import { getNamedModelIdNames } from "../db/explorer-market";
import type { Env } from "../types";
// CF Workers need manual WASM init - __wbindgen_start() doesn't work in Workers runtime.
// @ts-expect-error - the .wasm ships a colocated generated .d.ts with only named
// exports, but at runtime wrangler/esbuild resolves it as a default CompiledWasm
// import (deploy dry-run passes). tsc cannot type the default; this is expected.
import wasmModule from "@drm3labs-oss/provenance/drm3_provenance_bg.wasm";
import {
	initSync,
	Keyring,
	sign as rawSign,
} from "@drm3labs-oss/provenance/drm3_provenance.js";

let _initialized = false;
function ensureInit() {
	if (!_initialized) {
		initSync({ module: wasmModule });
		_initialized = true;
	}
}

/** Derivation path for the marketplace snapshot signer. */
export const SNAPSHOT_DERIVATION_PATH = "drm3/snapshot/marketplace";

/**
 * Minimum consumer SDK version this snapshot targets. A kill-switch for old
 * binaries - consumers SHOULD refuse to start below this. Bump to force-upgrade.
 */
export const SNAPSHOT_MIN_SDK_VERSION = "0.9.0";

/** Slim bid row included in the snapshot. */
export interface SnapshotBid {
	bidId: string;
	provider: string;
	modelId: string;
	model: string | null;
	pricePerSecond: string;
	active: boolean;
}

/** Slim provider row. */
export interface SnapshotProvider {
	address: string;
	endpoint: string;
}

/** Slim model row - modelId → human-readable name. */
export interface SnapshotModel {
	modelId: string;
	name: string;
}

/** Envelope wire format. Kept stable (v: 1) - evolve via new versions, never breaking. */
export interface SnapshotEnvelope {
	v: 1;
	type: "morscan.snapshot.marketplace";
	signed_at: number;
	signer_key_id: string;
	min_sdk_version: string;
	providers: SnapshotProvider[];
	bids: SnapshotBid[];
	models: SnapshotModel[];
}

/** Result of signing an envelope. */
export interface SignedSnapshot {
	envelope: SnapshotEnvelope;
	envelope_b64: string;
	signature_b64: string;
	public_key: string;
}

/**
 * Canonical JSON serialization for signing. Top-level fields in a locked
 * order; nested objects keep row-builder insertion order (also stable). This
 * is exactly what the signer signs and what consumers verify.
 */
export function canonicalize(env: SnapshotEnvelope): string {
	const ordered: Record<string, unknown> = {
		v: env.v,
		type: env.type,
		signed_at: env.signed_at,
		signer_key_id: env.signer_key_id,
		min_sdk_version: env.min_sdk_version,
		providers: env.providers,
		bids: env.bids,
		models: env.models,
	};
	return JSON.stringify(ordered);
}

/**
 * Build the slim marketplace snapshot from D1 - providers + active bids +
 * model names only. Stays under the ~100KB-gzipped target.
 */
export async function buildMarketplaceSnapshot(env: Env): Promise<{
	providers: SnapshotProvider[];
	bids: SnapshotBid[];
	models: SnapshotModel[];
}> {
	const [providerRows, bidRows, modelRows] = await Promise.all([
		listSnapshotProviders(env.DB),
		listSnapshotBids(env.DB),
		getNamedModelIdNames(env.DB),
	]);

	const models: SnapshotModel[] = modelRows.map((m: Record<string, unknown>) => ({
		modelId: (m.model_id as string) || "",
		name: (m.name as string) || "",
	}));

	const modelNameById: Record<string, string> = {};
	for (const m of models) modelNameById[m.modelId] = m.name;

	const providers: SnapshotProvider[] = providerRows.map(
		(p: Record<string, unknown>) => ({
			address: (p.address as string) || "",
			endpoint: (p.endpoint as string) || "",
		}),
	);

	const bids: SnapshotBid[] = bidRows.map((b: Record<string, unknown>) => {
		const modelId = (b.model_id as string) || "";
		return {
			bidId: (b.bid_id as string) || "",
			provider: (b.provider as string) || "",
			modelId,
			model: modelNameById[modelId] || null,
			pricePerSecond: (b.price_per_second as string) || "0",
			active: !b.deleted_at || Number(b.deleted_at) === 0,
		};
	});

	return { providers, bids, models };
}

/**
 * Sign the envelope with Ed25519 and return the transport shape:
 *   `<base64(envelope_json)>.<base64(ed25519_sig)>`
 */
export function signEnvelope(
	envelope: SnapshotEnvelope,
	mnemonic: string,
): SignedSnapshot {
	ensureInit();
	const keyring = Keyring.fromMnemonic(mnemonic);
	const keypair = keyring.derive(SNAPSHOT_DERIVATION_PATH);
	const publicKey = keypair.publicKeyPrefixed();

	const canonical = canonicalize(envelope);
	const bytes = new TextEncoder().encode(canonical);
	// `sign` returns an ed25519:-prefixed hex string; strip + base64 it so
	// consumers receive a raw signature blob.
	const prefixedSig = rawSign(bytes, keypair);
	const sigHex = prefixedSig.startsWith("ed25519:")
		? prefixedSig.slice("ed25519:".length)
		: prefixedSig;

	const sigBytes = new Uint8Array(sigHex.length / 2);
	for (let i = 0; i < sigBytes.length; i++) {
		sigBytes[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
	}
	const envelopeB64 = btoa(canonical);
	let binary = "";
	for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]);
	const signatureB64 = btoa(binary);

	keypair.free();
	keyring.free();

	return {
		envelope,
		envelope_b64: envelopeB64,
		signature_b64: signatureB64,
		public_key: publicKey,
	};
}

/** Derive the snapshot signer's public key (no signing, no side effects). */
export function getSnapshotSignerPublicKey(mnemonic: string): string {
	ensureInit();
	const keyring = Keyring.fromMnemonic(mnemonic);
	const keypair = keyring.derive(SNAPSHOT_DERIVATION_PATH);
	const pub = keypair.publicKeyPrefixed();
	keypair.free();
	keyring.free();
	return pub;
}
