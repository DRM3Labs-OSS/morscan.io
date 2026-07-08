/**
 * Runtime configuration - neutral, deployment-agnostic defaults.
 *
 * MorScan is a source-open Morpheus explorer. None of its features are bolted
 * to a specific operator's hostnames. Everything below resolves from `[vars]`
 * in wrangler.toml (or Worker secrets), falling back to harmless placeholders
 * so the explorer boots and signs/verifies provenance out of the box.
 *
 * Configure these in wrangler.toml `[vars]`:
 *   PUBLIC_BASE_URL           - your deployed explorer origin (no trailing slash),
 *                               e.g. "https://morscan.example.com". Used for OG
 *                               tags, OpenAPI server URL, sitemap, llms.txt, and
 *                               the `content_uri` stamped into provenance receipts.
 *   SNAPSHOT_PUBLIC_HOST      - public host fronting the R2 snapshot bucket,
 *                               e.g. "snapshot.morscan.example.com".
 *   SNAPSHOT_SIGNER_KEY_ID    - key id advertised in the signed CDN snapshot
 *                               envelope, e.g. "morscan-snapshot-2026-07-a".
 */

import type { Env } from "./types";

/** Neutral default origin. Override with PUBLIC_BASE_URL. */
export const DEFAULT_BASE_URL = "https://morscan.example.com";

/** Resolved, immutable config for a single request/scheduled tick. */
export interface AppConfig {
	/** Explorer origin, no trailing slash. */
	baseUrl: string;
	/** Public host fronting the R2 snapshot bucket. */
	snapshotPublicHost: string;
	/** Key id stamped into the signed snapshot envelope. */
	snapshotSignerKeyId: string;
}

function stripTrailingSlash(u: string): string {
	return u.endsWith("/") ? u.slice(0, -1) : u;
}

/** Resolve the active config from the Worker environment. */
export function resolveConfig(env: Env): AppConfig {
	return {
		baseUrl: stripTrailingSlash(env.PUBLIC_BASE_URL || DEFAULT_BASE_URL),
		snapshotPublicHost: env.SNAPSHOT_PUBLIC_HOST || "snapshot.morscan.example.com",
		snapshotSignerKeyId: env.SNAPSHOT_SIGNER_KEY_ID || "morscan-snapshot-2026-07-a",
	};
}

// --- Provenance off-switch ------------------------------------------------------
// PROVENANCE_ENABLED (default "true"): the sovereignty switch for the
// @drm3labs-oss/provenance signer. Set it to "false" and MorScan runs fully
// unsigned: responses ship without receipt fields, /version reports
// provenance "disabled", and the provenance WASM module is never initialized
// (init is lazy - see src/utils/provenance-core.ts - and every signing call
// site gates on signingMnemonic(), so the disabled path never touches the
// blob). Unset or any other value = signing behaves exactly as before.

/** True unless PROVENANCE_ENABLED is explicitly "false". */
export function provenanceEnabled(env: Pick<Env, "PROVENANCE_ENABLED">): boolean {
	return env.PROVENANCE_ENABLED !== "false";
}

/**
 * The mnemonic to sign with, or undefined when signing must not happen.
 * This is THE gate every signing call site uses: it returns undefined both
 * when no MORSCAN_MNEMONIC is configured (the classic no-op) and when the
 * operator set PROVENANCE_ENABLED="false" (the explicit off-switch), so the
 * two unsigned modes behave identically on the request path.
 */
export function signingMnemonic(
	env: Pick<Env, "PROVENANCE_ENABLED" | "MORSCAN_MNEMONIC">,
): string | undefined {
	return provenanceEnabled(env) ? env.MORSCAN_MNEMONIC : undefined;
}

// --- Module-global base URL ---------------------------------------------------
// Provenance signing happens deep in handlers/sync where threading `env`
// everywhere would be noisy. The base URL is pure metadata (the `content_uri`
// field), so we cache the resolved value once per isolate and read it from the
// signing helpers. Set from the fetch/scheduled entrypoints before any signing.

let _baseUrl = DEFAULT_BASE_URL;

/** Called once at the top of fetch()/scheduled() to pin the resolved origin. */
export function setBaseUrl(url: string): void {
	_baseUrl = stripTrailingSlash(url) || DEFAULT_BASE_URL;
}

/** Current resolved explorer origin (no trailing slash). */
export function baseUrl(): string {
	return _baseUrl;
}
