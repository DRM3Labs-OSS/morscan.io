/**
 * Market tape tests (src/ui/ticker.ts).
 *
 * Pins the tape's contracts:
 *  - buildTickerItems is pure: every item class renders from data, and
 *    missing data DROPS its item instead of rendering a placeholder.
 *  - Provider identity prefers the endpoint domain; bare IPs and empty
 *    endpoints fall back to the short 0x address.
 *  - The track is two IDENTICAL halves (the -50% translate loops seamlessly)
 *    and the clone is aria-hidden; short tapes repeat items to fill the half.
 *  - Values and hrefs are HTML-escaped.
 *  - The request path never computes: marketTickerHtml serves the KV summary
 *    (zero D1) and a broken env renders nothing - the page always lives.
 *  - No em/en dashes anywhere in the rendered tape (hard copy law).
 */

import { describe, expect, it } from "vitest";
import type { Env } from "../../src/types";
import {
	buildTickerItems,
	fmtAgo,
	fmtMor,
	marketTickerHtml,
	providerDomain,
	renderTicker,
	TICKER_ICONS,
	type TickerData,
	type TickerItem,
} from "../../src/ui/ticker";

const NOW = 1_800_000_000;

const emptyData = (): TickerData => ({
	nowSec: NOW,
	price: null,
	morStaked: null,
	liveBids: null,
	lastSession: null,
	topProvider: null,
	builderTvlMor: null,
	topSubnets: [],
	recentDeposits: [],
	topConsumer: null,
	newestModels: [],
});

const fullData = (): TickerData => ({
	nowSec: NOW,
	price: { usd: 2.1, change24h: -0.7 },
	morStaked: 1_534_796,
	liveBids: { bids: 34, models: 16 },
	lastSession: { modelName: "qwen3-235b", modelId: "0xq", openedAt: NOW - 120 },
	topProvider: {
		address: "0xAbCd000000000000000000000000000000001234",
		endpoint: "https://gpu.titan.io:3333",
		sessions: 1841,
	},
	builderTvlMor: 2_450_000,
	topSubnets: [
		{ subnetId: "0xs1", name: "Mor Builders", depositedMor: 1_200_000 },
		{ subnetId: "0xs2", name: "Venice", depositedMor: 800_000 },
		{ subnetId: "0xs3", name: null, depositedMor: 450_000 },
	],
	recentDeposits: [
		{ subnetId: "0xs2", name: "Venice", amountMor: 5000, ts: NOW - 3600 },
	],
	topConsumer: {
		wallet: "0xFeed000000000000000000000000000000005678",
		sessions: 912,
	},
	newestModels: [{ modelId: "0xm", name: "kimi-k2.6", createdAt: NOW - 86400 }],
});

describe("formatters", () => {
	it("fmtMor compacts across magnitudes", () => {
		expect(fmtMor(2_450_000)).toBe("2.45M");
		expect(fmtMor(15_300)).toBe("15.3K");
		expect(fmtMor(842)).toBe("842");
		expect(fmtMor(4.0)).toBe("4.0");
		expect(fmtMor(0.42)).toBe("0.42");
	});

	it("fmtAgo picks the readable unit", () => {
		expect(fmtAgo(NOW, NOW - 42)).toBe("42s");
		expect(fmtAgo(NOW, NOW - 420)).toBe("7m");
		expect(fmtAgo(NOW, NOW - 7200)).toBe("2h");
		expect(fmtAgo(NOW, NOW - 3 * 86400)).toBe("3d");
	});

	it("providerDomain extracts the host, falls back to short address", () => {
		const addr = "0xAbCd000000000000000000000000000000001234";
		expect(providerDomain("https://gpu.titan.io:3333/v1", addr)).toBe("gpu.titan.io");
		expect(providerDomain("gpu.titan.io:3333", addr)).toBe("gpu.titan.io");
		expect(providerDomain("http://93.184.216.34:8080", addr)).toBe("0xAbCd…1234");
		expect(providerDomain(null, addr)).toBe("0xAbCd…1234");
	});
});

describe("buildTickerItems", () => {
	it("renders every item class from full data, in tape order", () => {
		const items = buildTickerItems(fullData());
		expect(items.map((i) => i.icon)).toEqual([
			"mor",
			"market",
			"staked",
			"session",
			"provider",
			"builder",
			"gold",
			"silver",
			"bronze",
			"funded",
			"consumer",
			"model",
		]);
		const by = (icon: string) => items.find((i) => i.icon === icon) as TickerItem;
		expect(by("mor")).toMatchObject({ value: "$2.10", deltaPct: -0.7 });
		expect(by("market")).toMatchObject({ value: "34 bids", sub: "16 models" });
		expect(by("staked")).toMatchObject({ value: "1.53M MOR", sub: "in sessions" });
		expect(by("session")).toMatchObject({ value: "qwen3-235b", sub: "2m ago" });
		expect(by("provider")).toMatchObject({
			value: "gpu.titan.io",
			sub: "1,841 sessions",
			href: "/compute/providers/0xAbCd000000000000000000000000000000001234",
		});
		expect(by("builder")).toMatchObject({ value: "2.45M MOR" });
		expect(by("gold")).toMatchObject({ value: "Mor Builders", sub: "1.20M MOR" });
		expect(by("bronze").value).toBe("0xs3…"); // unnamed subnet -> short id
		expect(by("funded")).toMatchObject({
			value: "Venice",
			sub: "+5,000 MOR · 60m ago",
			href: "/builder/subnet/0xs2",
		});
		expect(by("consumer")).toMatchObject({ value: "0xFeed…5678", sub: "912 sessions" });
		expect(by("model")).toMatchObject({ value: "kimi-k2.6", newTag: true });
	});

	it("missing data drops items instead of rendering placeholders", () => {
		expect(buildTickerItems(emptyData())).toEqual([]);
		const d = emptyData();
		d.price = { usd: 2.1, change24h: 0 };
		expect(buildTickerItems(d)).toHaveLength(1);
	});

	it("zero-value guards: no 0-bid market, no $0 price, no empty stake", () => {
		const d = emptyData();
		d.price = { usd: 0, change24h: 0 };
		d.liveBids = { bids: 0, models: 0 };
		d.morStaked = 0;
		expect(buildTickerItems(d)).toEqual([]);
	});
});

describe("renderTicker", () => {
	const one: TickerItem = {
		icon: "mor",
		label: "MOR",
		value: "$2.10",
		href: "/analytics/overview",
		deltaPct: -0.7,
	};

	it("renders nothing for an empty tape", () => {
		expect(renderTicker([])).toBe("");
	});

	it("renders the brand SVG icon, label, linked value, and colored delta", () => {
		const html = renderTicker([one]);
		// The icon key resolves to its hand-cut SVG (the Morpheus wings), never
		// an emoji or the raw key.
		expect(html).toContain(`<span class="mkt-ic" aria-hidden="true">${TICKER_ICONS.mor}</span>`);
		expect(TICKER_ICONS.mor).toContain("<svg");
		expect(html).toContain('<span class="mkt-lb">MOR</span>');
		expect(html).toContain('<a href="/analytics/overview">$2.10</a>');
		expect(html).toContain('class="mkt-chg down">-0.7%');
		const up = renderTicker([{ ...one, deltaPct: 1.2 }]);
		expect(up).toContain('class="mkt-chg up">+1.2%');
	});

	it("omits empty labels (medal items carry the icon alone)", () => {
		const html = renderTicker([{ ...one, label: "", deltaPct: undefined }]);
		expect(html).not.toContain("mkt-lb");
	});

	it("loops seamlessly: two identical halves, clone aria-hidden", () => {
		const html = renderTicker([one, { ...one, value: "x" }]);
		const halves = html.split('<span class="mkt-half"');
		expect(halves).toHaveLength(3);
		expect(halves[2].startsWith(' aria-hidden="true"')).toBe(true);
		expect(
			halves[2].replace(' aria-hidden="true"', "").replace("</div></div>", ""),
		).toBe(halves[1]);
	});

	it("repeats a short tape so the half fills the viewport", () => {
		const html = renderTicker([one]);
		// 1 item -> 12 repeats per half, two halves.
		expect(html.match(/mkt-item/g)).toHaveLength(24);
	});

	it("escapes values and hrefs", () => {
		const html = renderTicker([
			{ ...one, value: '<img src=x onerror="1">', href: '/x"><script>' },
		]);
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
	});

	it("never contains em or en dashes", () => {
		expect(renderTicker(buildTickerItems(fullData()))).not.toMatch(/[–—]/);
	});
});

describe("marketTickerHtml", () => {
	it("serves the KV summary with zero D1 reads", async () => {
		let d1Touched = false;
		const entry = { cachedAt: Date.now(), data: fullData() };
		const env = {
			MORSCAN_CACHE: { get: async () => JSON.stringify(entry) },
			DB: {
				prepare: () => {
					d1Touched = true;
					throw new Error("request path must not read D1");
				},
				batch: () => {
					d1Touched = true;
					throw new Error("request path must not read D1");
				},
			},
		} as unknown as Env;
		const html = await marketTickerHtml(env);
		expect(html).toContain("gpu.titan.io");
		expect(html).toContain("Mor Builders");
		expect(d1Touched).toBe(false);
	});

	it("renders nothing when everything is broken (page still lives)", async () => {
		const env = {
			MORSCAN_CACHE: {
				get: async () => {
					throw new Error("kv down");
				},
			},
			DB: {
				prepare: () => {
					throw new Error("d1 down");
				},
				batch: () => {
					throw new Error("d1 down");
				},
			},
		} as unknown as Env;
		expect(await marketTickerHtml(env)).toBe("");
	});
});
