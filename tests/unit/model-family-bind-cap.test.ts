/**
 * A model page whose family runs to dozens of on-chain listings.
 *
 * The database binds at most 100 parameters to one statement. The Qwen
 * family on Morpheus carries 60-plus listings (qwen2.5, qwen3, qwen3.5 and
 * on, with the curated QwQ 32B filed under it), and the family rollups pass
 * every listing id to one statement; the provider-union count passed the
 * list twice. Every Qwen page answered 500 while every other family rendered.
 *
 * Contract under test: the slug page for a Qwen model, and for qwq-32b, renders
 * through the REAL handlers (slug resolution, the detail aggregate, the HTML
 * page) against a D1 stand-in that enforces the 100-parameter cap the way the
 * real one does, and the family it reports counts every listing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleModelSlugPage } from "../../src/handlers/ui/compute";
import { handleModelDetail } from "../../src/handlers/model-detail";
import type { Env } from "../../src/types";

const D1_MAX_BOUND = 100;

interface Row {
	model_id: string;
	name: string;
	family: string | null;
	canonical: string | null;
	description: string | null;
	created_at: number;
}

const id = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

/** 67 Qwen listings in the spellings the chain carries, plus QwQ 32B curated
 * into the family and a few listings from other families. */
function fixtureRows(): Row[] {
	const rows: Row[] = [];
	let n = 1;
	const push = (name: string, extra: Partial<Row> = {}) =>
		rows.push({
			model_id: id(n),
			name,
			family: null,
			canonical: null,
			description: null,
			created_at: 1_700_000_000 + n++ * 60,
			...extra,
		});
	push("qwen3-235b");
	push("Qwen/Qwen3-235B-A22B:web");
	push("qwen3-8b:tee", { canonical: "Qwen3 8B" });
	push("qwen2.5-7b-instruct-awq");
	push("qwen-3.5-397b");
	for (let i = rows.length; i < 67; i++) push(`qwen3.${5 + (i % 4)}-${8 + i}b${i % 3 ? "" : ":tee"}`);
	push("qwq-32b:tee", { family: "qwen", canonical: "QwQ 32B" });
	push("deepseek-r1-70b:tee", { canonical: "DeepSeek R1 70B" });
	push("llama-3.3-70b");
	push("Kimi K3");
	return rows;
}

/** A D1 stand-in for the model page's read path. It answers the models table
 * from the fixture, everything else empty, and refuses a statement that binds
 * more than 100 parameters, as the real database does. */
function fakeDb(rows: Row[], binds: number[]): D1Database {
	const stmt = (sql: string, args: unknown[] = []): Record<string, unknown> => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		first: async () => {
			check(args);
			if (sql.includes("FROM models WHERE model_id = ?"))
				return rows.find((r) => r.model_id === args[0]) || null;
			if (sql.includes("COUNT(*) as n")) return { n: 0 };
			return null;
		},
		all: async () => {
			check(args);
			if (sql.includes("FROM models WHERE name IS NOT NULL")) return { results: rows };
			return { results: [] };
		},
		run: async () => ({ success: true, meta: {} }),
	});
	const check = (args: unknown[]) => {
		binds.push(args.length);
		if (args.length > D1_MAX_BOUND) throw new Error("D1_ERROR: too many SQL variables");
	};
	return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("network disabled in unit tests"))),
	);
});

function makeEnv(binds: number[]): Env {
	return {
		DB: fakeDb(fixtureRows(), binds),
		RPC_URL: "https://rpc.invalid.example",
		PROVENANCE_ENABLED: "false",
	} as unknown as Env;
}

describe("a model page whose family has more listings than one statement can bind", () => {
	it("renders the Qwen slug page and counts the whole family", async () => {
		const binds: number[] = [];
		const res = await handleModelSlugPage(makeEnv(binds), "qwen3-235b", "/compute/models/qwen3-235b");
		// The page templates are empty strings under vitest, so the status is the
		// page's contract here; the body is pinned through the detail aggregate.
		expect(res.status).toBe(200);
		expect(Math.max(...binds)).toBeLessThanOrEqual(D1_MAX_BOUND);
	});

	it("renders qwq-32b, curated into the Qwen family", async () => {
		const binds: number[] = [];
		const res = await handleModelSlugPage(makeEnv(binds), "qwq-32b", "/compute/models/qwq-32b");
		expect(res.status).toBe(200);
		expect(Math.max(...binds)).toBeLessThanOrEqual(D1_MAX_BOUND);
	});

	it("reports every listing of the family in the detail aggregate", async () => {
		const rows = fixtureRows();
		const lead = rows.find((r) => r.name === "qwq-32b:tee") as Row;
		const res = await handleModelDetail(makeEnv([]), lead.model_id, {});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			model: { name: string };
			family: { key: string; listingCount: number; modelCount: number };
		};
		expect(body.model.name).toBe("QwQ 32B");
		expect(body.family.key).toBe("qwen");
		expect(body.family.listingCount).toBe(68);
		expect(body.family.modelCount).toBeGreaterThan(60);
	});

	it("still answers 404 for a slug no group owns", async () => {
		const res = await handleModelSlugPage(makeEnv([]), "no-such-model", "/compute/models/no-such-model");
		expect(res.status).toBe(404);
	});
});
