/**
 * Minimal ABI-encoding helpers for building decoder fixtures.
 *
 * Not a vitest suite (filename does not match *.test.ts). These pack values the
 * standard EVM way so the decoder-under-test inverts them; the packer is
 * independent logic, so a mismatch in either the encoder or the decoder shows up
 * as a failing assertion.
 */

/** uint256 as a right-aligned 32-byte word (64 hex chars, no 0x). */
export function uint(n: bigint | number): string {
	return BigInt(n).toString(16).padStart(64, "0");
}

/** address as a right-aligned 32-byte word. */
export function addrWord(a: string): string {
	return a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

/** a 32-byte id (bytes32), right-aligned into a full word. */
export function bytes32(hex: string): string {
	return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

/** bool as a 32-byte word. */
export function boolWord(b: boolean): string {
	return uint(b ? 1 : 0);
}

/** a bytes4 selector left-aligned into a 32-byte word. */
export function selectorWord(sel: string): string {
	return sel.replace(/^0x/, "").toLowerCase().slice(0, 8).padEnd(64, "0");
}

/** utf8 string as { lenWord, dataHex } where dataHex is padded to a word. */
export function utf8(s: string): { lenWord: string; dataHex: string } {
	const bytes = new TextEncoder().encode(s);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
	return { lenWord: uint(bytes.length), dataHex: padded };
}

/** join words + "0x" prefix. */
export function encode(...words: string[]): string {
	return `0x${words.join("")}`;
}
