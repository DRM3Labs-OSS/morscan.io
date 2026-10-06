/**
 * Copy style check tests (scripts/check-writing.mjs).
 *
 * The script is the gate that keeps shipped copy free of prose em dashes and
 * AI-writing tells. Its em-dash regex is written as the \u2014 escape so the
 * script itself passes CI's tree-wide dash grep; these tests prove the escaped
 * regex still catches the literal character in a file under src/, and that a
 * standalone table glyph (no word on both sides) is left alone.
 *
 * The script reads src/ relative to its cwd and exits 1 on a violation, so each
 * case runs it in a temp dir holding a one-file src/ fixture. The fixture text
 * is built from the escape too: this test file carries no literal dash either.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/check-writing.mjs");
const EM_DASH = "\u2014";
const dirs: string[] = [];

function runOn(fixture: string) {
	const dir = mkdtempSync(join(tmpdir(), "check-writing-"));
	dirs.push(dir);
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "fixture.ts"), fixture);
	const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check-writing", () => {
	it("fails on a literal em dash in prose", () => {
		const r = runOn(`export const copy = "scan it ${EM_DASH} then sign it";\n`);
		expect(r.status).toBe(1);
		expect(r.out).toContain("[em-dash]");
		expect(r.out).toContain("src/fixture.ts:1");
	});

	it("fails on a literal em dash with no spaces", () => {
		const r = runOn(`export const copy = "scan${EM_DASH}sign";\n`);
		expect(r.status).toBe(1);
		expect(r.out).toContain("[em-dash]");
	});

	it("leaves a standalone table glyph alone", () => {
		const r = runOn(`export const cell = (x: string) => \`\${x || "${EM_DASH}"} MOR\`;\n`);
		expect(r.status).toBe(0);
		expect(r.out).toContain("no un-frozen tells");
	});

	it("passes clean copy", () => {
		const r = runOn('export const copy = "scan it, then sign it";\n');
		expect(r.status).toBe(0);
	});
});
