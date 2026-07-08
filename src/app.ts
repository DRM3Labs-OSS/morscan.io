/**
 * Thin pointer: the composition factory lives with the rest of the plug
 * surface in src/providers/compose.ts. EVERYTHING pluggable (seam interfaces,
 * reference impls, the registry, the factory) is under src/providers/ - see
 * src/providers/README.md for the plug map. This re-export exists only so
 * `import { createMorscanApp } from "morscan/app"` reads naturally.
 */
export * from "./providers/compose";
