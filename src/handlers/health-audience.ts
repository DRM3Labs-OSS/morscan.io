/**
 * Who sees how much of /health. Pure, so the unit test runs it on plain Node.
 *
 * With this door's operator read key (X-DRM3-Ops-Key equal to the OPS_READ_KEY secret, compared
 * in constant time): the whole body. Without it, or with the secret unset: the fields
 * public-health.allow names and nothing more. Default-deny; a malformed allow line fails closed
 * (parseAllow drops it), and a field added to the handler is private until the file lists it.
 */

import { parseAllow, publicHealth, revealExtended } from "../vendor/public-health";

/** The allow list is parsed once per isolate, never per request. */
const parsedAllow = new Map<string, ReturnType<typeof parseAllow>["fields"]>();

function allowFields(allowText: string) {
	let fields = parsedAllow.get(allowText);
	if (!fields) {
		fields = parseAllow(allowText).fields;
		parsedAllow.set(allowText, fields);
	}
	return fields;
}

export function audienceBody(
	request: Request,
	env: { OPS_READ_KEY?: string },
	full: Record<string, unknown>,
	allowText: string,
): Record<string, unknown> {
	return revealExtended(request, env) ? full : publicHealth(full, allowFields(allowText));
}
