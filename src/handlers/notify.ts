/**
 * Coming-soon notify list.
 *
 * POST /notify captures an email into the `notify_list` D1 table so the apex
 * coming-soon page can collect launch signups without a separate backend.
 * Public + unauthenticated by design (a launch list), so it is deliberately
 * minimal: strict email validation, idempotent insert, per-IP rate limit.
 */

import type { Env } from "../types";
import { checkRateLimit } from "../utils/auth";
import { insertNotifyEmail } from "../db/ops";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export async function handleNotify(
	request: Request,
	env: Env,
	HEADERS: Record<string, string>,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response(JSON.stringify({ error: "POST only" }), {
			status: 405,
			headers: HEADERS,
		});
	}

	// Light per-IP throttle - a launch list needs no more than a few writes/min.
	const rate = await checkRateLimit(request, env, undefined, 10);
	if (!rate.allowed) {
		return new Response(
			JSON.stringify({ error: "Too many requests. Try again shortly." }),
			{
				status: 429,
				headers: { ...HEADERS, "Retry-After": String(rate.retryAfter || 60) },
			},
		);
	}

	let email = "";
	try {
		const ct = request.headers.get("content-type") || "";
		if (ct.includes("application/json")) {
			const body = (await request.json()) as { email?: unknown };
			email = typeof body.email === "string" ? body.email : "";
		} else {
			const form = await request.formData();
			const v = form.get("email");
			email = typeof v === "string" ? v : "";
		}
	} catch {
		return new Response(JSON.stringify({ error: "Invalid request body." }), {
			status: 400,
			headers: HEADERS,
		});
	}

	email = email.trim().toLowerCase();
	if (email.length > 254 || !EMAIL_RE.test(email)) {
		return new Response(JSON.stringify({ error: "Enter a valid email address." }), {
			status: 400,
			headers: HEADERS,
		});
	}

	if (!env.DB) {
		return new Response(
			JSON.stringify({ error: "Signups are not available right now." }),
			{ status: 503, headers: HEADERS },
		);
	}

	try {
		await insertNotifyEmail(env.DB, email);
	} catch {
		return new Response(
			JSON.stringify({ error: "Could not save your email. Try again shortly." }),
			{ status: 500, headers: HEADERS },
		);
	}

	return new Response(JSON.stringify({ ok: true }), { status: 200, headers: HEADERS });
}
