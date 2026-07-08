// DRM3 Provenance - response signing (single + batch) and signer key access.

import {
	Keyring,
	Receipt,
	Chain,
	ReceiptBuilder,
} from "@drm3labs-oss/provenance/drm3_provenance.js";
import { insertProvenanceReceipt } from "../db/ops";
import { MORSCAN_VERSION } from "../version";
import { BUILD_INFO } from "../build-info";
import { baseUrl } from "../config";
import { ensureInit, formatErr } from "./provenance-core";

/**
 * Sign a MorScan API response with a provenance receipt.
 * Creates an Ed25519-signed receipt attesting to the cached blockchain data.
 * Optionally stores the receipt in D1 for audit trail.
 *
 * @param action - Receipt action (e.g. 'blockchain.marketplace')
 * @param inputs - What was queried (endpoint, block number, etc.)
 * @param outputs - Summary of what was returned (counts, totals, etc.)
 * @param mnemonic - BIP39 mnemonic from MORSCAN_MNEMONIC secret
 * @param db - Optional D1 database to persist the receipt
 * @returns JSON string of the signed receipt, or null on error
 */
export async function signResponse(
	action: string,
	inputs: Record<string, unknown>,
	outputs: Record<string, unknown>,
	mnemonic: string,
	db?: D1Database,
): Promise<string | null> {
	try {
		ensureInit();
		const keyring = Keyring.fromMnemonic(mnemonic);
		const keypair = keyring.derive("morscan/cache");
		const meta = {
			protocol: "drm3-provenance-v1",
			service: "morscan",
			signer: "morscan/cache",
			version: MORSCAN_VERSION,
			content_uri: `${baseUrl()}/mor/v1/provenance`,
			timestamp: new Date().toISOString(),
			vendor: "Base Mainnet",
			vendor_uri: "https://base-rpc.publicnode.com",
			attestation: `DRM3 Labs attests this blockchain data was indexed from Base mainnet and cached by MorScan.`,
		};
		const receipt = Receipt.create(action)
			.inputs(inputs)
			.outputs({ ...outputs, _meta: meta })
			.sign(keypair);
		const json = receipt.toJson();

		// Store receipt in D1 for audit trail
		if (db) {
			try {
				await insertProvenanceReceipt(
					db,
					receipt.id(),
					receipt.action(),
					receipt.timestamp(),
					receipt.inputHash(),
					receipt.outputHash(),
					receipt.publicKey(),
					receipt.signature(),
					json,
				);
			} catch (storeErr) {
				console.error("Provenance store error (non-fatal):", storeErr);
			}
		}

		return json;
	} catch (e) {
		console.error(formatErr("sign-response", { action }, e));
		return null;
	}
}

/**
 * Get the MorScan signer's public key (Ed25519).
 * This is the key that external verifiers use to validate MorScan receipts.
 */
export function getSignerPublicKey(mnemonic: string): string | null {
	try {
		ensureInit();
		const keyring = Keyring.fromMnemonic(mnemonic);
		const keypair = keyring.derive("morscan/cache");
		return keypair.publicKeyPrefixed();
	} catch (e) {
		console.error(formatErr("get-signer-key", { path: "morscan/cache" }, e));
		return null;
	}
}

/**
 * Get the MorScan service-level signer's public key (Ed25519).
 * Used for signing service attestations (Merkle root of receipt chains).
 * Derive path: morscan/signer
 */
export function getServiceSignerPublicKey(mnemonic: string): string | null {
	try {
		ensureInit();
		const keyring = Keyring.fromMnemonic(mnemonic);
		const keypair = keyring.derive("morscan/signer");
		return keypair.publicKeyPrefixed();
	} catch (e) {
		console.error(formatErr("get-signer-key", { path: "morscan/signer" }, e));
		return null;
	}
}

/**
 * Signed build-receipt over the deployed build identity.
 *
 * BUILD_INFO is stamped into the bundle at deploy time and is static for the
 * life of a deploy, so the receipt is signed ONCE (on first request after a
 * cold start) and memoized - never re-signed per request. The receipt uses the
 * SAME morscan/cache key that signs cached-data receipts and is published at
 * /.well-known/morscan-keys.json, so it verifies the identical way.
 *
 * Honesty: a valid signature proves this exact build-info was attested by the
 * holder of MorScan's key (not merely self-asserted). It does not, by itself,
 * prove the running bytes were compiled from that commit.
 *
 * @param mnemonic - BIP39 mnemonic from MORSCAN_MNEMONIC secret
 * @returns JSON string of the signed receipt, or null on error / no key
 */
let _buildReceipt: string | null | undefined;
export function signBuildReceipt(mnemonic: string): string | null {
	if (_buildReceipt !== undefined) return _buildReceipt;
	try {
		ensureInit();
		const keyring = Keyring.fromMnemonic(mnemonic);
		const keypair = keyring.derive("morscan/cache");
		const meta = {
			protocol: "drm3-provenance-v1",
			service: "morscan",
			signer: "morscan/cache",
			version: MORSCAN_VERSION,
			content_uri: `${baseUrl()}/version`,
			timestamp: BUILD_INFO.builtAt,
			attestation:
				"DRM3 Labs attests this build identity was signed by MorScan's morscan/cache key. It binds the build-info to the signing key; it does not by itself prove the deployed bytes were compiled from this commit.",
		};
		const receipt = Receipt.create("morscan.build")
			.inputs({
				commit: BUILD_INFO.commit,
				shortCommit: BUILD_INFO.shortCommit,
				branch: BUILD_INFO.branch,
				dirty: BUILD_INFO.dirty,
				builtAt: BUILD_INFO.builtAt,
				version: MORSCAN_VERSION,
				provenanceVersion: BUILD_INFO.provenanceVersion,
			})
			.outputs({ attested: "build-identity", _meta: meta })
			.sign(keypair);
		_buildReceipt = receipt.toJson();
		receipt.free();
		return _buildReceipt;
	} catch (e) {
		console.error(formatErr("build-receipt", { commit: BUILD_INFO.shortCommit }, e));
		_buildReceipt = null;
		return null;
	}
}

/**
 * Sign a batch of items with individual provenance receipts.
 * Each item gets its own Ed25519-signed receipt. All receipts are
 * chained together with a Merkle root for batch integrity verification.
 *
 * @param action - Receipt action (e.g. 'blockchain.providers')
 * @param items - Array of objects to sign individually
 * @param mnemonic - BIP39 mnemonic from MORSCAN_MNEMONIC secret
 * @returns Object with receipt JSONs, Merkle root, and receipt IDs, or null on error
 */
export function signBatchResponse(
	action: string,
	items: Record<string, unknown>[],
	mnemonic: string,
): { receipts: string[]; merkleRoot: string | null; receiptIds: string[] } | null {
	try {
		ensureInit();
		if (items.length === 0) return null;

		const keyring = Keyring.fromMnemonic(mnemonic);
		const keypair = keyring.derive("morscan/cache");

		// Sign each item individually
		const signedReceipts: Receipt[] = [];
		const receiptJsons: string[] = [];
		const receiptIds: string[] = [];

		const now = new Date().toISOString();
		const meta = {
			protocol: "drm3-provenance-v1",
			service: "morscan",
			signer: "morscan/cache",
			version: MORSCAN_VERSION,
			content_uri: `${baseUrl()}/mor/v1/provenance`,
			timestamp: now,
			vendor: "Base Mainnet",
			vendor_uri: "https://base-rpc.publicnode.com",
			attestation: `DRM3 Labs attests this data was indexed from Base mainnet by MorScan v${MORSCAN_VERSION}.`,
		};

		for (const item of items) {
			const receipt = new ReceiptBuilder(action)
				.inputs({ endpoint: action, timestamp: now })
				.outputs({ ...item, _meta: meta })
				.sign(keypair);
			receiptIds.push(receipt.id());
			receiptJsons.push(receipt.toJson());
			signedReceipts.push(receipt);
		}

		// Build chain for Merkle root. Rust `add(&Receipt)` borrows + clones
		// internally; free after add to bound WASM heap. No JS `.clone()`.
		let merkleRoot: string | null = null;
		try {
			let builder = Chain.create();
			for (const receipt of signedReceipts) {
				builder = builder.add(receipt);
				receipt.free();
			}
			signedReceipts.length = 0;
			const chain = builder.build();
			merkleRoot = chain.merkleRoot();
			chain.free();
		} catch (chainErr) {
			console.error(formatErr("batch-merkle", { action, items: items.length }, chainErr));
		}

		return { receipts: receiptJsons, merkleRoot, receiptIds };
	} catch (e) {
		console.error(formatErr("batch-sign", { action, items: items.length }, e));
		return null;
	}
}
