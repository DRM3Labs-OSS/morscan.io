// Consent-gated Google Analytics banner.
//
// Injected before </body> on every human HTML page at the cachedPage seam
// (src/routes/ui.ts). The gtag script is NOT part of this snippet: it is
// created client-side strictly after the visitor clicks Accept, so no request
// reaches Google before consent. The choice persists in localStorage
// ("drm3_cc"); the snippet also appends a "Cookie settings" link to the shared
// footer nav so a visitor can change their mind later. Deployments without
// GA_MEASUREMENT_ID (standalone operators, local dev) render nothing.
//
// The injected HTML is identical for every visitor, so it is safe under the
// path-keyed edge cache; all consent state lives in the browser.
import { gaId } from "../config";

/** The banner + gate script, or "" when analytics is not configured. */
export function consentSnippet(): string {
	const id = gaId();
	if (!id) return "";
	return `
<style>
#drm3-cc{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:#0b0f1a;color:#e6e9f0;border-top:1px solid #2a3142;font:14px/1.5 system-ui,sans-serif;text-align:left}
#drm3-cc[hidden]{display:none}
#drm3-cc .cc-in{max-width:760px;margin:0 auto;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}
#drm3-cc p{margin:0;flex:1 1 340px;min-width:260px}
#drm3-cc a{color:#9db4ff;text-decoration:underline}
#drm3-cc .cc-btns{display:flex;gap:8px;flex:0 0 auto}
#drm3-cc button{font:inherit;font-weight:600;padding:8px 14px;border-radius:6px;cursor:pointer;border:1px solid #e6e9f0;min-height:40px}
#drm3-cc .cc-accept{background:#e6e9f0;color:#0b0f1a}
#drm3-cc .cc-decline{background:transparent;color:#e6e9f0}
#drm3-cc button:focus-visible{outline:2px solid #9db4ff;outline-offset:2px}
</style>
<div id="drm3-cc" hidden role="region" aria-label="Cookie consent">
  <div class="cc-in">
    <p><strong>Analytics cookies?</strong> We would like to use Google Analytics to see which pages are useful. It sets cookies and shares usage data with Google. Nothing loads unless you accept, and you can change your mind any time under Cookie settings in the footer. <a href="/privacy">Privacy policy</a></p>
    <div class="cc-btns">
      <button type="button" class="cc-decline" data-cc-decline>Decline</button>
      <button type="button" class="cc-accept" data-cc-accept>Accept analytics</button>
    </div>
  </div>
</div>
<script>
(function(){
  if (window.__drm3cc) return; window.__drm3cc = 1;
  var KEY = "drm3_cc", ID = "${id}";
  function read(){ try { return localStorage.getItem(KEY); } catch(e){ return null; } }
  function write(v){ try { localStorage.setItem(KEY, v); } catch(e){} }
  function loadGA(){
    if (window.__drm3ga) return; window.__drm3ga = 1;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function(){ window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", ID);
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
    document.head.appendChild(s);
  }
  function clearGaCookies(){
    var host = location.hostname, doms = [host, "." + host];
    var parts = host.split(".");
    if (parts.length > 2) doms.push("." + parts.slice(-2).join("."));
    document.cookie.split(";").forEach(function(chunk){
      var n = chunk.split("=")[0].trim();
      if (n === "_ga" || n.indexOf("_ga_") === 0) {
        document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
        doms.forEach(function(d){
          document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=" + d;
        });
      }
    });
  }
  var banner = document.getElementById("drm3-cc");
  function decide(v){
    write("v1:" + v);
    if (banner) banner.hidden = true;
    if (v === "granted") loadGA(); else clearGaCookies();
  }
  window.drm3CookieSettings = function(){ if (banner) banner.hidden = false; };
  if (banner) {
    banner.querySelector("[data-cc-accept]").addEventListener("click", function(){ decide("granted"); });
    banner.querySelector("[data-cc-decline]").addEventListener("click", function(){ decide("denied"); });
  }
  var nav = document.querySelector(".footer-nav");
  if (nav && !nav.querySelector("[data-cc-open]")) {
    var sep = document.createElement("span");
    sep.className = "footer-sep";
    sep.setAttribute("aria-hidden", "true");
    sep.textContent = "\\u00b7";
    var link = document.createElement("a");
    link.href = "#";
    link.textContent = "Cookie settings";
    link.setAttribute("data-cc-open", "1");
    link.addEventListener("click", function(e){ e.preventDefault(); window.drm3CookieSettings(); });
    nav.appendChild(sep);
    nav.appendChild(link);
  }
  var v = read();
  if (v === "v1:granted") loadGA();
  else if (v !== "v1:denied") { if (banner) banner.hidden = false; }
})();
</script>`;
}
