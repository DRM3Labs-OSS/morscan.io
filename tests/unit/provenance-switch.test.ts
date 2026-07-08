import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initSync, Receipt } from "@drm3labs-oss/provenance/drm3_provenance.js";

/**
 * PROVENANCE_ENABLED sovereignty switch.
 *
 * Enabled (default, i.e. flag unset): responses carry the same receipt fields
 * as before - golden receipts intact, verified with the REAL WASM binding.
 * Disabled ("false"): responses ship with NO receipt fields and the WASM
 * signer is never initialized (init is lazy; ensureInit is the only door).
 *
 * ensureInit is mocked to a spy because the Worker inits from a CompiledWasm
 * import that node cannot load (the vitest plugin stubs the .wasm to null).
 * The REAL module bytes are initSync'd once in beforeAll instead, so signing
 * in the enabled tests is real Ed25519 signing - the spy only observes whether
 * the request path ever reached for the signer.
 */
vi.mock("../../src/utils/provenance-core", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../../src/utils/provenance-core")>();
	return { ...orig, ensureInit: vi.fn() };
});

import { ensureInit } from "../../src/utils/provenance-core";
import { provenanceEnabled, signingMnemonic } from "../../src/config";
import { handleProviders } from "../../src/handlers/marketplace";
import { handlePublicRoutes } from "../../src/routes/public";
import type { Env } from "../../src/types";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";

beforeAll(() => {
	const wasmPath = fileURLToPath(
		new URL(
			"../../node_modules/@drm3labs-oss/provenance/drm3_provenance_bg.wasm",
			import.meta.url,
		),
	);
	initSync({ module: new WebAssembly.Module(readFileSync(wasmPath)) });
});

const ensureInitSpy = vi.mocked(ensureInit);

beforeEach(() => {
	ensureInitSpy.mockClear();
	// No network in unit tests: getSyncState's getCurrentBlock probes RPC
	// endpoints and catches failures, falling back to its wall-clock estimate.
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("network disabled in unit tests"))),
	);
});

/** Minimal D1 stub: providers rows, empty sync_state, receipt inserts accepted. */
function stubDb(providers: Record<string, unknown>[]): D1Database {
	const stmt = (sql: string): Record<string, unknown> => ({
		bind: (..._args: unknown[]) => stmt(sql),
		first: async () => null,
		all: async () => ({ results: sql.includes("FROM providers") ? providers : [] }),
		run: async () => ({ success: true, meta: {} }),
	});
	return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

const PROVIDER_ROWS = [
	{ address: "0xaaa1", endpoint: "host-a:3333", stake: "100", updated_block: 10 },
	{ address: "0xbbb2", endpoint: "host-b:3333", stake: "200", updated_block: 11 },
];

function makeEnv(extra: Partial<Env> = {}): Env {
	return {
		DB: stubDb(PROVIDER_ROWS),
		RPC_URL: "https://rpc.invalid.example",
		MORSCAN_MNEMONIC: TEST_MNEMONIC,
		...extra,
	} as Env;
}

describe("config helpers", () => {
	it("default (flag unset) is enabled; only the literal 'false' disables", () => {
		expect(provenanceEnabled({})).toBe(true);
		expect(provenanceEnabled({ PROVENANCE_ENABLED: "true" })).toBe(true);
		expect(provenanceEnabled({ PROVENANCE_ENABLED: "false" })).toBe(false);
	});

	it("signingMnemonic gates the mnemonic on the switch", () => {
		expect(signingMnemonic({ MORSCAN_MNEMONIC: TEST_MNEMONIC })).toBe(TEST_MNEMONIC);
		expect(
			signingMnemonic({ MORSCAN_MNEMONIC: TEST_MNEMONIC, PROVENANCE_ENABLED: "false" }),
		).toBeUndefined();
		expect(signingMnemonic({})).toBeUndefined();
	});
});

describe("enabled default: receipt fields unchanged", () => {
	it("rows carry _receipt, envelope carries _provenance, aggregate verifies", async () => {
		const res = await handleProviders(makeEnv(), { "Content-Type": "application/json" });
		const body = (await res.json()) as Record<string, unknown>;

		const rows = body.providers as Record<string, unknown>[];
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(typeof row._receipt).toBe("string");

		const prov = body._provenance as Record<string, unknown>;
		expect(prov.service).toBe("morscan");
		expect(prov.receipt_count).toBe(2);
		expect(typeof prov.merkle_root).toBe("string");

		// Golden check: the aggregate receipt is a REAL Ed25519 receipt that
		// verifies against the same WASM binding the Worker signs with.
		const aggregate = body._provenance_aggregate as Record<string, unknown>;
		expect(aggregate).toBeTruthy();
		expect(Receipt.fromJson(JSON.stringify(aggregate)).verify()).toBe(true);

		expect(ensureInitSpy).toHaveBeenCalled();
	});
});

describe("disabled: no receipt fields, no wasm init", () => {
	it("PROVENANCE_ENABLED=false ships rows without any receipt fields", async () => {
		const res = await handleProviders(makeEnv({ PROVENANCE_ENABLED: "false" }), {
			"Content-Type": "application/json",
		});
		const body = (await res.json()) as Record<string, unknown>;

		const rows = body.providers as Record<string, unknown>[];
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row).not.toHaveProperty("_receipt");
		expect(body).not.toHaveProperty("_provenance");
		expect(body).not.toHaveProperty("_provenance_aggregate");

		// The lazy WASM init path was never reached: the signer stays untouched.
		expect(ensureInitSpy).not.toHaveBeenCalled();
	});

	it("/version reports provenance 'disabled' with a null receipt", async () => {
		const env = makeEnv({ PROVENANCE_ENABLED: "false" });
		const req = new Request("https://morscan.example.com/version");
		const res = await handlePublicRoutes(
			"/version",
			"GET",
			req,
			new URL(req.url),
			env,
			{},
		);
		expect(res).not.toBeNull();
		const body = (await (res as Response).json()) as Record<string, unknown>;
		expect(body.provenance).toBe("disabled");
		expect(body.receipt).toBeNull();
		expect(body.verification).toBeNull();
		expect(ensureInitSpy).not.toHaveBeenCalled();
	});

	it("/version reports provenance 'enabled' when the flag is unset", async () => {
		const env = makeEnv({ MORSCAN_MNEMONIC: undefined });
		const req = new Request("https://morscan.example.com/version");
		const res = await handlePublicRoutes(
			"/version",
			"GET",
			req,
			new URL(req.url),
			env,
			{},
		);
		const body = (await (res as Response).json()) as Record<string, unknown>;
		expect(body.provenance).toBe("enabled");
	});
});
