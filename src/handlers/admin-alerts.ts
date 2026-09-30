/**
 * Admin alert area - the in-app surface for MorScan's operational alerts.
 *
 *   GET  /admin/alerts            -> HTML page (admin-key gated)
 *   GET  /api/admin/alerts        -> JSON list of recent alerts (admin-key gated)
 *   POST /api/admin/alerts/test   -> fire a test alert through every configured
 *                                    channel (admin-key gated)
 *
 * Gating reuses the existing admin identity: the `admin` api_keys row (or any
 * id in MORSCAN_ADMIN_KEY_IDS), same as /sync/* and /mor/v1/bq/*. The key is
 * accepted ONLY as the `X-Morscan-Key` header, never as a query param (a URL
 * credential lands in access logs, history and Referer headers). The HTML page
 * itself carries no data and no key: it is a shell that asks the operator for
 * the key, keeps it in the tab's sessionStorage, and sends it as the header on
 * its fetches to the JSON API.
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

/** Confirm the `X-Morscan-Key` header carries an admin identity. Header only. */
async function adminAuthed(request: Request, env: Env): Promise<boolean> {
	const key = request.headers.get("X-Morscan-Key") || "";
	if (!key) return false;
	const auth = await validateKey(key, env);
	return isAdminAuth(auth, env);
}

/**
 * The admin key is never read from the URL: a query credential lands in edge
 * access logs, browser history, proxy logs and the Referer of any outbound
 * navigation. A request that carries one is refused before the key is looked
 * at, so the habit does not silently keep working.
 */
function refuseKeyInUrl(url: URL): Response | null {
	if (!url.searchParams.has("key")) return null;
	return new Response(
		JSON.stringify({
			error:
				"The admin key is not accepted in the URL. Send it as the X-Morscan-Key header, or open the page without ?key= and enter it there.",
		}),
		{ status: 400, headers: JSON_HEADERS },
	);
}

function unauthorized(): Response {
	return new Response(JSON.stringify({ error: "admin key required" }), {
		status: 401,
		headers: JSON_HEADERS,
	});
}

export async function handleAdminAlertsRoutes(
	path: string,
	request: Request,
	url: URL,
	env: Env,
): Promise<Response | null> {
	// JSON: recent alerts
	if (path === "/api/admin/alerts" && request.method === "GET") {
		const refused = refuseKeyInUrl(url);
		if (refused) return refused;
		if (!(await adminAuthed(request, env))) return unauthorized();
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
		const refused = refuseKeyInUrl(url);
		if (refused) return refused;
		if (!(await adminAuthed(request, env))) return unauthorized();
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

	// HTML: the admin alert area. The shell holds no data and no key; every
	// number on it comes from the header-gated JSON door above.
	if (path === "/admin/alerts" && request.method === "GET") {
		const refused = refuseKeyInUrl(url);
		if (refused) return refused;
		return new Response(renderAlertsPage(), { headers: HTML_HEADERS });
	}

	return null;
}

function renderAlertsPage(): string {
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
  .keybar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .keybar input { font-family: var(--mono); font-size: 13px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; min-width: 320px; }
  .keybar .hint { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>MorScan Alerts</h1>
    <span class="sub">Operational alert log. Records here always; fans out to the channels you configure via env vars.</span>
  </header>

  <form class="keybar" id="keyform" autocomplete="off">
    <input type="password" id="key" placeholder="Admin key (X-Morscan-Key)" aria-label="Admin key">
    <button type="submit">Use key</button>
    <button type="button" id="forget">Forget</button>
    <span class="hint">Held in this tab only; sent as a header, never in the URL.</span>
  </form>

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
  const STORE = 'morscan_admin_key';
  let KEY = '';
  try { KEY = sessionStorage.getItem(STORE) || ''; } catch (e) {}
  const H = () => ({ 'X-Morscan-Key': KEY });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmt = (ts) => { try { return new Date(Number(ts)).toISOString().replace('T',' ').replace(/\\..+/,''); } catch { return String(ts); } };

  function needKey() {
    document.getElementById('rows').innerHTML = '<tr><td colspan="5" class="empty">Enter the admin key above to load the alert log.</td></tr>';
    document.getElementById('result').textContent = '';
  }
  function setKey(k) {
    KEY = k || '';
    try { if (KEY) sessionStorage.setItem(STORE, KEY); else sessionStorage.removeItem(STORE); } catch (e) {}
  }

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
    if (!KEY) { needKey(); return; }
    try {
      const r = await fetch('/api/admin/alerts', { headers: H() });
      if (r.status === 401) { setKey(''); needKey(); document.getElementById('result').textContent = 'That key is not an admin key.'; return; }
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
    if (!KEY) { needKey(); return; }
    btn.disabled = true; out.textContent = 'Firing test alert...';
    try {
      const r = await fetch('/api/admin/alerts/test', { method: 'POST', headers: H() });
      if (r.status === 401) { setKey(''); needKey(); out.textContent = 'That key is not an admin key.'; return; }
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

  document.getElementById('keyform').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const el = document.getElementById('key');
    setKey(el.value.trim()); el.value = '';
    load();
  });
  document.getElementById('forget').addEventListener('click', () => { setKey(''); needKey(); });
  document.getElementById('test').addEventListener('click', sendTest);
  document.getElementById('refresh').addEventListener('click', load);
  load();
</script>
</body>
</html>`;
}
