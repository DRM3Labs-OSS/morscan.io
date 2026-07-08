import { describe, expect, it } from "vitest";
import {
	parseAllSubnetsData,
	parseAllSubnetsDataV4,
	parseBuilderClaimEvent,
	parseBuilderStakeEvent,
	parseSubnetsData,
} from "../../src/sync/builder-parsers-decode";
import { addrWord, encode, uint } from "./_helpers";

describe("builder fixed-slot reads", () => {
	it("parseAllSubnetsData decodes rate + totalStaked", () => {
		expect(parseAllSubnetsData(encode(uint(5), uint(1000)))).toEqual({
			rate: "5",
			totalStaked: "1000",
		});
	});

	it("parseAllSubnetsData returns zeros on short input (no throw)", () => {
		expect(parseAllSubnetsData("0x")).toEqual({ rate: "0", totalStaked: "0" });
	});

	it("parseAllSubnetsDataV4 decodes the 4-word struct", () => {
		expect(
			parseAllSubnetsDataV4(encode(uint(10), uint(20), uint(30), uint(1_700_000_000))),
		).toEqual({
			undistributed: "10",
			distributed: "20",
			claimed: "30",
			lastUpdate: 1_700_000_000,
		});
	});

	it("parseSubnetsData decodes rate/totalStaked/pendingRewards", () => {
		const big = 12_345_678_900_000_000_000n; // > MAX_SAFE_INTEGER, must survive as string
		expect(parseSubnetsData(encode(uint(1), uint(big), uint(3)))).toEqual({
			rate: "1",
			totalStaked: big.toString(),
			pendingRewards: "3",
		});
	});
});

describe("builder event decoders", () => {
	const subnetId = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
	const wallet = "0x3333333333333333333333333333333333333333";

	it("parseBuilderStakeEvent pulls subnetId, wallet, amount from topics+data", () => {
		const log = {
			topics: ["0xsig", subnetId, `0x${addrWord(wallet)}`],
			data: encode(uint(2_500)),
		};
		expect(parseBuilderStakeEvent(log)).toEqual({
			subnetId: subnetId.toLowerCase(),
			wallet: wallet.toLowerCase(),
			amount: "2500",
		});
	});

	it("parseBuilderStakeEvent returns null when indexed topics are missing", () => {
		expect(parseBuilderStakeEvent({ topics: ["0xsig"], data: "0x" })).toBeNull();
	});

	it("parseBuilderClaimEvent decodes receiver + amount from data (2 topics)", () => {
		const receiver = "0x4444444444444444444444444444444444444444";
		const log = {
			topics: ["0xsig", subnetId],
			data: encode(addrWord(receiver), uint(9_000)),
		};
		expect(parseBuilderClaimEvent(log)).toEqual({
			subnetId: subnetId.toLowerCase(),
			receiver: receiver.toLowerCase(),
			pendingRewards: "9000",
		});
	});
});
