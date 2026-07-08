import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	Chain,
	Keyring,
	Receipt,
	initSync,
} from "@drm3labs-oss/provenance/drm3_provenance.js";

/**
 * Provenance sign -> verify round-trip against the SAME WASM binding the Worker
 * signs with. In the Workers runtime provenance-core.ts inits via a
 * CompiledWasm import; here in Node we read the colocated .wasm and initSync it
 * with the bytes (mirroring that init, just a different module source).
 */
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

function signOne(action: string, inputs: object, outputs: object): Receipt {
	const kp = Keyring.fromMnemonic(TEST_MNEMONIC).derive("morscan/cache");
	return Receipt.create(action).inputs(inputs).outputs(outputs).sign(kp);
}

describe("receipt sign -> verify", () => {
	it("a freshly signed receipt verifies", () => {
		const r = signOne("blockchain.marketplace", { endpoint: "/mor/v1/all" }, { count: 3 });
		expect(r.verify()).toBe(true);
		expect(r.publicKey().length).toBeGreaterThan(0);
		expect(r.signature().length).toBeGreaterThan(0);
	});

	it("the same derivation path is deterministic (stable signer identity)", () => {
		const a = signOne("x", { a: 1 }, { b: 2 }).publicKey();
		const b = signOne("y", { c: 3 }, { d: 4 }).publicKey();
		expect(a).toBe(b);
	});

	it("tampering the output payload breaks verification", () => {
		const r = signOne("blockchain.marketplace", { endpoint: "/mor/v1/all" }, { count: 3 });
		const parsed = JSON.parse(r.toJson());
		// flip the signed output hash; re-parse and it must NOT verify
		parsed.output_hash = `${parsed.output_hash.slice(0, -1)}${
			parsed.output_hash.endsWith("0") ? "1" : "0"
		}`;
		let verified: boolean;
		try {
			verified = Receipt.fromJson(JSON.stringify(parsed)).verify();
		} catch {
			verified = false; // a hard reject is also a pass for this test
		}
		expect(verified).toBe(false);
	});

	it("tampering the signature breaks verification", () => {
		const r = signOne("blockchain.marketplace", { endpoint: "/mor/v1/all" }, { count: 3 });
		const parsed = JSON.parse(r.toJson());
		const sig: string = parsed.signature;
		parsed.signature = `${sig.slice(0, -1)}${sig.endsWith("a") ? "b" : "a"}`;
		let verified: boolean;
		try {
			verified = Receipt.fromJson(JSON.stringify(parsed)).verify();
		} catch {
			verified = false;
		}
		expect(verified).toBe(false);
	});
});

describe("receipt chain -> Merkle root", () => {
	it("a multi-receipt chain verifies and yields a stable Merkle root", () => {
		const r1 = signOne("blockchain.providers", { i: 1 }, { o: 1 });
		const r2 = signOne("blockchain.providers", { i: 2 }, { o: 2 });
		const r3 = signOne("blockchain.providers", { i: 3 }, { o: 3 });
		const chain = Chain.create().add(r1).add(r2).add(r3).build();
		expect(chain.verify()).toBe(true);
		const root = chain.merkleRoot();
		expect(root.length).toBeGreaterThan(0);
		// root recomputes identically from the same leaves
		const chain2 = Chain.create().add(r1).add(r2).add(r3).build();
		expect(chain2.merkleRoot()).toBe(root);
	});

	it("a different leaf set produces a different root", () => {
		const a = Chain.create()
			.add(signOne("act", { i: 1 }, { o: 1 }))
			.build()
			.merkleRoot();
		const b = Chain.create()
			.add(signOne("act", { i: 9 }, { o: 9 }))
			.build()
			.merkleRoot();
		expect(a).not.toBe(b);
	});
});
