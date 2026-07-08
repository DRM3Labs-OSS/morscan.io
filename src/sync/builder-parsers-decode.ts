/**
 * Builder Staking Decoders - ABI decoding for BuildersV4 reads + event logs.
 *
 * Pure decode logic + hex/padding utilities. No network I/O - see
 * builder-parsers-rpc.ts for the eth_call infrastructure.
 */

/** Safe hex to bigint - returns 0n on invalid input */
function safeBigInt(hex: string): bigint {
	try {
		if (!hex || hex === "0x" || hex.length < 2) return 0n;
		return BigInt(`0x${hex.replace(/^0x/, "")}`);
	} catch {
		return 0n;
	}
}

/** Decode hex string to UTF-8 */
function hexToUtf8(hex: string): string {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return new TextDecoder().decode(bytes);
}

/** Pad a bytes32 value (no 0x prefix needed on input) */
export function padBytes32(value: string): string {
	return value.replace(/^0x/, "").padStart(64, "0");
}

/** Pad an address to 32 bytes */
export function padAddress(addr: string): string {
	return addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

/** Parse allSubnetsData() → { rate, totalStaked } */
export function parseAllSubnetsData(result: string): {
	rate: string;
	totalStaked: string;
} {
	const data = result.replace(/^0x/, "");
	if (data.length < 128) return { rate: "0", totalStaked: "0" };
	return {
		rate: safeBigInt(data.slice(0, 64)).toString(),
		totalStaked: safeBigInt(data.slice(64, 128)).toString(),
	};
}

/** Parse allSubnetsDataV4() → { undistributed, distributed, claimed, lastUpdate } */
export function parseAllSubnetsDataV4(result: string): {
	undistributed: string;
	distributed: string;
	claimed: string;
	lastUpdate: number;
} {
	const data = result.replace(/^0x/, "");
	if (data.length < 256)
		return { undistributed: "0", distributed: "0", claimed: "0", lastUpdate: 0 };
	return {
		undistributed: safeBigInt(data.slice(0, 64)).toString(),
		distributed: safeBigInt(data.slice(64, 128)).toString(),
		claimed: safeBigInt(data.slice(128, 192)).toString(),
		lastUpdate: Number(safeBigInt(data.slice(192, 256))),
	};
}

/**
 * Parse subnetsData(bytes32) → { rate, totalStaked, pendingRewards }
 *
 * Field mapping (confirmed against Morpheus Dashboard / Goldsky subgraph):
 *   Word 0: rate
 *   Word 1: totalStaked (MOR staked on this subnet - the primary deposit metric)
 *   Word 2: pendingRewards (unclaimed builder rewards)
 */
export function parseSubnetsData(result: string): {
	rate: string;
	totalStaked: string;
	pendingRewards: string;
} {
	const data = result.replace(/^0x/, "");
	if (data.length < 192) return { rate: "0", totalStaked: "0", pendingRewards: "0" };
	return {
		rate: safeBigInt(data.slice(0, 64)).toString(),
		totalStaked: safeBigInt(data.slice(64, 128)).toString(),
		pendingRewards: safeBigInt(data.slice(128, 192)).toString(),
	};
}

/** Parse UserDeposited/UserWithdrawn event log → { subnetId, wallet, amount } */
export function parseBuilderStakeEvent(log: { topics: string[]; data: string }): {
	subnetId: string;
	wallet: string;
	amount: string;
} | null {
	if (!log.topics || log.topics.length < 3) return null;
	const subnetId = log.topics[1].toLowerCase();
	const wallet = `0x${log.topics[2].slice(26).toLowerCase()}`; // address is right-padded in 32 bytes
	const amount = safeBigInt(log.data.replace(/^0x/, "")).toString();
	return { subnetId, wallet, amount };
}

/** Parse AdminClaimed event → { subnetId, receiver, pendingRewards }
 * AdminClaimed has 2 topics (sig + subnetId). Data contains receiver + amount.
 */
export function parseBuilderClaimEvent(log: { topics: string[]; data: string }): {
	subnetId: string;
	receiver: string;
	pendingRewards: string;
} | null {
	if (!log.topics || log.topics.length < 2) return null;
	const data = log.data.replace(/^0x/, "");
	const receiver = data.length >= 64 ? `0x${data.slice(24, 64).toLowerCase()}` : "";
	const amount =
		data.length >= 128
			? safeBigInt(data.slice(64, 128)).toString()
			: safeBigInt(data).toString();
	return {
		subnetId: log.topics[1].toLowerCase(),
		receiver,
		pendingRewards: amount,
	};
}

/**
 * Parse SubnetCreated event data.
 *
 * Event: SubnetCreated(bytes32 indexed subnetId, (string name, address admin, address claimAdmin, uint256 minimalDeposit, uint256 withdrawLockPeriod))
 * topics[1] = subnetId (indexed)
 * data = ABI-encoded Subnet struct tuple (contains dynamic string)
 *
 * ABI layout of tuple with dynamic string:
 *   Word 0: offset to tuple start (0x20)
 *   Word 1: offset to string within tuple (relative to tuple start)
 *   Word 2: admin (address, right-padded in 32 bytes)
 *   Word 3: claimAdmin (address)
 *   Word 4: minimalDeposit (uint256)
 *   Word 5: withdrawLockPeriod (uint256)
 *   Word 6+: string length + string data (at the offset from word 1)
 */
export function parseSubnetCreatedEvent(log: { topics: string[]; data: string }): {
	subnetId: string;
	name: string;
	admin: string;
	claimAdmin: string;
	minimalDeposit: string;
	withdrawLockPeriod: number;
} | null {
	if (!log.topics || log.topics.length < 2) return null;
	const subnetId = log.topics[1].toLowerCase();
	const data = log.data.replace(/^0x/, "");
	if (data.length < 384) return null; // minimum 6 words

	try {
		// ABI-encoded tuple with a dynamic string. Word 0 is the outer offset
		// (0x20); the tuple starts at byte 32 (hex char 64). Within the tuple:
		// word 0 = string offset, word 1 = admin, word 2 = claimAdmin,
		// word 3 = minimalDeposit, word 4 = withdrawLockPeriod, then the string.
		const tupleStart = 64; // hex chars

		// Word 1 of tuple: offset to string data (relative to tuple start)
		// Word 2: admin
		const adminHex = data.slice(tupleStart + 64, tupleStart + 128);
		const admin = `0x${adminHex.slice(24).toLowerCase()}`;

		// Word 3: claimAdmin
		const claimAdminHex = data.slice(tupleStart + 128, tupleStart + 192);
		const claimAdmin = `0x${claimAdminHex.slice(24).toLowerCase()}`;

		// Word 4: minimalDeposit
		const minimalDeposit = safeBigInt(
			data.slice(tupleStart + 192, tupleStart + 256),
		).toString();

		// Word 5: withdrawLockPeriod
		const withdrawLockPeriod = Number(
			safeBigInt(data.slice(tupleStart + 256, tupleStart + 320)),
		);

		// String: offset from tuple start tells us where it is
		const stringOffsetBytes = Number(safeBigInt(data.slice(tupleStart, tupleStart + 64)));
		const stringStart = tupleStart + stringOffsetBytes * 2; // convert bytes to hex chars
		const stringLen = Number(safeBigInt(data.slice(stringStart, stringStart + 64)));
		const stringDataHex = data.slice(stringStart + 64, stringStart + 64 + stringLen * 2);
		const name = hexToUtf8(stringDataHex);

		return { subnetId, name, admin, claimAdmin, minimalDeposit, withdrawLockPeriod };
	} catch (e) {
		console.error("[parseSubnetCreatedEvent] Failed to decode:", e);
		return null;
	}
}

/**
 * Parse subnets(bytes32) → { name, admin, claimAdmin, minimalDeposit, withdrawLockPeriod }
 *
 * ABI layout (struct with dynamic string):
 *   Word 0: offset to string data (relative to start)
 *   Word 1: admin (address)
 *   Word 2: claimAdmin (address)
 *   Word 3: minimalDeposit (uint256)
 *   Word 4: withdrawLockPeriod (uint256)
 *   [string data at offset]: length + bytes
 */
export function parseSubnetStruct(result: string): {
	name: string;
	admin: string;
	claimAdmin: string;
	minimalDeposit: string;
	withdrawLockPeriod: number;
} | null {
	const data = result.replace(/^0x/, "");
	if (data.length < 320) return null; // need at least 5 words

	try {
		const admin = `0x${data.slice(64 + 24, 128).toLowerCase()}`;
		const claimAdmin = `0x${data.slice(128 + 24, 192).toLowerCase()}`;
		const minimalDeposit = safeBigInt(data.slice(192, 256)).toString();
		const withdrawLockPeriod = Number(safeBigInt(data.slice(256, 320)));

		// String at offset
		const strOffset = Number(safeBigInt(data.slice(0, 64)));
		const strStart = strOffset * 2;
		let name = "";
		if (strStart + 64 <= data.length) {
			const strLen = Number(safeBigInt(data.slice(strStart, strStart + 64)));
			if (strLen > 0 && strStart + 64 + strLen * 2 <= data.length) {
				name = hexToUtf8(data.slice(strStart + 64, strStart + 64 + strLen * 2));
			}
		}

		// Validate admin is a real address (not zero)
		if (admin === "0x0000000000000000000000000000000000000000") return null;

		return { name, admin, claimAdmin, minimalDeposit, withdrawLockPeriod };
	} catch {
		return null;
	}
}

/**
 * Parse subnetsMetadata(bytes32) → { name, description, url, logo }
 *
 * ABI layout: 4 dynamic string offsets (words 0-3), then string data.
 * Each string: length word + padded data bytes.
 * Returns empty strings on decode failure or empty metadata.
 */
export function parseSubnetMetadata(result: string): {
	name: string;
	description: string;
	url: string;
	logo: string;
} {
	const empty = { name: "", description: "", url: "", logo: "" };
	const data = result.replace(/^0x/, "");
	// Minimum: 4 offset words + 4 empty strings (4 length words) = 8 words = 512 hex chars
	// But empty metadata returns exactly 8 words with zero-length strings
	if (data.length < 512) return empty;

	try {
		const offsets = [0, 1, 2, 3].map((i) =>
			Number(safeBigInt(data.slice(i * 64, (i + 1) * 64))),
		);
		const fields: string[] = [];
		for (const offset of offsets) {
			const hexOffset = offset * 2;
			if (hexOffset + 64 > data.length) {
				fields.push("");
				continue;
			}
			const len = Number(safeBigInt(data.slice(hexOffset, hexOffset + 64)));
			if (len === 0 || hexOffset + 64 + len * 2 > data.length) {
				fields.push("");
				continue;
			}
			const strHex = data.slice(hexOffset + 64, hexOffset + 64 + len * 2);
			fields.push(hexToUtf8(strHex));
		}
		return { name: fields[0], description: fields[1], url: fields[2], logo: fields[3] };
	} catch {
		return empty;
	}
}
