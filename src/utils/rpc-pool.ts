// drm3-rpc-pool - WASM JSON-RPC failover pool for MorScan's single-shot RPC calls.
//
// WASM-in-Workers init: the .wasm is a CompiledWasm module (the wrangler.toml
// `**/*.wasm` rule) and we initSync it once. The transport resolves `fetch` off
// globalThis, so it runs in the Worker / Durable Object isolate.
//
// Free Base endpoints only, all as peers (priority 0): each call goes to the
// least-loaded healthy peer, the whole free-tier per-IP budget is in play, and a
// 429/flaky endpoint is health-tracked and routed around. No paid key.
//
// Sovereignty switch: RPC_POOL_ENABLED (default "true"). When the operator sets
// it to "false", getRpcPool() returns a plain-fetch SINGLE-transport fallback
// instead: every call is a POST to RPC_URL with one honest retry, and the
// rpc-pool WASM module is NEVER initialized (init is lazy; the disabled path
// never calls initSync, so the blob is never touched). The flag is pinned once
// per isolate from the entrypoints (worker fetch/scheduled + the sync Durable
// Object), mirroring the setBaseUrl pattern in src/config.ts.
//
// Defensive: if WASM init ever throws, getRpcPool() returns null and the caller
// falls back to the legacy sequential loop, so sync can never break on the pool.
// @ts-expect-error - the .wasm ships a colocated generated .d.ts with only named
// exports, but at runtime wrangler/esbuild resolves it as a default CompiledWasm
// import (deploy dry-run passes). tsc cannot type the default; this is expected.
import wasmModule from "@drm3labs-oss/rpc-pool/drm3_rpc_pool_wasm_bg.wasm";
import { initSync, RpcPool } from "@drm3labs-oss/rpc-pool/drm3_rpc_pool_wasm.js";
import { RPC_ENDPOINTS } from "../sync/parsers-rpc";

const RPC_TIMEOUT_MS = 10000;
const PLAIN_ATTEMPTS = 2; // simple retry: one call + one retry, nothing clever

/** The call surface both the WASM pool and the plain fallback expose. */
export interface RpcTransport {
	call(method: string, params: unknown[]): Promise<unknown>;
}

// Pinned once per isolate from the entrypoints. Default true = today's behavior.
let _poolEnabled = true;

/** Pin the RPC_POOL_ENABLED switch for this isolate (entrypoints call this). */
export function configureRpcPool(env: { RPC_POOL_ENABLED?: string }): void {
	_poolEnabled = env.RPC_POOL_ENABLED !== "false";
}

/**
 * Plain-fetch single transport: POST to one RPC_URL, honest simple retry
 * (PLAIN_ATTEMPTS total), same call() interface as the pool. No failover, no
 * health tracking, no WASM - this is the deliberately boring fallback.
 */
class PlainRpcTransport implements RpcTransport {
	constructor(private readonly url: string) {}

	async call(method: string, params: unknown[]): Promise<unknown> {
		let lastErr: unknown;
		for (let attempt = 1; attempt <= PLAIN_ATTEMPTS; attempt++) {
			try {
				const resp = await fetch(this.url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", method, id: 1, params }),
					signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
				});
				const data = (await resp.json()) as Record<string, unknown>;
				if (data.error) {
					throw new Error(
						`RPC ${method}: ${String((data.error as Record<string, unknown>).message)}`,
					);
				}
				return data.result;
			} catch (e) {
				lastErr = e;
			}
		}
		throw lastErr instanceof Error
			? lastErr
			: new Error(`RPC ${method} failed after ${PLAIN_ATTEMPTS} attempts`);
	}
}

let _pool: RpcPool | null = null;
let _plain: PlainRpcTransport | null = null;
let _plainUrl = "";
let _failed = false;

export function getRpcPool(envUrl: string, alchemyUrl?: string): RpcTransport | null {
	if (!_poolEnabled) {
		// Off-switch path: plain fetch to RPC_URL only. The WASM module above is
		// imported but never executed - initSync is only reached below.
		if (!_plain || _plainUrl !== envUrl) {
			_plain = new PlainRpcTransport(envUrl);
			_plainUrl = envUrl;
		}
		return _plain;
	}
	if (_pool) return _pool;
	if (_failed) return null;
	try {
		initSync({ module: wasmModule });
		const seen = new Set<string>();
		const endpoints: Array<{ url: string; priority: number }> = [];
		// Free Base peers plus a free-tier Alchemy key if configured - additive
		// capacity, never a dependency; the pool routes around any that 429/flake.
		for (const u of [envUrl, alchemyUrl, ...RPC_ENDPOINTS]) {
			if (u && !seen.has(u)) {
				seen.add(u);
				endpoints.push({ url: u, priority: 0 });
			}
		}
		_pool = new RpcPool({
			max_retries: 0,
			request_timeout_ms: RPC_TIMEOUT_MS,
			endpoints,
		});
		return _pool;
	} catch (e) {
		console.error(
			`[rpc-pool] init failed, using legacy sequential RPC: ${e instanceof Error ? e.message : String(e)}`,
		);
		_failed = true;
		return null;
	}
}
