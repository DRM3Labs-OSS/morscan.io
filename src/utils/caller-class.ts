/**
 * Who is paying for a call: the class the shared-database guards budget by.
 *
 *   admin - the operator identities (isAdminAuth): never shed, never capped.
 *   paid  - a prepaid call pack (`pack:`), a per-call x402 payment (`x402:`),
 *           or a key whose stake or deal raised its burst above the free
 *           connected-wallet tier (staked wallet keys, partner keys).
 *   free  - the public serving key (`demo`, shipped in every page), a
 *           wallet-signature SDK caller, the playground and every
 *           bottom-tier key: anything a stranger can obtain for nothing.
 *
 * Free traffic can only ever spend the free class's budgets, so it can never
 * shed or slow a paying caller.
 */

import type { Env } from "../types";
import { type AuthResult, isAdminAuth } from "./auth/key-validation";
import { CONNECTED_CAPS } from "./stake-tier";

export type CallerClass = "admin" | "paid" | "free";

export function callerClass(auth: AuthResult, env: Env): CallerClass {
	if (isAdminAuth(auth, env)) return "admin";
	const id = auth.keyId || "";
	if (id.startsWith("pack:") || id.startsWith("x402:")) return "paid";
	if (id === "demo" || auth.walletAuth) return "free";
	return (auth.rateLimit ?? 0) > CONNECTED_CAPS.burst ? "paid" : "free";
}
