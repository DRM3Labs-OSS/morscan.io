/**
 * AdminProvider - the open-core seam for operator / admin surfaces.
 *
 * Covers the admin identity gate (isAdminAuth: the `admin` api_keys row + any
 * id in MORSCAN_ADMIN_KEY_IDS) and the operator surfaces gated by it: the
 * alerts area and the waitlist/notify area. The bundled REFERENCE impl
 * reproduces TODAY's admin behavior EXACTLY by delegating to the existing
 * handlers.
 *
 * A PRIVATE admin provider could implement a richer operator console
 * behind this same interface and be injected at src/providers/index.ts, without
 * changing the gate or any admin response.
 */

import type { Env } from "../../types";
import type { AuthResult } from "../../utils/auth";
import { isAdminAuth } from "../../utils/auth";
import { handleAdminAlertsRoutes } from "../../handlers/admin-alerts";
import { handleAdminNotifyRoutes } from "../../handlers/admin-notify";

export interface AdminProvider {
	/** The admin identity gate (accepts `admin` + MORSCAN_ADMIN_KEY_IDS). */
	isAdmin(auth: AuthResult, env: Env): boolean;
	/** The admin alerts area (page + JSON API + test-fire). Admin-key gated. */
	handleAlerts(
		path: string,
		request: Request,
		url: URL,
		env: Env,
	): Promise<Response | null>;
	/** The admin waitlist/notify area (page + JSON API). Admin-key gated. */
	handleNotify(
		path: string,
		request: Request,
		url: URL,
		env: Env,
	): Promise<Response | null>;
}

/**
 * Bundled REFERENCE AdminProvider. Thin, behavior-preserving delegation to the
 * existing admin gate + handlers (they stay the single definition of each
 * concern); this object is the injection seam.
 */
export const referenceAdminProvider: AdminProvider = {
	isAdmin(auth, env) {
		return isAdminAuth(auth, env);
	},
	handleAlerts(path, request, url, env) {
		return handleAdminAlertsRoutes(path, request, url, env);
	},
	handleNotify(path, request, url, env) {
		return handleAdminNotifyRoutes(path, request, url, env);
	},
};
