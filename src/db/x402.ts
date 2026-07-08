/**
 * Data-access layer: x402 micropayment queue (x402_payments).
 *
 * One row per accepted payment authorization. status 'pending' = verified,
 * served, awaiting batch on-chain settlement (verify-only mode); 'settled' =
 * broadcast on-chain (facilitator mode or a later batch run stamps tx_hash).
 * UNIQUE(payer, nonce) is the atomic replay gate for EIP-3009 nonces.
 * DDL lives in schema.sql; apply to the remote D1 before deploying.
 */

export interface X402PaymentRow {
	payer: string;
	payTo: string;
	asset: string;
	amountAtomic: string;
	validAfter: number;
	validBefore: number;
	nonce: string;
	signature: string;
	authorizationJson: string;
	resource: string;
	status: string;
	txHash: string | null;
}

/** True when this (payer, nonce) pair was already accepted. */
export async function isX402NonceUsed(
	db: D1Database,
	payer: string,
	nonce: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS hit FROM x402_payments WHERE payer = ? AND nonce = ?")
		.bind(payer, nonce)
		.first<{ hit: number }>();
	return !!row;
}

/** Unsettled-authorization count for the per-payer abuse cap. */
export async function countPendingX402ForPayer(
	db: D1Database,
	payer: string,
): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM x402_payments WHERE payer = ? AND status = 'pending'",
		)
		.bind(payer)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Insert an accepted payment. Throws on UNIQUE(payer, nonce) replay. */
export async function insertX402Payment(
	db: D1Database,
	p: X402PaymentRow,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO x402_payments
			 (payer, pay_to, asset, amount_atomic, valid_after, valid_before, nonce,
			  signature, authorization_json, resource, status, tx_hash, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
		)
		.bind(
			p.payer,
			p.payTo,
			p.asset,
			p.amountAtomic,
			p.validAfter,
			p.validBefore,
			p.nonce,
			p.signature,
			p.authorizationJson,
			p.resource,
			p.status,
			p.txHash,
		)
		.run();
}
