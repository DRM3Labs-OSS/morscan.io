import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RPC_POOL_ENABLED sovereignty switch.
 *
 * Enabled (default): getRpcPool initializes the @drm3labs-oss/rpc-pool WASM
 * and returns the failover pool (unchanged behavior).
 * Disabled ("false"): getRpcPool returns a plain-fetch single transport that
 * POSTs to RPC_URL with one honest retry - and the WASM is NEVER initialized.
 *
 * The pool's JS binding is mocked with spies so the tests can observe whether
 * initSync / the RpcPool constructor were ever reached; the disabled path must
 * touch neither.
 */
const initSyncSpy = vi.fn();
const poolCtorSpy = vi.fn();
vi.mock("@drm3labs-oss/rpc-pool/drm3_rpc_pool_wasm.js", () => ({
	initSync: initSyncSpy,
	RpcPool: class {
		constructor(cfg: unknown) {
			poolCtorSpy(cfg);
		}
		async call(_method: string, _params: unknown[]): Promise<unknown> {
			return "pooled-result";
		}
	},
}));

const RPC_URL = "https://rpc.example.test/base";

/** Fresh module per test: getRpcPool memoizes the pool/transport per isolate. */
async function freshModule() {
	vi.resetModules();
	return await import("../../src/utils/rpc-pool");
}

function jsonResponse(payload: unknown) {
	return { json: async () => payload } as Response;
}

beforeEach(() => {
	initSyncSpy.mockClear();
	poolCtorSpy.mockClear();
});

describe("RPC_POOL_ENABLED=false: plain single transport, no wasm", () => {
	it("POSTs the JSON-RPC call to RPC_URL and returns result", async () => {
		const mod = await freshModule();
		mod.configureRpcPool({ RPC_POOL_ENABLED: "false" });

		const fetchSpy = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", result: "0x10" }));
		vi.stubGlobal("fetch", fetchSpy);

		const transport = mod.getRpcPool(RPC_URL, "https://alchemy.example.test");
		expect(transport).not.toBeNull();
		const result = await (transport as { call: Function }).call("eth_blockNumber", []);
		expect(result).toBe("0x10");

		// Exactly one POST, to RPC_URL only (single transport - no peer fan-out).
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(RPC_URL);
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string);
		expect(body.method).toBe("eth_blockNumber");
		expect(body.jsonrpc).toBe("2.0");

		// The WASM pool was never touched.
		expect(initSyncSpy).not.toHaveBeenCalled();
		expect(poolCtorSpy).not.toHaveBeenCalled();
	});

	it("retries once on failure (honest simple retry), then succeeds", async () => {
		const mod = await freshModule();
		mod.configureRpcPool({ RPC_POOL_ENABLED: "false" });

		const fetchSpy = vi
			.fn()
			.mockRejectedValueOnce(new Error("first attempt down"))
			.mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", result: "0x22" }));
		vi.stubGlobal("fetch", fetchSpy);

		const transport = mod.getRpcPool(RPC_URL);
		const result = await (transport as { call: Function }).call("eth_chainId", []);
		expect(result).toBe("0x22");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(initSyncSpy).not.toHaveBeenCalled();
	});

	it("throws after both attempts fail (caller falls back to the legacy loop)", async () => {
		const mod = await freshModule();
		mod.configureRpcPool({ RPC_POOL_ENABLED: "false" });

		const fetchSpy = vi.fn().mockRejectedValue(new Error("endpoint down"));
		vi.stubGlobal("fetch", fetchSpy);

		const transport = mod.getRpcPool(RPC_URL);
		await expect(
			(transport as { call: Function }).call("eth_blockNumber", []),
		).rejects.toThrow("endpoint down");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(initSyncSpy).not.toHaveBeenCalled();
		expect(poolCtorSpy).not.toHaveBeenCalled();
	});

	it("surfaces a JSON-RPC error object as a thrown error", async () => {
		const mod = await freshModule();
		mod.configureRpcPool({ RPC_POOL_ENABLED: "false" });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ jsonrpc: "2.0", error: { code: -32000, message: "rate limited" } }),
			),
		);

		const transport = mod.getRpcPool(RPC_URL);
		await expect(
			(transport as { call: Function }).call("eth_getLogs", [{}]),
		).rejects.toThrow("rate limited");
	});
});

describe("enabled default: the WASM pool initializes as before", () => {
	it("flag unset -> pool constructed, initSync called once, envUrl is a peer", async () => {
		const mod = await freshModule();
		mod.configureRpcPool({}); // unset = enabled (reference behavior)

		const transport = mod.getRpcPool(RPC_URL);
		expect(transport).not.toBeNull();
		expect(initSyncSpy).toHaveBeenCalledTimes(1);
		expect(poolCtorSpy).toHaveBeenCalledTimes(1);
		const cfg = poolCtorSpy.mock.calls[0][0] as {
			endpoints: Array<{ url: string; priority: number }>;
		};
		expect(cfg.endpoints[0].url).toBe(RPC_URL);
		await expect(
			(transport as { call: Function }).call("eth_blockNumber", []),
		).resolves.toBe("pooled-result");
	});
});
