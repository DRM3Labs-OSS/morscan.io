#!/usr/bin/env node
// model-descriptions.mjs - the description-gap workflow for model listings.
//
// New on-chain model registrations arrive with no curated description (the
// daily cron raises a `model_descriptions` alert when they do). This script
// closes the gap in two steps, keeping a human in the loop:
//
//   1. Emit the gap as a template to fill in (one JSON object per listing):
//        node scripts/model-descriptions.mjs --emit gaps.json
//      Fill each "description" by hand or with your writing tool of choice.
//      Leave a description empty to skip that listing (unknown models should
//      stay description-free rather than guessed at). The optional "family"
//      and "canonical" fields curate grouping on the model detail page.
//
//   2. Apply the filled file:
//        node scripts/model-descriptions.mjs --apply gaps.json
//      Descriptions only ever FILL EMPTY rows (never overwrite curation);
//      family/canonical apply only when non-empty in the file.
//
// Targeting: remote D1 by default; set LOCAL=1 for the local dev database.
// TARGET_DB (default "morscan") and WRANGLER_CONFIG work like import-seed.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET_DB = process.env.TARGET_DB || "morscan";
const WRANGLER_CONFIG = process.env.WRANGLER_CONFIG || "";
const LOCAL = !!process.env.LOCAL;

const cfg = WRANGLER_CONFIG ? ["--config", WRANGLER_CONFIG] : [];
const target = [LOCAL ? "--local" : "--remote"];
const d1 = (extra) =>
	execFileSync(
		"npx",
		["wrangler", "d1", "execute", TARGET_DB, ...cfg, ...target, "--yes", ...extra],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
	);

const sqlEsc = (v) => `'${String(v).replace(/'/g, "''")}'`;

function emit(outPath) {
	const out = d1([
		"--json",
		"--command",
		"SELECT model_id, name, created_at FROM models WHERE (description IS NULL OR description = '') AND name IS NOT NULL ORDER BY created_at DESC",
	]);
	const rows = JSON.parse(out)[0].results;
	const template = rows.map((r) => ({
		model_id: r.model_id,
		name: r.name,
		created_at: r.created_at,
		description: "",
		family: "",
		canonical: "",
	}));
	writeFileSync(outPath, `${JSON.stringify(template, null, 1)}\n`);
	console.log(`${template.length} listing(s) need a description -> ${outPath}`);
}

function apply(inPath) {
	const entries = JSON.parse(readFileSync(inPath, "utf8"));
	const stmts = [];
	let described = 0;
	let curated = 0;
	for (const e of entries) {
		if (!e.model_id) continue;
		const id = String(e.model_id).toLowerCase();
		if (e.description && String(e.description).trim()) {
			described++;
			stmts.push(
				`UPDATE models SET description=${sqlEsc(String(e.description).trim())} WHERE model_id=${sqlEsc(id)} AND (description IS NULL OR description='');`,
			);
		}
		const fam = e.family && String(e.family).trim();
		const canon = e.canonical && String(e.canonical).trim();
		if (fam || canon) {
			curated++;
			const sets = [];
			if (fam) sets.push(`family=${sqlEsc(fam)}`);
			if (canon) sets.push(`canonical=${sqlEsc(canon)}`);
			stmts.push(`UPDATE models SET ${sets.join(", ")} WHERE model_id=${sqlEsc(id)};`);
		}
	}
	if (!stmts.length) {
		console.log("Nothing to apply (no filled descriptions or curation).");
		return;
	}
	const tmp = join(mkdtempSync(join(tmpdir(), "morscan-desc-")), "apply.sql");
	writeFileSync(tmp, stmts.join("\n"));
	d1(["--file", tmp]);
	console.log(
		`Applied: ${described} description(s) (fill-empty only), ${curated} curation update(s).`,
	);
}

const mode = process.argv[2];
const file = process.argv[3];
if (mode === "--emit" && file) emit(file);
else if (mode === "--apply" && file) apply(file);
else {
	console.error(
		"Usage: node scripts/model-descriptions.mjs --emit <out.json> | --apply <filled.json>",
	);
	process.exit(1);
}
