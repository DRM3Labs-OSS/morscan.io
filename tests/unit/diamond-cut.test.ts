import { describe, expect, it } from "vitest";
import { parseDiamondCutData } from "../../src/sync/compute-stats";
import { addrWord, selectorWord, uint } from "./_helpers";

/**
 * DiamondCut((address facet, uint8 action, bytes4[] selectors)[], address init, bytes calldata)
 *
 * Head (3 words): FacetCut[] offset, init address, init-calldata offset.
 * FacetCut[] starts at byte 96; one element, whose struct sits right after the
 * single offset word; the struct's bytes4[] sits right after its 3 head words.
 */
function oneFacetCut(facet: string, action: number, selectors: string[]): string {
	const head = uint(96) + uint(0) + uint(0); // cuts offset (0x60), init addr, init offset
	const cutCount = uint(1);
	const structOffset = uint(32); // struct starts one word after the offsets array
	const structHead = addrWord(facet) + uint(action) + uint(96); // facet, action, bytes4[] offset
	const sel = uint(selectors.length) + selectors.map(selectorWord).join("");
	return `0x${head}${cutCount}${structOffset}${structHead}${sel}`;
}

describe("parseDiamondCutData", () => {
	it("decodes a single Add facet with two selectors", () => {
		const facet = "0x00000000000000000000000000000000000000aa";
		const data = oneFacetCut(facet, 0, ["0x12345678", "0xdeadbeef"]);
		expect(parseDiamondCutData(data)).toEqual([
			{ facet, action: "add", selectors: ["0x12345678", "0xdeadbeef"] },
		]);
	});

	it("maps the EIP-2535 action byte (0=add,1=replace,2=remove)", () => {
		const facet = "0x00000000000000000000000000000000000000bb";
		expect(parseDiamondCutData(oneFacetCut(facet, 1, ["0x11111111"]))[0]?.action).toBe(
			"replace",
		);
		expect(parseDiamondCutData(oneFacetCut(facet, 2, ["0x22222222"]))[0]?.action).toBe(
			"remove",
		);
	});

	it("returns [] for an out-of-range action rather than a bad label", () => {
		const facet = "0x00000000000000000000000000000000000000cc";
		// action 7 is not a valid EIP-2535 action -> whole decode rejected
		expect(parseDiamondCutData(oneFacetCut(facet, 7, ["0x33333333"]))).toEqual([]);
	});

	it("returns [] on short / empty / garbage input, never throws", () => {
		expect(parseDiamondCutData("0x")).toEqual([]);
		expect(parseDiamondCutData(`0x${"00".repeat(20)}`)).toEqual([]);
		expect(parseDiamondCutData("not-hex")).toEqual([]);
	});
});
