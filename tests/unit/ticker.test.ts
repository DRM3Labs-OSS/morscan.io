/**
 * Market tape tests (src/ui/ticker.ts).
 *
 * Pins the tape's honesty + loop contracts:
 *  - The 24h change comes from a real baseline; a model with no baseline
 *    renders a NEW tag, never a fabricated 0.0%.
 *  - The track is two IDENTICAL halves (the -50% translate loops seamlessly)
 *    and the clone is aria-hidden; short tapes repeat items to fill the half.
 *  - Model names are HTML-escaped.
 *  - marketTickerHtml maps wei/sec to MOR/day and NEVER throws: a broken DB
 *    renders nothing (the layout slot simply disappears).
 *  - No em/en dashes anywhere in the rendered tape (hard copy law).
 */

import { describe, expect, it } from "vitest";
import type { Env } from "../../src/types";
import { marketTickerHtml, renderTicker } from "../../src/ui/ticker";

const item = (over: Record<string, unknown> = {}) => ({
	name: "Llama 3.3 70B",
	morPerDay: 9.216,
	changePct: 1.23,
	providers: 4,
	...over,
});

/** Env stub whose DB answers the single ticker aggregate with fixed rows. */
function envWithRows(rows: Record<string, unknown>[]): Env {
	return {
		DB: {
			prepare: () => ({
				bind: () => ({ all: async () => ({ results: rows }) }),
			}),
		},
	} as unknown as Env;
}

describe("renderTicker", () => {
	it("renders nothing for an empty marketplace", () => {
		expect(renderTicker([])).toBe("");
	});

	it("renders price, change class, and provider count per item", () => {
		const html = renderTicker([item()]);
		expect(html).toContain("Llama 3.3 70B");
		expect(html).toContain("9.22 <i>MOR/day</i>");
		expect(html).toContain('class="mkt-chg up">+1.2%');
		expect(html).toContain("4 providers");
		const down = renderTicker([item({ changePct: -2.5 })]);
		expect(down).toContain('class="mkt-chg down">-2.5%');
		const flat = renderTicker([item({ changePct: 0 })]);
		expect(flat).toContain('class="mkt-chg flat">0.0%');
	});

	it("no 24h baseline renders NEW, never a fabricated change", () => {
		const html = renderTicker([item({ changePct: null })]);
		expect(html).toContain('class="mkt-new">new');
		expect(html).not.toContain("mkt-chg");
	});

	it("loops seamlessly: two identical halves, clone aria-hidden", () => {
		const html = renderTicker([item(), item({ name: "Qwen 2.5" })]);
		const halves = html.split('<span class="mkt-half"');
		expect(halves).toHaveLength(3);
		expect(halves[2].startsWith(' aria-hidden="true"')).toBe(true);
		// Identical content once the aria-hidden attribute and the tape's
		// closing tags are stripped.
		expect(
			halves[2].replace(' aria-hidden="true"', "").replace("</div></div>", ""),
		).toBe(halves[1]);
	});

	it("repeats a short tape so the half fills the viewport", () => {
		const html = renderTicker([item()]);
		// 1 item -> 12 repeats per half, two halves.
		expect(html.match(/mkt-item/g)).toHaveLength(24);
	});

	it("escapes model names", () => {
		const html = renderTicker([item({ name: '<img src=x onerror="1">' })]);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
	});

	it("never contains em or en dashes", () => {
		expect(renderTicker([item(), item({ changePct: null })])).not.toMatch(
			/[–—]/,
		);
	});
});

describe("marketTickerHtml", () => {
	it("maps wei/sec to MOR/day and computes the 24h change", async () => {
		// 1e13 wei/sec * 86400 / 1e18 = 0.864 MOR/day; baseline 8e12 -> +25%.
		const html = await marketTickerHtml(
			envWithRows([
				{
					model_id: "0xabc",
					name: "Llama 3.3 70B",
					min_price: 1e13,
					min_price_then: 8e12,
					provider_count: 3,
					bid_count: 5,
				},
			]),
		);
		expect(html).toContain("0.8640 <i>MOR/day</i>");
		expect(html).toContain("+25.0%");
	});

	it("falls back to a short model id when the name is missing", async () => {
		const html = await marketTickerHtml(
			envWithRows([
				{
					model_id: "0x1234567890abcdef",
					name: null,
					min_price: 1e13,
					min_price_then: null,
					provider_count: 1,
					bid_count: 1,
				},
			]),
		);
		expect(html).toContain("0x12345678");
		expect(html).toContain('class="mkt-new">new');
	});

	it("renders nothing when the DB is broken (slot disappears, page lives)", async () => {
		const env = {
			DB: {
				prepare: () => {
					throw new Error("boom");
				},
			},
		} as unknown as Env;
		expect(await marketTickerHtml(env)).toBe("");
	});
});
