/**
 * Admin surface for the coming-soon launch list.
 *
 *   GET /api/admin/notify   -> JSON of notify_list captures (admin-key gated)
 *   GET /admin/notify       -> HTML view of the same (admin-key gated)
 *
 * The apex coming-soon page POSTs emails to /notify (public, unauthenticated) and
 * they land in the `notify_list` D1 table. Those captures were previously invisible
 * to operators - this exposes them, admin-gated, so an operator admin console can server-
 * side-fetch /api/admin/notify and render the waitlist. Emails are PII: never public.
 *
 * Gating reuses the existing admin identity (the `admin` api_keys row or any id in
 * MORSCAN_ADMIN_KEY_IDS), the SAME gate as /admin/alerts. The key arrives via the
 * `X-Morscan-Key` header OR a `?key=` query param (a browser cannot set a custom
 * header on navigation); for the HTML page the validated key is injected so its
 * fetch to the JSON API carries the header.
 */

import type { Env } from "../types";
import { validateKey, isAdminAuth } from "../utils/auth";
import { countNotifyCaptures, listNotifyCaptures } from "../db/ops";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const HTML_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Read the admin key from header or query and confirm it is an admin identity. */
async function adminAuthed(
	request: Request,
	url: URL,
	env: Env,
): Promise<{ ok: boolean; key: string }> {
	const key = request.headers.get("X-Morscan-Key") || url.searchParams.get("key") || "";
	if (!key) return { ok: false, key: "" };
	const auth = await validateKey(key, env);
	return { ok: isAdminAuth(auth, env), key };
}

function unauthorized(): Response {
	return new Response(JSON.stringify({ error: "admin key required" }), {
		status: 401,
		headers: JSON_HEADERS,
	});
}

/** Clamp a query-param integer into [min, max], falling back to `dflt`. */
function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
	const n = Number.parseInt(raw || "", 10);
	if (!Number.isFinite(n)) return dflt;
	return Math.max(min, Math.min(max, n));
}

function escapeJs(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/</g, "\\x3c")
		.replace(/\r?\n/g, "");
}

export async function handleAdminNotifyRoutes(
	path: string,
	request: Request,
	url: URL,
	env: Env,
): Promise<Response | null> {
	// JSON: the launch-list captures, newest first, with paging.
	if (path === "/api/admin/notify" && request.method === "GET") {
		const gate = await adminAuthed(request, url, env);
		if (!gate.ok) return unauthorized();

		const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
		const offset = clampInt(
			url.searchParams.get("offset"),
			0,
			0,
			Number.MAX_SAFE_INTEGER,
		);

		try {
			const [countRow, rows] = await Promise.all([
				countNotifyCaptures(env.DB),
				listNotifyCaptures(env.DB, limit, offset),
			]);
			const total = countRow?.total ?? 0;
			const captures = rows.map((r) => ({
				email: r.email,
				created_at: r.created_at,
				// `source` is not in the base schema; coalesce to null so the shape is stable.
				source: r.source ?? null,
			}));
			return new Response(JSON.stringify({ total, limit, offset, captures }), {
				headers: JSON_HEADERS,
			});
		} catch (e) {
			return new Response(
				JSON.stringify({
					total: 0,
					limit,
					offset,
					captures: [],
					error: e instanceof Error ? e.message : String(e),
				}),
				{ status: 500, headers: JSON_HEADERS },
			);
		}
	}

	// HTML: a small operator view of the same list (MorScan-side convenience).
	if (path === "/admin/notify" && request.method === "GET") {
		const gate = await adminAuthed(request, url, env);
		if (!gate.ok) return unauthorized();
		return new Response(renderNotifyPage(gate.key), { headers: HTML_HEADERS });
	}

	return null;
}

function renderNotifyPage(adminKey: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MorScan Waitlist</title>
<style>
  :root {
    --bg: #0a0e0d; --panel: #111716; --border: #1e2a27; --text: #d7e4df;
    --muted: #7d908a; --green: #35e08a; --green-dim: #1f6f4a;
    --mono: 'SFMono-Regular', ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 14px; line-height: 1.5; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 28px 20px 64px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 20px; }
  h1 { font-size: 18px; margin: 0; color: var(--green); letter-spacing: .5px; }
  .sub { color: var(--muted); font-size: 12px; }
  .bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
  button { font-family: var(--mono); font-size: 13px; background: var(--green-dim); color: #eafff4; border: 1px solid var(--green); border-radius: 6px; padding: 8px 14px; cursor: pointer; }
  button:hover { background: var(--green); color: #04120b; }
  .count { color: var(--green); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
  td.when { color: var(--muted); white-space: nowrap; }
  td.src { color: var(--muted); }
  .empty { color: var(--muted); padding: 28px 0; text-align: center; }
  .table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>MorScan Waitlist</h1>
    <span class="sub">Emails captured by the coming-soon page (POST /notify). Admin-only; these are private.</span>
  </header>
  <div class="bar">
    <button id="refresh">Refresh</button>
    <span class="count" id="count"></span>
  </div>
  <div class="table-scroll">
    <table>
      <thead>
        <tr><th>Email</th><th>Captured (UTC)</th><th>Source</th></tr>
      </thead>
      <tbody id="rows"><tr><td colspan="3" class="empty">Loading...</td></tr></tbody>
    </table>
  </div>
</div>
<script>
  const KEY = '${escapeJs(adminKey)}';
  const H = { 'X-Morscan-Key': KEY };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  function renderRows(captures) {
    const tb = document.getElementById('rows');
    if (!captures || !captures.length) { tb.innerHTML = '<tr><td colspan="3" class="empty">No signups captured yet.</td></tr>'; return; }
    tb.innerHTML = captures.map(c =>
      '<tr>' +
      '<td>' + esc(c.email) + '</td>' +
      '<td class="when">' + esc(c.created_at) + '</td>' +
      '<td class="src">' + esc(c.source || '-') + '</td>' +
      '</tr>'
    ).join('');
  }

  async function load() {
    try {
      const r = await fetch('/api/admin/notify', { headers: H });
      const d = await r.json();
      document.getElementById('count').textContent = (d.total || 0) + ' total';
      renderRows(d.captures);
    } catch (e) {
      document.getElementById('rows').innerHTML = '<tr><td colspan="3" class="empty">Load failed: ' + esc(e) + '</td></tr>';
    }
  }

  document.getElementById('refresh').addEventListener('click', load);
  load();
</script>
</body>
</html>`;
}
