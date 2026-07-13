#!/usr/bin/env node
// Verify a MorScan provenance receipt against the published public keys.
//
//   npm run verify:receipt                          # checks /mor/v1/price
//   node scripts/verify-receipt.mjs <endpoint-url>  # any signed endpoint
//
// What this proves: the receipt's Ed25519 signature verifies against the
// public key embedded in it, AND that key is one MorScan publishes at
// /.well-known/morscan-keys.json with a validity window covering the
// receipt's timestamp. In other words: the response was attested by the
// holder of MorScan's signing key, not merely self-asserted.
//
// The signing payload is DRM3 canonical JSON (receipt-spec 1.1): the base
// receipt fields with sorted keys and the optional ones (cost, duration_ms,
// parent_id, metadata) present as null when absent, PLUS any spec-1.1 fields
// (purpose, caller, inputs, outputs, content_sig) that are set - inserted only
// when present, so a 1.0 receipt canonicalizes byte-identically. When the
// receipt carries content_sig, we also re-derive the served body (minus its
// receipt field) and check the Ed25519 content signature over those bytes.

import { ed25519 } from "@noble/curves/ed25519.js";

const url = process.argv[2] || "https://morscan.io/mor/v1/price";
const origin = new URL(url).origin;

// DRM3 canonical JSON: recursively sort object keys, compact output.
function canonicalize(v) {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
	const keys = Object.keys(v).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
}

// 1. Fetch the signed endpoint and pull out its receipt. Endpoints embed it
//    as `_provenance_aggregate` (aggregate data responses), `_provenance`
//    (single-entity detail responses), or `receipt` (/version). Track which
//    field so step 2b can re-derive the content-bound body.
const body = await (await fetch(url)).json();
let receipt = null;
let receiptField = null;
for (const f of ["_provenance_aggregate", "_provenance", "receipt"]) {
	if (body[f]?.signature) {
		receipt = body[f];
		receiptField = f;
		break;
	}
}
if (!receipt?.signature) {
	// Honest unsigned mode: an instance can run with PROVENANCE_ENABLED=false
	// (or no MORSCAN_MNEMONIC). Its /version says so; report that rather than
	// implying tampering.
	try {
		const version = await (await fetch(`${origin}/version`)).json();
		if (version.provenance === "disabled") {
			console.error(
				`UNSIGNED: ${origin} runs with PROVENANCE_ENABLED=false - responses carry no receipts, so there is nothing to verify.`,
			);
			process.exit(1);
		}
	} catch {
		/* fall through to the generic message */
	}
	console.error(`FAIL: no provenance receipt found in ${url}`);
	process.exit(1);
}

// 2. Rebuild the exact bytes that were signed and verify the signature. The
//    payload is the base fields plus any spec-1.1 fields present (inserted only
//    when set, matching the core's build_signing_payload).
const SPEC11 = ["purpose", "caller", "inputs", "outputs", "content_sig"];
const payloadObj = {
	id: receipt.id,
	action: receipt.action,
	timestamp: receipt.timestamp,
	input_hash: receipt.input_hash,
	output_hash: receipt.output_hash,
	cost: receipt.cost ?? null,
	duration_ms: receipt.duration_ms ?? null,
	parent_id: receipt.parent_id ?? null,
	metadata: receipt.metadata ?? null,
	public_key: receipt.public_key,
};
for (const k of SPEC11) {
	if (receipt[k] !== undefined && receipt[k] !== null) payloadObj[k] = receipt[k];
}
const payload = canonicalize(payloadObj);
const sig = Buffer.from(receipt.signature.replace("ed25519:", ""), "hex");
const pub = Buffer.from(receipt.public_key.replace("ed25519:", ""), "hex");
const sigOk = ed25519.verify(sig, new TextEncoder().encode(payload), pub);

// 2b. If the receipt binds the served body (content_sig, receipt-spec 1.1),
//     re-derive those bytes - the response body minus its receipt field,
//     canonicalized the same way - and check the Ed25519 content signature.
//     null = no body binding on this receipt (nothing to check).
let contentOk = null;
if (receipt.content_sig && receiptField) {
	const content = { ...body };
	delete content[receiptField];
	const csig = Buffer.from(receipt.content_sig.replace("ed25519:", ""), "hex");
	contentOk = ed25519.verify(csig, new TextEncoder().encode(canonicalize(content)), pub);
}

// 3. Confirm the signing key is one MorScan actually publishes, and that its
//    validity window covers the receipt timestamp.
const keys = await (await fetch(`${origin}/.well-known/morscan-keys.json`)).json();
const published = [...(keys.current || []), ...(keys.history || [])].find(
	(k) =>
		k.key === receipt.public_key &&
		new Date(receipt.timestamp) >= new Date(k.valid_from) &&
		new Date(receipt.timestamp) <= new Date(k.valid_until || "9999-01-01"),
);

const ok = sigOk && !!published && contentOk !== false;
console.log(`${ok ? "PASS" : "FAIL"}: ${receipt.id} (${receipt.action}) from ${url}`);
console.log(`  signature: ${sigOk ? "valid Ed25519" : "INVALID"}`);
console.log(
	`  key: ${published ? `published as ${published.path} (${published.status})` : "NOT in /.well-known/morscan-keys.json"}`,
);
console.log(
	`  body binding: ${contentOk === null ? "none (receipt attests summary only)" : contentOk ? "content_sig valid (served body matches)" : "content_sig INVALID (body altered)"}`,
);
process.exit(ok ? 0 : 1);
