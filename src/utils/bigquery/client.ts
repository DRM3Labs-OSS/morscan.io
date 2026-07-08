/**
 * BigQuery REST client for the optional MorScan dual-write (off by default;
 * see docs/architecture/bigquery-dual-write.md).
 *
 * D1 is the transactional write target and remains source of truth. BQ is an
 * optional analytics archive; it is written from `ctx.waitUntil(...)` hooks
 * off the sync path so it cannot block or fail the DO sync loop. If BQ is
 * unreachable the sync continues; a later backfill pass can close the gap.
 */

import type { Env } from "../../types";

const BQ_SCOPE = "https://www.googleapis.com/auth/bigquery";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

interface ServiceAccountKey {
	client_email: string;
	private_key: string;
	project_id: string;
}

interface TokenCache {
	token: string;
	expiresAt: number;
}

let cachedToken: TokenCache | null = null;

// --- JWT signing with Web Crypto (RS256) ---

function base64url(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToArrayBuffer(str: string): ArrayBuffer {
	const arr = new TextEncoder().encode(str);
	return new Uint8Array(arr).buffer as ArrayBuffer;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
	const b64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s/g, "");
	const binary = atob(b64);
	const buf = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
	return buf.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const keyData = pemToArrayBuffer(pem);
	return crypto.subtle.importKey(
		"pkcs8",
		keyData,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

async function signJwt(key: ServiceAccountKey): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		iss: key.client_email,
		scope: BQ_SCOPE,
		aud: TOKEN_URI,
		iat: now,
		exp: now + 3600,
	};
	const headerB64 = base64url(strToArrayBuffer(JSON.stringify(header)));
	const payloadB64 = base64url(strToArrayBuffer(JSON.stringify(payload)));
	const signingInput = `${headerB64}.${payloadB64}`;
	const cryptoKey = await importPrivateKey(key.private_key);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		cryptoKey,
		strToArrayBuffer(signingInput),
	);
	return `${signingInput}.${base64url(signature)}`;
}

// --- Token exchange ---

async function getAccessToken(key: ServiceAccountKey): Promise<string> {
	if (cachedToken && cachedToken.expiresAt > Date.now() + 300_000) {
		return cachedToken.token;
	}
	const jwt = await signJwt(key);
	const resp = await fetch(TOKEN_URI, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
	});
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`BQ token exchange failed (${resp.status}): ${text}`);
	}
	const data = await resp.json<{ access_token: string; expires_in: number }>();
	cachedToken = {
		token: data.access_token,
		expiresAt: Date.now() + data.expires_in * 1000,
	};
	return data.access_token;
}

function parseServiceAccountKey(base64Json: string): ServiceAccountKey {
	const json = atob(base64Json);
	return JSON.parse(json);
}

// --- insertAll ---

export interface BqRow {
	insertId?: string;
	json: Record<string, unknown>;
}

export async function insertRows(
	env: Env,
	tableId: string,
	rows: BqRow[],
): Promise<void> {
	if (rows.length === 0) return;
	if (!isBqEnabled(env)) return;

	const serviceAccountKey = env.BIGQUERY_SERVICE_ACCOUNT_KEY;
	if (!serviceAccountKey) return;

	const key = parseServiceAccountKey(serviceAccountKey);
	const token = await getAccessToken(key);
	const projectId = env.BIGQUERY_PROJECT_ID || key.project_id;
	const datasetId = env.BIGQUERY_DATASET_ID || "drm3_morscan";

	// BQ insertAll is capped at 500 rows per call.
	for (let i = 0; i < rows.length; i += 500) {
		const slice = rows.slice(i, i + 500);
		const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${datasetId}/tables/${tableId}/insertAll`;
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				kind: "bigquery#tableDataInsertAllRequest",
				rows: slice,
			}),
		});
		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(
				`BQ insert to ${tableId} failed (${resp.status}): ${text.slice(0, 500)}`,
			);
		}
		const result = await resp.json<{
			insertErrors?: Array<{
				index: number;
				errors: Array<{ reason: string; message: string }>;
			}>;
		}>();
		if (result.insertErrors && result.insertErrors.length > 0) {
			const first = result.insertErrors[0];
			throw new Error(
				`BQ insert error in ${tableId} row ${first.index}: ${first.errors[0]?.message}`,
			);
		}
	}
}

export function isBqEnabled(env: Env): boolean {
	return env.BIGQUERY_ENABLED === "true" && !!env.BIGQUERY_SERVICE_ACCOUNT_KEY;
}

/**
 * Fire-and-forget BQ write. Intended for use inside `ctx.waitUntil(...)`.
 * Swallows errors after logging so a BQ outage never propagates into the
 * sync path. On error the row stays out of BQ until the next backfill.
 */
export async function writeBqSafe(
	env: Env,
	tableId: string,
	rows: BqRow[],
): Promise<void> {
	if (!isBqEnabled(env) || rows.length === 0) return;
	try {
		await insertRows(env, tableId, rows);
	} catch (e) {
		console.error(
			`[bq] ${tableId} write failed (${rows.length} rows):`,
			e instanceof Error ? e.message : e,
		);
	}
}
