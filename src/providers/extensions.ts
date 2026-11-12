/**
 * Composition extensions - the surface a composition adds NEXT TO the core,
 * as opposed to the provider seams (./index.ts), which swap a behavior the
 * core already has.
 *
 * Three additions, all optional, all generic:
 *   - planes: extra top-level sections in the header navigation.
 *   - publicRoutes: extra public pages and files, outside /mor/v1 and /admin.
 *   - apiRoutes: extra /mor/v1 endpoints. They sit behind the SAME auth,
 *     rate limit, call balance and payment gates as every built-in endpoint.
 *
 * The reference build registers none, so it behaves exactly as it did before
 * this file existed. Built-in routes always win: an extension can add a path,
 * never replace one.
 *
 * Kept in its own small module (the ./overrides-state pattern) because the
 * header component reads the plane list and must not pull the handler graph.
 * Same one-composition-per-bundle contract as the provider registry.
 */

import type { Env } from "../types";

/** One extra top-level section in the header navigation. */
export interface ExtraPlane {
	/** Stable id; a page marks itself active by using it as its plane key. */
	key: string;
	label: string;
	href: string;
}

/** Extra public routes. Return null to fall through to the stock 404. */
export type PublicRoutes = (
	path: string,
	request: Request,
	url: URL,
	env: Env,
	ctx: ExecutionContext,
) => Promise<Response | null>;

/** Extra /mor/v1 endpoints, gated and metered by the core dispatcher. */
export interface ApiRoutes {
	/** True for a path this extension serves. Unknown paths 404 before auth. */
	known(path: string): boolean;
	/** Runs only after the caller passed every gate. Null falls through to 404. */
	handle(
		path: string,
		request: Request,
		url: URL,
		env: Env,
		headers: Record<string, string>,
	): Promise<Response | null>;
}

export interface Extensions {
	planes: ExtraPlane[];
	publicRoutes?: PublicRoutes;
	apiRoutes?: ApiRoutes;
}

let active: Extensions = { planes: [] };

/** Install the composed extension set (called by createMorscanApp). */
export function installExtensions(ext: Partial<Extensions> = {}): void {
	active = {
		planes: ext.planes ? [...ext.planes] : [],
		publicRoutes: ext.publicRoutes,
		apiRoutes: ext.apiRoutes,
	};
}

export function getExtensions(): Extensions {
	return active;
}

/** What /version reports, so a composed build never reads as the plain one. */
export function describeExtensions(): {
	planes: string[];
	publicRoutes: boolean;
	apiRoutes: boolean;
} {
	return {
		planes: active.planes.map((p) => p.key),
		publicRoutes: !!active.publicRoutes,
		apiRoutes: !!active.apiRoutes,
	};
}
