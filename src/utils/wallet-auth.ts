/**
 * Wallet-signed request authentication (EIP-712).
 *
 * SDK clients sign with a DERIVED key (HMAC-SHA256 of wallet key + domain
 * tag), not the staking wallet directly. This module recovers the derived
 * signer address from the EIP-712 signature and validates the request.
 *
 * Headers expected:
 *   X-Morscan-Wallet:         derived address (the signer)
 *   X-Morscan-Ts:             unix seconds
 *   X-Morscan-Sig:            EIP-712 signature (65 bytes hex)
 *   X-Morscan-Nonce:          random 32-byte nonce (0x-prefixed hex)
 *   X-Morscan-Version:        client version (part of the signed struct)
 *   X-Morscan-Staking-Wallet: actual staking wallet (the queried identity)
 */

import { keccak256, ecrecover, hexToBytes } from "./crypto";

// ---- Public Types ----

export interface WalletAuthResult {
	valid: boolean;
	/** Derived signer address (from signature recovery) */
	derivedAddress?: string;
	/** Staking wallet address (from header, the queried identity) */
	stakingWallet?: string;
	/** SDK version */
	version?: string;
	/** Error message */
	error?: string;
	/** Server time (included on timestamp errors for client clock skew detection) */
	serverTime?: number;
}

// ---- Constants ----

const TIMESTAMP_WINDOW_SECS = 5;

/** Base mainnet chain ID - must match the signing client's chain id. */
const CHAIN_ID = 8453n;

// ---- Main Validation ----

/**
 * Validate a wallet-signed request.
 * Returns the recovered signer address and staking wallet if valid.
 */
export function validateWalletSignature(
	request: Request,
	body: Uint8Array | null,
): WalletAuthResult {
	const h = (name: string) => request.headers.get(`X-Morscan-${name}`);
	const wallet = h("Wallet");
	const tsHeader = h("Ts");
	const sig = h("Sig");
	const nonceHeader = h("Nonce");
	const version = h("Version");
	const stakingWallet = h("Staking-Wallet");

	if (!wallet || !tsHeader || !sig || !nonceHeader || !version || !stakingWallet) {
		return {
			valid: false,
			error:
				"Missing wallet auth headers (X-Morscan-Wallet, X-Morscan-Ts, X-Morscan-Sig, X-Morscan-Nonce, X-Morscan-Version, X-Morscan-Staking-Wallet)",
		};
	}

	// Validate timestamp (5-second window, Unix SECONDS not milliseconds)
	const timestamp = parseInt(tsHeader, 10);
	if (Number.isNaN(timestamp)) {
		return { valid: false, error: "Invalid timestamp" };
	}
	if (timestamp > 1e12) {
		return {
			valid: false,
			error: "Timestamp appears to be in milliseconds. Use Unix seconds.",
		};
	}
	const now = Math.floor(Date.now() / 1000);
	const drift = Math.abs(now - timestamp);
	if (drift > TIMESTAMP_WINDOW_SECS) {
		return {
			valid: false,
			error: `Timestamp expired (drift: ${drift}s, allowed: ${TIMESTAMP_WINDOW_SECS}s)`,
			serverTime: now,
		};
	}

	// Parse nonce (0x-prefixed, 32 bytes)
	const nonceBytes = hexToBytes(nonceHeader);
	if (nonceBytes.length !== 32) {
		return { valid: false, error: `Nonce must be 32 bytes, got ${nonceBytes.length}` };
	}

	// Compute bodyHash: keccak256 of body bytes (empty bytes for GET / no body)
	const bodyHash = keccak256(body ?? new Uint8Array(0));

	// Reconstruct EIP-712 message
	const url = new URL(request.url);
	const method = request.method;
	const path = url.pathname + url.search;

	const messageHash = buildEIP712Message(
		timestamp,
		method,
		path,
		version,
		nonceBytes,
		bodyHash,
	);

	// Recover signer from signature
	try {
		const recovered = ecrecover(messageHash, sig);
		if (recovered.toLowerCase() !== wallet.toLowerCase()) {
			return {
				valid: false,
				error: "Signature verification failed: recovered address does not match",
			};
		}
	} catch (e) {
		return { valid: false, error: `Signature verification failed: ${e}` };
	}

	return {
		valid: true,
		derivedAddress: wallet.toLowerCase(),
		stakingWallet: stakingWallet.toLowerCase(),
		version,
	};
}

// ---- EIP-712 Message Construction (exported for cross-language test vectors) ----

function keccak256Str(s: string): Uint8Array {
	return keccak256(new TextEncoder().encode(s));
}

/**
 * Build the EIP-712 typed data hash:
 * keccak256(0x19 0x01 || domainSeparator || structHash)
 */
export function buildEIP712Message(
	timestamp: number,
	method: string,
	path: string,
	version: string,
	nonce: Uint8Array,
	bodyHash: Uint8Array,
): Uint8Array {
	const domainSep = domainSeparator();
	const structHash = requestStructHash(timestamp, method, path, version, nonce, bodyHash);

	// 0x19 0x01 || domainSeparator || structHash
	const message = new Uint8Array(2 + 32 + 32);
	message[0] = 0x19;
	message[1] = 0x01;
	message.set(domainSep, 2);
	message.set(structHash, 34);

	return keccak256(message);
}

function domainSeparator(): Uint8Array {
	const typehash = keccak256Str(
		"EIP712Domain(string name,string version,uint256 chainId)",
	);
	const nameHash = keccak256Str("DRM3 Auth");
	const versionHash = keccak256Str("1");
	// uint256 chainId - left-padded to 32 bytes
	const chainIdBytes = uint256ToBytes(CHAIN_ID);

	const buf = new Uint8Array(128);
	buf.set(typehash, 0);
	buf.set(nameHash, 32);
	buf.set(versionHash, 64);
	buf.set(chainIdBytes, 96);

	return keccak256(buf);
}

function requestStructHash(
	timestamp: number,
	method: string,
	path: string,
	version: string,
	nonce: Uint8Array,
	bodyHash: Uint8Array,
): Uint8Array {
	const typehash = keccak256Str(
		"DRM3AuthRequest(uint256 timestamp,string method,string path,string version,bytes32 nonce,bytes32 bodyHash)",
	);

	// uint256 timestamp -- left-padded to 32 bytes (big-endian)
	const tsBytes = uint256ToBytes(BigInt(timestamp));

	const methodHash = keccak256Str(method);
	const pathHash = keccak256Str(path);
	const versionHash = keccak256Str(version);

	// typehash(32) + timestamp(32) + method(32) + path(32) + version(32) + nonce(32) + bodyHash(32) = 224 bytes
	const buf = new Uint8Array(224);
	buf.set(typehash, 0);
	buf.set(tsBytes, 32);
	buf.set(methodHash, 64);
	buf.set(pathHash, 96);
	buf.set(versionHash, 128);
	buf.set(nonce, 160);
	buf.set(bodyHash, 192);

	return keccak256(buf);
}

/**
 * Convert a BigInt to a 32-byte big-endian Uint8Array (ABI uint256 encoding).
 */
function uint256ToBytes(value: bigint): Uint8Array {
	const bytes = new Uint8Array(32);
	let v = value;
	for (let i = 31; i >= 0; i--) {
		bytes[i] = Number(v & 0xffn);
		v >>= 8n;
	}
	return bytes;
}

// ---- ECDSA Recovery and Hex Utilities imported from ./crypto ----
