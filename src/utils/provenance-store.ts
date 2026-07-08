// DRM3 Provenance - D1 storage for row + batch receipts.
// Split from provenance-chain.ts (size budget); re-exported via provenance.ts.

import { insertProvenanceReceiptStmt, insertRowReceiptStmt } from "../db/ops";
import type { SyncBatchResult } from "./provenance-chain";

/**
 * Store row receipts and batch receipt in D1.
 * Non-fatal - sync continues even if storage fails.
 */
export async function storeRowReceipts(
	db: D1Database,
	result: SyncBatchResult,
): Promise<void> {
	const now = new Date().toISOString();
	const stmts: D1PreparedStatement[] = [];

	for (const row of result.rowReceipts) {
		stmts.push(
			insertRowReceiptStmt(
				db,
				row.id,
				row.receiptJson,
				row.rowKey,
				result.batchId,
				result.merkleRoot,
				row.dataType,
				now,
			),
		);
	}

	// Also store batch receipt in provenance_receipts for the existing chain/attestation pipeline
	try {
		const batchParsed = JSON.parse(result.batchReceiptJson);
		stmts.push(
			insertProvenanceReceiptStmt(
				db,
				batchParsed.id,
				batchParsed.action,
				batchParsed.timestamp,
				batchParsed.input_hash || "",
				batchParsed.output_hash || "",
				batchParsed.public_key || "",
				batchParsed.signature || "",
				result.batchReceiptJson,
			),
		);
	} catch (_e) {
		/* batch receipt parse error - non-fatal */
	}

	// Execute in chunks of 100
	for (let i = 0; i < stmts.length; i += 100) {
		await db.batch(stmts.slice(i, i + 100));
	}
}
