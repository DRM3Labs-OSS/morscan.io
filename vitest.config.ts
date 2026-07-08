import { defineConfig } from "vitest/config";

// Unit tests only. Scoped to tests/unit so we never collide with the Playwright
// browser specs (tests/*.spec.ts) or the standalone tsx vector in
// src/utils/wallet-auth.test.ts (which is a script, not a vitest suite).
export default defineConfig({
	plugins: [
		{
			// Workers imports .wasm as a CompiledWasm module (wrangler rule); node
			// cannot load that extension, and several handlers now sit in unit-test
			// import graphs (via the provider registry). Provenance WASM init is
			// LAZY (ensureInit in src/utils/provenance-core.ts), so unit tests only
			// need the import to RESOLVE, never to run - stub it with null. Any
			// test that actually tried to sign would fail loudly at initSync.
			name: "stub-wasm-for-node",
			enforce: "pre",
			load(id: string) {
				if (id.endsWith(".wasm")) return "export default null;";
				// Mirror the other wrangler module rules for unit-test import
				// graphs that reach the UI layer: Text modules import as strings,
				// Data modules as buffers. Tests never render these; they only
				// need the imports to RESOLVE.
				if (/\.(mustache|html|txt)$/.test(id)) return "export default \"\";";
				if (/\.(png|ttf|woff2)$/.test(id)) return "export default new ArrayBuffer(0);";
			},
		},
	],
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		// Process the DRM3 WASM packages through vite (instead of node ESM
		// externalization) so the .wasm stub above applies to their imports.
		server: {
			deps: { inline: [/@drm3labs-oss\/provenance/, /@drm3labs-oss\/rpc-pool/] },
		},
	},
});
