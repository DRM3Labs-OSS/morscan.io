/**
 * The playground lists its endpoints from a script array. Endpoints a
 * composition registered are handed to it as data, ahead of that script.
 */

import { extensionCatalog } from "../../providers/extensions";

export function extraEndpointsScript(): string {
	const groups = extensionCatalog();
	if (!groups.length) return "";
	const eps = groups.map((g) => ({
		group: g.group,
		base: g.base,
		items: g.items.map((e) => ({
			m: "GET",
			p: e.path,
			d: e.summary,
			detail: e.detail || e.summary,
		})),
	}));
	// "<" is escaped so no string in the data can close the script element.
	return `<script>window.__MORSCAN_EXTRA_EPS=${JSON.stringify(eps).replace(/</g, "\\u003c")};</script>`;
}
