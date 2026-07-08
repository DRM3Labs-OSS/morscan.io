/**
 * Sync ABI Decoders
 *
 * Pure ABI decoding for Diamond contract responses plus hex utilities.
 * No network I/O - see parsers-rpc.ts for the eth_call infrastructure.
 */

// Pad number to 32 bytes hex
export function padUint256(n: number): string {
	return n.toString(16).padStart(64, "0");
}

// Decode hex string to UTF-8 (Cloudflare Workers compatible - no Buffer)
export function hexToString(hex: string): string {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
	}
	return new TextDecoder().decode(bytes);
}

// Pad address to 32 bytes
export function padAddress(addr: string): string {
	return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

// Parse provider result - returns null if deleted or invalid
export function parseProviderResult(
	result: string,
	addr: string,
): { endpoint: string; stake: string; createdAt: number } | null {
	if (result === "0x" || result.length < 256) {
		// result too short
		return null;
	}

	try {
		const stake = BigInt(`0x${result.slice(130, 194)}`).toString();
		const createdAt = parseInt(result.slice(194, 258), 16);
		const isDeletedByte = result.slice(448, 450);
		const isDeleted = isDeletedByte !== "00";

		if (isDeleted) {
			// deleted provider
			return null;
		}

		const strOffsetRel = parseInt(result.slice(66, 130), 16);
		const strLenPos = 32 + strOffsetRel;
		const strLenHexPos = 2 + strLenPos * 2;
		if (strLenHexPos + 64 > result.length) return null;
		const strLen = parseInt(result.slice(strLenHexPos, strLenHexPos + 64), 16);
		if (strLen > 500) return null; // Provider endpoints shouldn't be 500+ chars
		const strDataPos = strLenHexPos + 64;
		if (strDataPos + strLen * 2 > result.length) return null;
		const endpointHex = result.slice(strDataPos, strDataPos + strLen * 2);
		const endpoint = hexToString(endpointHex);

		// parsed ok
		return { endpoint, stake, createdAt };
	} catch (e) {
		console.error(`[parseProvider] ${addr}: parse error`, e);
		return null;
	}
}

// Parse array result (bytes32[]) - returns list of hex IDs
export function parseArrayResult(result: string): string[] {
	if (result === "0x" || result.length < 66) return [];

	const arrayOffset = parseInt(result.slice(2, 66), 16) * 2 + 2;
	const arrayLen = parseInt(result.slice(arrayOffset, arrayOffset + 64), 16);

	const items: string[] = [];
	for (let i = 0; i < arrayLen; i++) {
		const start = arrayOffset + 64 + i * 64;
		const item = `0x${result.slice(start, start + 64)}`;
		items.push(item);
	}
	return items;
}

// Parse bid result
// Bid struct returned DIRECTLY (no tuple offset):
// [0-32] (chars 2-66): provider address (right-aligned, chars 26-66)
// [32-64] (chars 66-130): modelId (bytes32)
// [64-96] (chars 130-194): pricePerSecond (uint256)
// [96-128] (chars 194-258): nonce (uint256)
// [128-160] (chars 258-322): createdAt (uint128 in 32-byte slot)
// [160-192] (chars 322-386): deletedAt (uint128 in 32-byte slot)
export function parseBidResult(result: string): {
	provider: string;
	modelId: string;
	pricePerSecond: string;
	nonce: number;
	createdAt: number;
	deletedAt: number;
} | null {
	if (result === "0x" || result.length < 386) return null;

	try {
		// Provider is in first 32-byte slot, right-aligned (last 20 bytes = 40 chars)
		const provider = `0x${result.slice(26, 66)}`;
		const modelId = `0x${result.slice(66, 130)}`;
		const pricePerSecond = BigInt(`0x${result.slice(130, 194)}`).toString();
		const nonce = parseInt(result.slice(194, 258), 16);
		const createdAt = parseInt(result.slice(258, 322), 16);
		const deletedAt = parseInt(result.slice(322, 386), 16);

		return { provider, modelId, pricePerSecond, nonce, createdAt, deletedAt };
	} catch (e) {
		console.error("[parseBid] error", e);
		return null;
	}
}

// Parse session result (without provider/modelId - those come from bid)
// Session struct layout:
// [0-32]: user address
// [32-64]: bidId
// [64-96]: stake
// [96-128]: closeoutReceipt offset
// [128-160]: closeoutType (0=normal, 1=dispute)
// [160-192]: providerWithdrawnAmount
// [192-224]: openedAt
// [224-256]: endsAt
// [256-288]: closedAt
// [288-320]: isActive
// [320-352]: isDirectPaymentFromUser
export function parseSessionResult(result: string): {
	user: string;
	bidId: string;
	stake: string;
	closeoutType: number;
	providerWithdrawn: string;
	openedAt: number;
	endsAt: number;
	closedAt: number;
	isActive: boolean;
	isEarlyTermination: boolean;
} | null {
	if (result === "0x" || result.length < 706) return null;

	try {
		const user = `0x${result.slice(90, 130)}`;
		const bidId = `0x${result.slice(130, 194)}`;
		const stake = BigInt(`0x${result.slice(194, 258)}`).toString();
		// closeoutReceipt offset at 258-322, skip it
		const closeoutType = parseInt(result.slice(322, 386), 16);
		const providerWithdrawn = BigInt(`0x${result.slice(386, 450)}`).toString();
		const openedAt = parseInt(result.slice(450, 514), 16);
		const endsAt = parseInt(result.slice(514, 578), 16);
		const closedAt = parseInt(result.slice(578, 642), 16);
		const isActive = result.slice(704, 706) !== "00";

		// Early termination = session closed before it was supposed to end
		const isEarlyTermination = closedAt > 0 && closedAt < endsAt;

		return {
			user,
			bidId,
			stake,
			closeoutType,
			providerWithdrawn,
			openedAt,
			endsAt,
			closedAt,
			isActive,
			isEarlyTermination,
		};
	} catch (e) {
		console.error("[parseSession] error", e);
		return null;
	}
}

// Parse Model result from ModelRegistry.getModel(bytes32)
// Model struct contains: modelId, ipfsCID, fee, owner, name, tags[], createdAt, isDeleted
// The name string is at a dynamic offset - we parse it from the response
export function parseModelResult(
	result: string,
): { name: string; tags: string[] } | null {
	if (result === "0x" || result.length < 400) return null;

	try {
		// Name length at ~0x120 in the response (known from testing)
		const nameOffsetStart = 578;
		if (result.length < nameOffsetStart + 64) return null;

		const nameLen = parseInt(result.slice(nameOffsetStart, nameOffsetStart + 64), 16);
		if (nameLen === 0 || nameLen > 100) return null; // Sanity check

		const nameStart = nameOffsetStart + 64;
		const nameHex = result.slice(nameStart, nameStart + nameLen * 2);
		const name = hexToString(nameHex);

		// Parse tags array - follows the name
		const tags: string[] = [];

		// Find tags section - after name padding
		const tagsArrayStart = nameStart + Math.ceil((nameLen * 2) / 64) * 64 + 64;
		if (result.length > tagsArrayStart + 64) {
			const tagCount = parseInt(result.slice(tagsArrayStart, tagsArrayStart + 64), 16);
			if (tagCount > 0 && tagCount < 20) {
				// Tags are stored as dynamic strings with offsets
				for (let t = 0; t < tagCount && t < 10; t++) {
					const tagOffsetPos = tagsArrayStart + 64 + t * 64;
					const tagRelOffset = parseInt(
						result.slice(tagOffsetPos, tagOffsetPos + 64),
						16,
					);
					const tagAbsOffset = tagsArrayStart + 64 + tagRelOffset * 2;

					if (tagAbsOffset + 64 < result.length) {
						const tagLen = parseInt(result.slice(tagAbsOffset, tagAbsOffset + 64), 16);
						if (tagLen > 0 && tagLen < 50) {
							const tagHex = result.slice(
								tagAbsOffset + 64,
								tagAbsOffset + 64 + tagLen * 2,
							);
							const tagStr = hexToString(tagHex);
							if (tagStr) tags.push(tagStr);
						}
					}
				}
			}
		}

		return { name, tags };
	} catch (e) {
		console.error("[parseModel] error", e);
		return null;
	}
}
