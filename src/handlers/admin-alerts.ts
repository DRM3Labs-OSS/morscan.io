/**
 * Admin alert area - the in-app surface for MorScan's operational alerts.
 *
 *   GET  /admin/alerts            -> HTML page (admin-key gated)
 *   GET  /api/admin/alerts        -> JSON list of recent alerts (admin-key gated)
 *   POST /api/admin/alerts/test   -> fire a test alert through every configured
 *                                    channel (admin-key gated)
 *
 * Gating reuses the existing admin identity: the `admin` api_keys row (or any
 * id in MORSCAN_ADMIN_KEY_IDS), same as /sync/* and /mor/v1/bq/*. The page
 * accepts the key via the `X-Morscan-Key` header OR a `?key=` query param (a
 * browser cannot set a custom header on navigation); the validated key is then
 * injected into the page so its fetches to the JSON API carry the header.
 */

import type { Env } from "../types";
import { validateKey, isAdminAuth } from "../utils/auth";
import { notifyAlert, configuredChannels } from "../alerts";
import { selectRecentAlerts } from "../db/explorer-core";

const HTML_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
};
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

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

function escapeJs(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/</g, "\\x3c")
		.replace(/\r?\n/g, "");
}

export async function handleAdminAlertsRoutes(
	path: string,
	request: Request,
	url: URL,
	env: Env,
): Promise<Response | null> {
	// JSON: recent alerts
	if (path === "/api/admin/alerts" && request.method === "GET") {
		const gate = await adminAuthed(request, url, env);
		if (!gate.ok) return unauthorized();
		try {
			const rows = await selectRecentAlerts(env.DB);
			return new Response(
				JSON.stringify({ alerts: rows, channels: configuredChannels(env) }),
				{ headers: JSON_HEADERS },
			);
		} catch (e) {
			return new Response(
				JSON.stringify({
					alerts: [],
					channels: configuredChannels(env),
					error: e instanceof Error ? e.message : String(e),
				}),
				{ headers: JSON_HEADERS },
			);
		}
	}

	// JSON: fire a test alert through every configured channel
	if (path === "/api/admin/alerts/test" && request.method === "POST") {
		const gate = await adminAuthed(request, url, env);
		if (!gate.ok) return unauthorized();
		const result = await notifyAlert(
			env,
			{
				level: "info",
				kind: "test",
				message: "MorScan test alert - your alerting wiring is working.",
			},
			{ awaitChannels: true, host: url.host },
		);
		return new Response(JSON.stringify({ ok: true, ...result }), {
			headers: JSON_HEADERS,
		});
	}

	// HTML: the admin alert area
	if (path === "/admin/alerts" && request.method === "GET") {
		const gate = await adminAuthed(request, url, env);
		if (!gate.ok) return unauthorized();
		return new Response(renderAlertsPage(gate.key), { headers: HTML_HEADERS });
	}

	return null;
}

function renderAlertsPage(adminKey: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MorScan Alerts</title>
<style>
  :root {
    --bg: #0a0e0d; --panel: #111716; --border: #1e2a27; --text: #d7e4df;
    --muted: #7d908a; --green: #35e08a; --green-dim: #1f6f4a;
    --info: #35e08a; --warning: #e0c435; --critical: #ff5c5c;
    --mono: 'SFMono-Regular', ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 14px; line-height: 1.5; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 28px 20px 64px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 20px; }
  h1 { font-size: 18px; margin: 0; color: var(--green); letter-spacing: .5px; }
  .sub { color: var(--muted); font-size: 12px; }
  .bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
  button { font-family: var(--mono); font-size: 13px; background: var(--green-dim); color: #eafff4; border: 1px solid var(--green); border-radius: 6px; padding: 8px 14px; cursor: pointer; }
  button:hover { background: var(--green); color: #04120b; }
  button:disabled { opacity: .5; cursor: default; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .chip.on { color: var(--green); border-color: var(--green-dim); }
  #result { min-height: 18px; font-size: 12px; color: var(--muted); margin: 4px 0 18px; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; }
  td.msg { color: var(--text); }
  td.when { color: var(--muted); white-space: nowrap; }
  .lvl { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: .5px; }
  .lvl.info { color: var(--info); border: 1px solid var(--green-dim); }
  .lvl.warning { color: var(--warning); border: 1px solid #6f6320; }
  .lvl.critical { color: var(--critical); border: 1px solid #6f2020; background: #1a0e0e; }
  .kind { color: var(--muted); }
  .resolved { color: var(--green); }
  .empty { color: var(--muted); padding: 28px 0; text-align: center; }
  .table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>MorScan Alerts</h1>
    <span class="sub">Operational alert log. Records here always; fans out to the channels you configure via env vars.</span>
  </header>

  <div class="bar">
    <button id="test">Send test alert</button>
    <button id="refresh">Refresh</button>
    <div class="chips" id="chips"></div>
  </div>
  <div id="result"></div>

  <div class="table-scroll">
    <table>
      <thead>
        <tr><th>Time (UTC)</th><th>Level</th><th>Kind</th><th>Message</th><th>Resolved</th></tr>
      </thead>
      <tbody id="rows"><tr><td colspan="5" class="empty">Loading...</td></tr></tbody>
    </table>
  </div>
</div>

<script>
  const KEY = '${escapeJs(adminKey)}';
  const H = { 'X-Morscan-Key': KEY };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmt = (ts) => { try { return new Date(Number(ts)).toISOString().replace('T',' ').replace(/\\..+/,''); } catch { return String(ts); } };

  function renderChips(ch) {
    const names = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', webhook: 'Webhook' };
    const el = document.getElementById('chips');
    el.innerHTML = Object.keys(names).map(k => {
      const on = ch && ch[k];
      return '<span class="chip ' + (on ? 'on' : '') + '">' + names[k] + ': ' + (on ? 'configured' : 'off') + '</span>';
    }).join('');
  }

  function renderRows(alerts) {
    const tb = document.getElementById('rows');
    if (!alerts || !alerts.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">No alerts recorded yet.</td></tr>'; return; }
    tb.innerHTML = alerts.map(a => {
      const lvl = String(a.level || 'info');
      return '<tr>' +
        '<td class="when">' + fmt(a.ts) + '</td>' +
        '<td><span class="lvl ' + esc(lvl) + '">' + esc(lvl) + '</span></td>' +
        '<td class="kind">' + esc(a.kind) + '</td>' +
        '<td class="msg">' + esc(a.message) + '</td>' +
        '<td class="' + (a.resolved ? 'resolved' : '') + '">' + (a.resolved ? 'yes' : 'no') + '</td>' +
        '</tr>';
    }).join('');
  }

  async function load() {
    try {
      const r = await fetch('/api/admin/alerts', { headers: H });
      const d = await r.json();
      renderChips(d.channels);
      renderRows(d.alerts);
    } catch (e) {
      document.getElementById('result').textContent = 'Load failed: ' + e;
    }
  }

  async function sendTest() {
    const btn = document.getElementById('test');
    const out = document.getElementById('result');
    btn.disabled = true; out.textContent = 'Firing test alert...';
    try {
      const r = await fetch('/api/admin/alerts/test', { method: 'POST', headers: H });
      const d = await r.json();
      const chans = (d.channels || []);
      if (!chans.length) out.textContent = 'Recorded to the alert log. No external channels configured - set ALERT_* env vars to get paged.';
      else out.textContent = 'Recorded + fanned out: ' + chans.map(c => c.channel + '=' + (c.ok ? 'sent' : ('FAIL' + (c.status ? ' ' + c.status : '') + (c.error ? ' ' + c.error : '')))).join(', ');
      await load();
    } catch (e) {
      out.textContent = 'Test failed: ' + e;
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById('test').addEventListener('click', sendTest);
  document.getElementById('refresh').addEventListener('click', load);
  load();
</script>
</body>
</html>`;
}
