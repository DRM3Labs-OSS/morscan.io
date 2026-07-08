/**
 * Shared cryptographic utilities - keccak256, ecrecover, hex conversions.
 *
 * Extracted from wallet-auth.ts so both EIP-712 request auth and
 * EIP-191 attestation verification can share the same primitives.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/** keccak256 hash of arbitrary bytes. */
export function keccak256(data: Uint8Array): Uint8Array {
	return keccak_256(data);
}

/**
 * Recover the signer's Ethereum address from a secp256k1 signature.
 *
 * @param messageHash - 32-byte hash of the signed message
 * @param sigHex - 65-byte signature as hex string (r || s || v)
 * @returns Checksumless lowercase Ethereum address (0x-prefixed)
 */
export function ecrecover(messageHash: Uint8Array, sigHex: string): string {
	const sigBytes = hexToBytes(sigHex);
	if (sigBytes.length !== 65) {
		throw new Error(`Signature must be 65 bytes, got ${sigBytes.length}`);
	}

	const r = sigBytes.slice(0, 32);
	const s = sigBytes.slice(32, 64);
	let v = sigBytes[64];

	// Normalize v: EIP-155 uses 27/28, @noble/curves uses 0/1
	if (v >= 27) v -= 27;
	if (v !== 0 && v !== 1) {
		throw new Error(`Invalid recovery id: ${v}`);
	}

	const rBig = bytesToBigInt(r);
	const sBig = bytesToBigInt(s);

	const sig = new secp256k1.Signature(rBig, sBig, v);
	const pubkey = sig.recoverPublicKey(messageHash);

	// Uncompressed public key (65 bytes: 0x04 || x || y) - skip the 0x04 prefix
	const pubkeyBytes = pubkey.toBytes(false).slice(1); // 64 bytes

	// Ethereum address = last 20 bytes of keccak256(pubkey_bytes)
	const hash = keccak256(pubkeyBytes);
	const address = hash.slice(12);

	return `0x${bytesToHex(address)}`;
}

/**
 * EIP-191 personal_sign digest of a UTF-8 message:
 * keccak256("\x19Ethereum Signed Message:\n" + byteLength + message).
 * Feed the result to ecrecover() to recover the personal_sign signer.
 */
export function eip191Digest(message: string): Uint8Array {
	const enc = new TextEncoder();
	const msgBytes = enc.encode(message);
	const prefix = enc.encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
	const buf = new Uint8Array(prefix.length + msgBytes.length);
	buf.set(prefix, 0);
	buf.set(msgBytes, prefix.length);
	return keccak256(buf);
}

/** Decode a hex string (with or without 0x prefix) to bytes. */
export function hexToBytes(hex: string): Uint8Array {
	const h = hex.startsWith("0x") ? hex.slice(2) : hex;
	if (h.length % 2 !== 0) throw new Error("Invalid hex string");
	const bytes = new Uint8Array(h.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/** Encode bytes to a lowercase hex string (no 0x prefix). */
export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

/** Convert a big-endian byte array to a BigInt. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
	let result = 0n;
	for (let i = 0; i < bytes.length; i++) {
		result = (result << 8n) | BigInt(bytes[i]);
	}
	return result;
}
