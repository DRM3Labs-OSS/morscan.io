/**
 * The overridden-seams record - the ONE copy of the "which provider seams did
 * this composition inject" state. Written ONLY by installProviders
 * (src/providers/index.ts) and read by both surfaces that tell the
 * composition truth:
 *
 *   - /version's `composition.overrides` (src/routes/public.ts, via the
 *     ../providers re-export), and
 *   - the footer build stamp (src/ui/build-stamp.ts).
 *
 * It lives in its own tiny module so the stamp can read it without dragging
 * the full provider registry (and its handler import graph, including the
 * WASM provenance modules) into scope - the registry itself stays in
 * src/providers/index.ts.
 */

let overriddenSeams: string[] = [];

/** Record the injected seam names (called only by installProviders). */
export function recordOverriddenSeams(seams: string[]): void {
	overriddenSeams = [...seams].sort();
}

/**
 * Which provider seams the active composition overrode (empty for the
 * reference build). Surfaced at /version as `composition.overrides` and in
 * the footer build stamp - the honesty marker that a composed deployment
 * never reports itself as the plain reference build.
 */
export function getOverriddenProviders(): string[] {
	return [...overriddenSeams];
}
