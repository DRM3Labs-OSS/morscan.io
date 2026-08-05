/**
 * UI copy guard.
 *
 * Two fleet laws, pinned so they cannot rot back in:
 *
 *  1. NO INFRA IN USER COPY. Rendered copy names the WINDOW or the OUTCOME a
 *     reader gets, never the machinery behind it: no store, table, column,
 *     queue, worker or tiering. This caught real leaks in the API playground
 *     ("from wallet_stats table", "closeout_type = 1", "Used for SSR and
 *     dashboard rendering") and in the OpenAPI docs ("curated via
 *     models.canonical") - none of which are fields any caller ever sees.
 *
 *  2. NO 400-CHARACTER PARAGRAPHS OF SMALL PRINT. The endpoint detail panel is
 *     a callout card, and each entry stays short enough to read in it. Honest
 *     methodology disclosure (where a price comes from, what a count excludes,
 *     what a signature does and does not prove) is the product's credibility
 *     and MUST survive - the fix for a long one is compression, never deletion.
 *
 * The scan reads the SHIPPED templates from disk, so it tracks what actually
 * renders rather than a copy that could drift.
 */

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

/** Store/platform nouns that must never appear in copy a visitor reads. */
const INFRA_NOUNS =
	/\b(wallet_stats|closeout_type|models\.canonical|BigQuery|Durable Object|lakehouse|Postgres|hot cache|SSR|D1|KV|R2|cron|indexer|worker)\b/i;

/**
 * The contributor page is developer documentation: it exists to tell someone
 * how to stand up their own instance, so "D1 database" and "local worker" are
 * the subject matter, not leaked machinery. Every other page is product copy.
 */
const DEV_DOC_PAGES = new Set(["contribute.html"]);

/** Strip styles, scripts, comments and tags - what is left is what is read. */
function visibleText(htmlSource: string): string {
	return htmlSource
		.replace(/<style\b[\s\S]*?<\/style>/gi, "")
		.replace(/<script\b[\s\S]*?<\/script>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]+>/g, "\n");
}

function pageFiles(dir: string): string[] {
	return readdirSync(root(dir))
		.filter((f) => f.endsWith(".html") || f.endsWith(".mustache"))
		.map((f) => `${dir}/${f}`);
}

describe("UI copy: no infra nouns in rendered text", () => {
	const files = [
		...pageFiles("src/ui/pages"),
		...pageFiles("src/ui/partials"),
		"src/ui/layout.mustache",
	];

	it("covers every page and partial template", () => {
		// A silent zero-file glob would pass this whole suite while checking
		// nothing, so assert the scan actually has something to scan.
		expect(files.length).toBeGreaterThan(20);
	});

	for (const rel of files) {
		const base = rel.split("/").pop() as string;
		if (DEV_DOC_PAGES.has(base)) continue;
		it(`${base} names no store, queue or worker`, () => {
			const offenders = visibleText(readFileSync(root(rel), "utf8"))
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 3 && INFRA_NOUNS.test(l));
			expect(offenders).toEqual([]);
		});
	}
});

describe("API playground: endpoint copy", () => {
	const src = readFileSync(root("src/ui/partials/api-script-1.html"), "utf8");
	// detail:'...' entries in the endpoint catalog, honouring \' escapes.
	const details = [...src.matchAll(/detail:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) =>
		m[1].replace(/\\'/g, "'"),
	);

	it("the endpoint catalog was actually found", () => {
		expect(details.length).toBeGreaterThan(20);
	});

	it("no endpoint detail names a table, column or internal stage", () => {
		expect(details.filter((d) => INFRA_NOUNS.test(d))).toEqual([]);
	});

	it("no endpoint detail is a wall of small print", () => {
		// Compression, not deletion: 360 chars is roughly four printed lines in
		// the callout. Anything longer belongs on a page, not in a tooltip card.
		expect(details.filter((d) => d.length > 360)).toEqual([]);
	});

	it("the price endpoint still discloses where its numbers come from", () => {
		const price = details.find((d) => d.includes("Uniswap"));
		expect(price).toBeTruthy();
		expect(price).toMatch(/Chainlink/);
		expect(price).toMatch(/fallback/);
	});

	it("the detail panel renders as a callout, not bare small print", () => {
		const markup = readFileSync(root("src/ui/partials/api-markup.html"), "utf8");
		const el = markup.match(/<div id="ep-detail"[^>]*>/);
		expect(el).toBeTruthy();
		const tag = el?.[0] as string;
		expect(tag).toContain('role="note"');
		expect(tag).toContain("border-left:3px solid var(--green)");
		// Muted grey body text is most of why these read as slop; the callout
		// uses the readable secondary tone.
		expect(tag).toContain("color:var(--text-secondary)");
		expect(tag).not.toContain("var(--text-muted)");
	});
});

describe("OpenAPI descriptions: no internal names", () => {
	const files = [
		"src/handlers/openapi.ts",
		"src/handlers/openapi-paths.ts",
		"src/handlers/openapi-schemas.ts",
	];

	for (const rel of files) {
		it(`${rel.split("/").pop()} describes endpoints without naming the store`, () => {
			const src = readFileSync(root(rel), "utf8");
			const strings = [
				...src.matchAll(/(?:description|summary):\s*\n?\s*"((?:[^"\\]|\\.)*)"/g),
			].map((m) => m[1]);
			expect(strings.filter((s) => INFRA_NOUNS.test(s))).toEqual([]);
		});
	}
});
