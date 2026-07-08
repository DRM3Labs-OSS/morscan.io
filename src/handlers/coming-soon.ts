/**
 * Coming-soon holding page.
 *
 * When the COMING_SOON_HOSTS var (comma-separated hostnames) matches the
 * request host, the worker serves this page for all UI traffic instead of the
 * explorer. /health and the brand assets stay reachable so monitoring and
 * social cards keep working. Remove the host from the var to go live.
 */

const WINGS_PATH = `M44.5031 36.7108L52.2884 27.0574V39.5L75.154 30.3296L78.4294 22.9099L58.8453 30.8065V28.0173L80.2346 19.2454L83.6775 11.7472L58.7647 21.8776V19.1669L85.7246 7.99814L89 0.5L56.3826 13.818C56.3826 13.818 53.5973 14.8563 52.369 16.8486L44.5031 26.5805L36.6372 16.8486C35.4089 14.8563 32.6236 13.818 32.6236 13.818L0 0.5L3.27539 7.99814L30.2415 19.1608V21.8715L5.32871 11.7472L8.77159 19.2454L30.1609 28.0173V30.8065L10.5768 22.9099L13.8522 30.3296L36.7178 39.5V27.0574L44.5031 36.7108Z`;

const comingSoonHtml = (origin: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MorScan - Morpheus Block Explorer</title>
  <meta name="description" content="MorScan - the block explorer for the Morpheus AI network on Base. Coming soon.">
  <meta property="og:title" content="MorScan - Morpheus Block Explorer">
  <meta property="og:description" content="The block explorer for the Morpheus AI network on Base. Coming soon.">
  <meta property="og:image" content="${origin}/og-image.png">
  <meta property="og:url" content="${origin}/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="MorScan">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="MorScan - Morpheus Block Explorer">
  <meta name="twitter:description" content="The block explorer for the Morpheus AI network on Base. Coming soon.">
  <meta name="twitter:image" content="${origin}/og-image.png">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="48x48" href="/favicon.png">
  <link rel="icon" type="image/svg+xml" href="/morscan-icon.svg">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 1.4rem;
      background: #0c0a09; color: #fafaf9; text-align: center;
      font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; padding: 2rem;
      background-image: radial-gradient(ellipse 62% 40% at 50% 42%, rgba(34,197,94,0.11), transparent 75%);
    }
    .wings { width: min(300px, 70vw); filter: drop-shadow(0 0 36px rgba(34,197,94,0.45)); }
    h1 { font-size: clamp(2.2rem, 8vw, 3.4rem); letter-spacing: 0.01em; font-weight: 700; }
    .sub { color: #c7c2bc; letter-spacing: 0.14em; text-transform: uppercase; font-size: clamp(0.7rem, 2.6vw, 0.95rem); }
    .soon { margin-top: 0.6rem; color: #22c55e; font-size: clamp(0.8rem, 3vw, 1rem); letter-spacing: 0.08em; }
    form.notify { display: flex; gap: 0.5rem; width: min(420px, 88vw); margin-top: 0.4rem; }
    form.notify input {
      flex: 1 1 auto; min-width: 0; background: #1c1917; border: 1px solid #44403c; color: #fafaf9;
      font-family: inherit; font-size: 0.9rem; padding: 0.7rem 0.85rem; letter-spacing: 0.01em;
    }
    form.notify input::placeholder { color: #c7c2bc; }
    form.notify input:focus { outline: none; border-color: #22c55e; }
    form.notify button {
      flex: 0 0 auto; background: #22c55e; color: #0c0a09; border: none; font-family: inherit;
      font-size: 0.85rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 0.7rem 1.1rem; cursor: pointer;
    }
    form.notify button:hover { background: #4ade80; }
    form.notify button:disabled { opacity: 0.55; cursor: default; }
    .notify-hint { color: #c7c2bc; font-size: clamp(0.66rem, 2.4vw, 0.75rem); letter-spacing: 0.04em; }
    .notify-msg { min-height: 1.1em; font-size: clamp(0.7rem, 2.5vw, 0.8rem); letter-spacing: 0.02em; }
    .notify-msg.ok { color: #22c55e; }
    .notify-msg.err { color: #f87171; }
    .by { margin-top: 1.4rem; color: #57534e; font-size: 0.68rem; letter-spacing: 0.04em; }
    .by a { color: #c7c2bc; text-decoration: underline; }
      :focus-visible { outline: 2px solid #22c55e; outline-offset: 2px; }
</style>
</head>
<body>
  <svg class="wings" viewBox="0 0 89 40" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="MorScan wings">
    <defs>
      <linearGradient id="mwM" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eafbe7"/><stop offset=".18" stop-color="#b7e6ae"/><stop offset=".38" stop-color="#57b45c"/><stop offset=".55" stop-color="#2f8f3f"/><stop offset=".72" stop-color="#4aa551"/><stop offset=".88" stop-color="#9bdb94"/><stop offset="1" stop-color="#d8f2d2"/></linearGradient>
      <linearGradient id="mwS" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset=".25" stop-color="#fff" stop-opacity=".05"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#fff" stop-opacity=".2"/></linearGradient>
    </defs>
    <path d="${WINGS_PATH}" fill="url(#mwM)"/>
    <path d="${WINGS_PATH}" fill="url(#mwS)"/>
  </svg>
  <h1>MorScan</h1>
  <div class="sub">Morpheus AI Block Explorer</div>
  <div class="soon">Coming soon</div>
  <div class="notify-hint">Get an email when it goes live.</div>
  <form class="notify" id="notify-form" novalidate>
    <input type="email" id="notify-email" name="email" placeholder="you@email.com" autocomplete="email" required aria-label="Email address">
    <button type="submit" id="notify-btn">Notify me</button>
  </form>
  <div class="notify-msg" id="notify-msg" role="status" aria-live="polite"></div>
  <div class="by">by <a href="https://drm3.network" target="_blank" rel="noopener">DRM3 Labs</a></div>
  <script>
    (function () {
      var form = document.getElementById('notify-form');
      var input = document.getElementById('notify-email');
      var btn = document.getElementById('notify-btn');
      var msg = document.getElementById('notify-msg');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = (input.value || '').trim();
        msg.className = 'notify-msg';
        if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$/.test(email)) {
          msg.textContent = 'Enter a valid email address.';
          msg.className = 'notify-msg err';
          return;
        }
        btn.disabled = true;
        msg.textContent = 'Saving...';
        fetch('/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        }).then(function (r) {
          return r.json().then(function (d) { return { ok: r.ok, d: d }; });
        }).then(function (res) {
          if (res.ok) {
            form.style.display = 'none';
            msg.textContent = "You're on the list. We'll email you at launch.";
            msg.className = 'notify-msg ok';
          } else {
            btn.disabled = false;
            msg.textContent = (res.d && res.d.error) || 'Something went wrong. Try again.';
            msg.className = 'notify-msg err';
          }
        }).catch(function () {
          btn.disabled = false;
          msg.textContent = 'Network error. Try again.';
          msg.className = 'notify-msg err';
        });
      });
    })();
  </script>
</body>
</html>`;

/** Paths that stay live on a coming-soon host (monitoring + brand assets + launch-list capture). */
const PASSTHROUGH_PATHS = new Set([
	"/health",
	"/version",
	"/morscan-icon.svg",
	"/favicon.ico",
	"/favicon.png",
	"/apple-touch-icon.png",
	"/apple-touch-icon-precomposed.png",
	"/og-image.png",
	"/notify",
]);

export function comingSoonResponse(origin = ""): Response {
	return new Response(comingSoonHtml(origin), {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=300",
		},
	});
}

export function isComingSoonHost(
	hostname: string,
	env: { COMING_SOON_HOSTS?: string },
): boolean {
	const hosts = (env.COMING_SOON_HOSTS || "")
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean);
	return hosts.includes(hostname.toLowerCase());
}

export function comingSoonPassthrough(path: string): boolean {
	// The admin surface for the launch-list captures stays reachable on a coming-soon
	// host: it is the whole point of the holding page (collect emails) that an operator -
	// and an operator admin console, which server-side-fetches /api/admin/notify - can read them.
	// Both are admin-key gated, so passing them through leaks nothing (unauth -> 401).
	if (path === "/api/admin/notify" || path === "/admin/notify") return true;
	return PASSTHROUGH_PATHS.has(path) || path.startsWith("/og/");
}
