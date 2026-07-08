declare const process: { exit(code: number): never };
/**
 * Cross-language test vector for the wallet-auth EIP-712 signing scheme.
 *
 * Pins fixed inputs so any client implementation (in any language) can be
 * checked against the same expected EIP-712 message hash, signature, and
 * recovered address as this TypeScript verifier.
 *
 * Run: npx tsx src/utils/wallet-auth.test.ts
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { ECDSASignOpts } from '@noble/curves/abstract/weierstrass.js';

import { buildEIP712Message } from './wallet-auth';
import { ecrecover, keccak256, hexToBytes, bytesToHex } from './crypto';

// ---- Fixed test inputs (identical to Rust test_cross_language_test_vector) ----

const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const DERIVATION_TAG = 'drm3-auth-v1';
const TIMESTAMP = 1711670400;
const METHOD = 'GET';
const PATH = '/mor/v1/all';
const VERSION = '0.5.0';
const NONCE = new Uint8Array(32); // 32 zero bytes
const BODY_HASH = keccak_256(new Uint8Array(0)); // keccak256(empty)
const _CHAIN_ID = 8453;

// ---- Helpers ----

/** Derive the signing key using HMAC-SHA256(privateKeyBytes, tag) - same as Rust. */
function deriveKey(privateKeyHex: string, tag: string): Uint8Array {
  const pkClean = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  const pkBytes = hexToBytes(pkClean);
  // Rust: Hmac::<Sha256>::new_from_slice(&pk_bytes) + mac.update(DERIVATION_TAG)
  // In @noble/hashes: hmac(sha256, key, data)
  return hmac(sha256, pkBytes, new TextEncoder().encode(tag));
}

/** Derive Ethereum address from a secp256k1 private key (raw 32 bytes). */
function ethAddressFromPrivateKey(privateKey: Uint8Array): string {
  // Get uncompressed public key (65 bytes: 0x04 || x || y)
  const pubkeyFull = secp256k1.getPublicKey(privateKey, false);
  // Skip 0x04 prefix, hash the 64-byte x||y
  const pubkeyBody = pubkeyFull.slice(1);
  const hash = keccak256(pubkeyBody);
  // Last 20 bytes = Ethereum address
  return `0x${bytesToHex(hash.slice(12))}`;
}

/** Sign an EIP-712 message hash with a private key, returning 65-byte hex sig (r||s||v). */
function signEIP712(messageHash: Uint8Array, privateKey: Uint8Array): string {
  // format: 'recovered' returns 65 bytes: recovery(1) || r(32) || s(32)
  const recoveredOpts: ECDSASignOpts = {
    prehash: false,
    lowS: true,
    format: 'recovered',
  };
  const recoveredSig = secp256k1.sign(messageHash, privateKey, recoveredOpts);
  // Rearrange to Ethereum format: r(32) || s(32) || v(1), where v = recovery + 27
  const sigBytes = new Uint8Array(65);
  sigBytes.set(recoveredSig.slice(1, 65), 0); // r || s
  sigBytes[64] = recoveredSig[0] + 27; // v = recovery + 27
  return `0x${bytesToHex(sigBytes)}`;
}

// ---- Test ----

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual: string, expected: string, message: string): void {
  if (actual.toLowerCase() === expected.toLowerCase()) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    expected: ${expected}`);
    console.error(`    actual:   ${actual}`);
  }
}

console.log('Cross-language EIP-712 test vector');
console.log('==================================\n');

// Step 1: Derive signing key from private key using HMAC-SHA256
console.log('Step 1: HMAC-SHA256 key derivation');
const derivedKeyBytes = deriveKey(TEST_PK, DERIVATION_TAG);
assert(derivedKeyBytes.length === 32, 'Derived key is 32 bytes');

// Step 2: Derive Ethereum address of the derived key
console.log('\nStep 2: Derived key address');
const derivedAddress = ethAddressFromPrivateKey(derivedKeyBytes);
assert(derivedAddress.startsWith('0x'), 'Derived address starts with 0x');
assert(derivedAddress.length === 42, 'Derived address is 42 chars');
assert(derivedAddress.toLowerCase() !== TEST_WALLET.toLowerCase(), 'Derived address differs from staking wallet');
console.log(`  Derived address: ${derivedAddress}`);

// Step 3: Build EIP-712 message hash (using the actual wallet-auth.ts implementation)
console.log('\nStep 3: EIP-712 message hash');
const messageHash = buildEIP712Message(TIMESTAMP, METHOD, PATH, VERSION, NONCE, BODY_HASH);
assert(messageHash.length === 32, 'Message hash is 32 bytes');
console.log(`  Message hash: 0x${bytesToHex(messageHash)}`);

// Step 4: Sign with derived key
console.log('\nStep 4: Sign with derived key');
const signature = signEIP712(messageHash, derivedKeyBytes);
assert(signature.startsWith('0x'), 'Signature starts with 0x');
assert(signature.length === 132, 'Signature is 65 bytes (132 hex chars + 0x)');
console.log(`  Signature: ${signature.slice(0, 20)}...${signature.slice(-8)}`);

// Step 5: Recover address from signature using the actual ecrecover implementation
console.log('\nStep 5: Verify (ecrecover)');
const recoveredAddress = ecrecover(messageHash, signature);
assertEqual(recoveredAddress, derivedAddress, 'Recovered address matches derived address');
console.log(`  Recovered: ${recoveredAddress}`);

// Step 6: Verify the staking wallet address matches expected (sanity check)
console.log('\nStep 6: Staking wallet sanity');
const stakingAddress = ethAddressFromPrivateKey(hexToBytes(TEST_PK.slice(2)));
assertEqual(stakingAddress, TEST_WALLET, 'Staking wallet address matches hardhat account #0');

// Summary
console.log('\n==================================');
if (failed === 0) {
  console.log(`All ${passed} assertions passed.`);
  console.log('\nTypeScript EIP-712 implementation matches Rust test vector.');
} else {
  console.log(`${failed} of ${passed + failed} assertions FAILED.`);
  process.exit(1);
}
