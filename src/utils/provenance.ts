// DRM3 Provenance - WASM wrapper for Cloudflare Workers.
// MorScan SIGNS receipts for its cached blockchain data.
// Derive path: morscan/cache (see drm3-provenance README).
//
// This module is a barrel: the implementation is split across
// provenance-core (WASM init + errors), provenance-sign (response + batch
// signing, signer keys), and provenance-chain (Merkle chaining, sync-batch
// signing, D1 storage). Importers keep using `from '../utils/provenance'`.

export { ProvenanceSigningError } from "./provenance-core";
export {
	signResponse,
	getSignerPublicKey,
	getServiceSignerPublicKey,
	signBatchResponse,
	signBuildReceipt,
} from "./provenance-sign";
export {
	chainReceipts,
	signSyncBatch,
	type RowReceipt,
	type SyncBatchResult,
} from "./provenance-chain";
export { storeRowReceipts } from "./provenance-store";
