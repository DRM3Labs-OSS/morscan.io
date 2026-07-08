// DRM3 Provenance - Merkle receipt chaining, sync-batch signing, D1 storage.

import {
	Keyring,
	Receipt,
	Chain,
	ReceiptBuilder,
} from "@drm3labs-oss/provenance/drm3_provenance.js";
import {
	insertServiceAttestation,
	listUnchainedReceipts,
	markReceiptsChained,
} from "../db/ops";
import { MORSCAN_VERSION } from "../version";
import { baseUrl } from "../config";
import { ensureInit, formatErr } from "./provenance-core";

/**
 * Compute and store the Merkle root for recent provenance receipts.
 * Called from cron to chain receipts into a verifiable tree.
 */
export async function chainReceipts(
	db: D1Database,
	mnemonic: string,
): Promise<{ root: string; count: number } | null> {
	try {
		ensureInit();
		// Get unchained receipts (no chain_root set)
		const receipts = await listUnchainedReceipts(db);
		if (receipts.length === 0) return null;

		// Track timestamps for attestation range
		let fromTimestamp = "";
		let toTimestamp = "";

		// Build chain from receipts. Rust `add(&Receipt)` borrows and clones
		// internally, so free after add. Never `.clone()` in JS - the JS clone
		// leaks until finalization and can OOM the Worker on large batches.
		let builder = Chain.create();
		for (const row of receipts) {
			const receipt = Receipt.fromJson(row.receipt_json as string);
			const ts = receipt.timestamp();
			if (!fromTimestamp || ts < fromTimestamp) fromTimestamp = ts;
			if (!toTimestamp || ts > toTimestamp) toTimestamp = ts;
			builder = builder.add(receipt);
			receipt.free();
		}
		const chain = builder.build();
		const root = chain.merkleRoot();
		const chainId = chain.id();

		// Mark all receipts with this chain root
		const ids = receipts.map((r) => {
			const parsed = JSON.parse(r.receipt_json as string);
			return parsed.id;
		});

		// Batch update in groups of 50
		for (let i = 0; i < ids.length; i += 50) {
			const batch = ids.slice(i, i + 50);
			await markReceiptsChained(db, root, chainId, batch);
		}

		// Service-level attestation: sign the Merkle root with morscan/signer key
		try {
			const keyring = Keyring.fromMnemonic(mnemonic);
			const signerKeypair = keyring.derive("morscan/signer");
			const attestMeta = {
				protocol: "drm3-provenance-v1",
				service: "morscan",
				signer: "morscan/signer",
				version: MORSCAN_VERSION,
				content_uri: `${baseUrl()}/.well-known/morscan-keys.json`,
				timestamp: new Date().toISOString(),
				vendor: "self",
				attestation: `DRM3 Labs attests MorScan signed Merkle root ${root.slice(0, 24)}... covering ${receipts.length} receipts from ${fromTimestamp} to ${toTimestamp}.`,
			};
			const signerReceipt = new ReceiptBuilder("service.attestation")
				.inputs({
					merkle_root: root,
					receipt_count: receipts.length,
					from_timestamp: fromTimestamp,
					to_timestamp: toTimestamp,
				})
				.outputs({ merkle_root: root, receipt_count: receipts.length, _meta: attestMeta })
				.sign(signerKeypair);

			await insertServiceAttestation(
				db,
				signerReceipt.id(),
				root,
				receipts.length,
				fromTimestamp,
				toTimestamp,
				signerReceipt.signature(),
				signerKeypair.publicKeyPrefixed(),
			);
		} catch (attestErr) {
			console.error(
				formatErr("service-attestation", { root, receipts: receipts.length }, attestErr),
			);
		}

		return { root, count: receipts.length };
	} catch (e) {
		console.error(formatErr("chain-receipts", {}, e));
		return null;
	}
}

/** Row receipt with metadata for D1 storage */
export interface RowReceipt {
	id: string;
	receiptJson: string;
	rowKey: string;
	dataType: string;
}

/** Result of a sync batch signing operation */
export interface SyncBatchResult {
	batchId: string;
	merkleRoot: string;
	rowReceipts: RowReceipt[];
	batchReceiptJson: string;
}

/**
 * Sign a sync batch with per-row provenance receipts.
 *
 * Each provider/model row gets its own Ed25519-signed receipt.
 * All row receipts are chained into a Merkle tree, then a batch
 * receipt attests to the entire sync cycle.
 *
 * @param providers - Provider rows from sync (address + endpoint + stake)
 * @param models - Model rows from sync (modelId + name)
 * @param mnemonic - BIP39 mnemonic from MORSCAN_MNEMONIC secret
 * @returns Batch result with row receipts and Merkle root, or null on error
 */
export function signSyncBatch(
	providers: Array<{ address: string; endpoint: string; stake: string }>,
	models: Array<{ modelId: string; name: string }>,
	mnemonic: string,
): SyncBatchResult | null {
	try {
		ensureInit();
		if (providers.length === 0 && models.length === 0) return null;

		const keyring = Keyring.fromMnemonic(mnemonic);
		const keypair = keyring.derive("morscan/cache");
		const rowReceipts: RowReceipt[] = [];
		const allSignedReceipts: Receipt[] = [];

		const syncMeta = {
			protocol: "drm3-provenance-v1",
			service: "morscan",
			signer: "morscan/cache",
			version: MORSCAN_VERSION,
			content_uri: `${baseUrl()}/mor/v1/all`,
			timestamp: new Date().toISOString(),
			vendor: "Base Mainnet",
			vendor_uri: "https://base-rpc.publicnode.com",
			attestation: `DRM3 Labs attests this data was synced from Base mainnet by MorScan v${MORSCAN_VERSION}.`,
		};

		// Sign each provider individually
		for (const provider of providers) {
			const receipt = Receipt.create("blockchain.provider")
				.inputs({ source: "base-mainnet", type: "provider" })
				.outputs({
					address: provider.address,
					endpoint: provider.endpoint,
					stake: provider.stake,
					_meta: syncMeta,
				})
				.sign(keypair);
			rowReceipts.push({
				id: receipt.id(),
				receiptJson: receipt.toJson(),
				rowKey: provider.address.toLowerCase(),
				dataType: "provider",
			});
			allSignedReceipts.push(receipt);
		}

		// Sign each model individually
		for (const model of models) {
			const receipt = Receipt.create("blockchain.model")
				.inputs({ source: "base-mainnet", type: "model" })
				.outputs({ modelId: model.modelId, name: model.name, _meta: syncMeta })
				.sign(keypair);
			rowReceipts.push({
				id: receipt.id(),
				receiptJson: receipt.toJson(),
				rowKey: model.modelId.toLowerCase(),
				dataType: "model",
			});
			allSignedReceipts.push(receipt);
		}

		// Merkle rollup - chain all row receipts. Rust `add(&Receipt)` borrows
		// and clones internally; free after add. No JS `.clone()`.
		let builder = Chain.create();
		for (const receipt of allSignedReceipts) {
			builder = builder.add(receipt);
			receipt.free();
		}
		allSignedReceipts.length = 0;
		const chain = builder.build();
		const merkleRoot = chain.merkleRoot();

		// Batch receipt attesting to the entire sync cycle
		const batchReceipt = Receipt.create("blockchain.sync.batch")
			.inputs({
				source: "base-mainnet",
				providerCount: providers.length,
				modelCount: models.length,
				merkleRoot,
			})
			.outputs({
				rowCount: rowReceipts.length,
				merkleRoot,
				timestamp: new Date().toISOString(),
				_meta: {
					...syncMeta,
					signing_model: "row-level + Merkle rollup",
					attestation: `DRM3 Labs attests batch of ${rowReceipts.length} provider/model rows from Base mainnet, Merkle root ${merkleRoot.slice(0, 24)}...`,
				},
			})
			.sign(keypair);

		return {
			batchId: batchReceipt.id(),
			merkleRoot,
			rowReceipts,
			batchReceiptJson: batchReceipt.toJson(),
		};
	} catch (e) {
		console.error(
			formatErr("sync-batch", { providers: providers.length, models: models.length }, e),
		);
		return null;
	}
}
