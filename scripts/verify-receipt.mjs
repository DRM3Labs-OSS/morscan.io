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
// The signing payload is DRM3 canonical JSON (receipt-spec 1.0): the receipt
// fields with sorted keys, compact separators, and the optional fields
// (cost, duration_ms, parent_id, metadata) present as null when absent.

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
//    as `_provenance_aggregate` (data responses) or `receipt` (/version).
const body = await (await fetch(url)).json();
const receipt = body._provenance_aggregate || body.receipt;
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

// 2. Rebuild the exact bytes that were signed and verify the signature.
const payload = canonicalize({
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
});
const sig = Buffer.from(receipt.signature.replace("ed25519:", ""), "hex");
const pub = Buffer.from(receipt.public_key.replace("ed25519:", ""), "hex");
const sigOk = ed25519.verify(sig, new TextEncoder().encode(payload), pub);

// 3. Confirm the signing key is one MorScan actually publishes, and that its
//    validity window covers the receipt timestamp.
const keys = await (await fetch(`${origin}/.well-known/morscan-keys.json`)).json();
const published = [...(keys.current || []), ...(keys.history || [])].find(
	(k) =>
		k.key === receipt.public_key &&
		new Date(receipt.timestamp) >= new Date(k.valid_from) &&
		new Date(receipt.timestamp) <= new Date(k.valid_until || "9999-01-01"),
);

const ok = sigOk && !!published;
console.log(`${ok ? "PASS" : "FAIL"}: ${receipt.id} (${receipt.action}) from ${url}`);
console.log(`  signature: ${sigOk ? "valid Ed25519" : "INVALID"}`);
console.log(
	`  key: ${published ? `published as ${published.path} (${published.status})` : "NOT in /.well-known/morscan-keys.json"}`,
);
process.exit(ok ? 0 : 1);
