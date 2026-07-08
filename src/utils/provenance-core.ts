// DRM3 Provenance - shared WASM init + error plumbing.
// MorScan SIGNS receipts for its cached blockchain data.

// CF Workers need manual WASM init - __wbindgen_start() doesn't work in Workers runtime.
// WASM is imported as a CompiledWasm module per the wrangler.toml rule.
// @ts-expect-error - the .wasm ships a colocated generated .d.ts with only named
// exports, but at runtime wrangler/esbuild resolves it as a default CompiledWasm
// import (deploy dry-run passes). tsc cannot type the default; this is expected.
import wasmModule from "@drm3labs-oss/provenance/drm3_provenance_bg.wasm";
import { initSync } from "@drm3labs-oss/provenance/drm3_provenance.js";

let _initialized = false;

export function ensureInit() {
	if (!_initialized) {
		initSync({ module: wasmModule });
		_initialized = true;
	}
}

/**
 * Signing failure with the actual exception preserved. Every sign* function
 * catches its internal throw and logs the full message so operators see the
 * real cause without tailing Worker logs. Callers still see `null` - MorScan's
 * doctrine is fire-and-forget on provenance so sync never blocks on it.
 */
export class ProvenanceSigningError extends Error {
	constructor(
		public readonly phase: string,
		public readonly context: Record<string, unknown>,
		cause: unknown,
	) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		const ctxStr = Object.entries(context)
			.map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 80) : String(v)}`)
			.join(" ");
		super(`[morscan:${phase}] ${ctxStr} :: ${detail}`);
		this.name = "ProvenanceSigningError";
	}
}

export function formatErr(
	phase: string,
	context: Record<string, unknown>,
	e: unknown,
): string {
	return new ProvenanceSigningError(phase, context, e).message;
}
