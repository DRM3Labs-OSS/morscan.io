// Vendored OG-card assets (see src/handlers/og-image.ts).
// The CompiledWasm wrangler rule resolves *.wasm imports to a WebAssembly.Module;
// the Data rule resolves *.ttf imports to an ArrayBuffer of raw font bytes.
declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}

declare module "*.ttf" {
	const bytes: ArrayBuffer;
	export default bytes;
}

// Self-hosted UI webfonts (src/fonts/, served at /fonts/ by handlers/ui/assets.ts).
declare module "*.woff2" {
	const bytes: ArrayBuffer;
	export default bytes;
}
