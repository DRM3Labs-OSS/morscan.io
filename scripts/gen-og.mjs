/**
 * gen-og.mjs - render the per-page share cards to static PNGs.
 *
 * Each page/tab gets its own 1200x630 branded card so a shared link previews
 * the right plane instead of one generic product card. Output lands in
 * src/images/ as og-<page>.png and is bundled as a Data module (see wrangler
 * [[rules]]) and served at /og/<page>.png by src/handlers/ui/assets.ts.
 *
 * Requires Playwright. Run:  node scripts/gen-og.mjs
 * (Landing keeps src/images/og-image.png; subnet pages use KV-backed cards.)
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'images');

const WINGS = `<svg width="150" height="68" viewBox="0 0 89 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M44.5031 36.7108L52.2884 27.0574V39.5L75.154 30.3296L78.4294 22.9099L58.8453 30.8065V28.0173L80.2346 19.2454L83.6775 11.7472L58.7647 21.8776V19.1669L85.7246 7.99814L89 0.5L56.3826 13.818C56.3826 13.818 53.5973 14.8563 52.369 16.8486L44.5031 26.5805L36.6372 16.8486C35.4089 14.8563 32.6236 13.818 32.6236 13.818L0 0.5L3.27539 7.99814L30.2415 19.1608V21.8715L5.32871 11.7472L8.77159 19.2454L30.1609 28.0173V30.8065L10.5768 22.9099L13.8522 30.3296L36.7178 39.5V27.0574L44.5031 36.7108Z" fill="url(#wg)"/><defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eafbe7"/><stop offset=".4" stop-color="#57b45c"/><stop offset=".55" stop-color="#2f8f3f"/><stop offset=".75" stop-color="#4aa551"/><stop offset="1" stop-color="#d8f2d2"/></linearGradient></defs></svg>`;

const CARDS = [
  { slug: 'analytics', name: 'Analytics',          tagline: 'Live intelligence for the Morpheus AI network' },
  { slug: 'compute',   name: 'Compute Explorer',   tagline: 'Providers, sessions, and models in real time' },
  { slug: 'builder',   name: 'Builder Subnets',    tagline: 'Subnets, emissions, and staking rewards' },
  { slug: 'holders',   name: 'MOR Holders',        tagline: 'Every MOR holder on Base, ranked by balance' },
  { slug: 'pools',     name: 'Staking Pools',      tagline: 'Compute and Builder pools on Morpheus' },
  { slug: 'api',       name: 'MorScan API',        tagline: 'Morpheus blockchain data, one call away' },
  { slug: 'stake',     name: 'Stake for Capacity', tagline: 'Stake MOR, raise your API limits' },
  { slug: 'about',     name: 'About MorScan',      tagline: 'The open block explorer for Morpheus' },
];

function html(card) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1200px; height:630px; }
  .card {
    width:1200px; height:630px; position:relative; overflow:hidden;
    background:#0c0a09;
    font-family: ui-monospace, "SF Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace;
    color:#fafaf9;
    display:flex; flex-direction:column; justify-content:center;
    padding:0 96px;
  }
  .glow { position:absolute; inset:0;
    background:
      radial-gradient(1100px 620px at 82% 8%, rgba(34,197,94,0.16), rgba(34,197,94,0) 60%),
      radial-gradient(900px 520px at 6% 108%, rgba(34,197,94,0.10), rgba(34,197,94,0) 55%);
  }
  .grid { position:absolute; inset:0; opacity:0.05;
    background-image:linear-gradient(#22c55e 1px,transparent 1px),linear-gradient(90deg,#22c55e 1px,transparent 1px);
    background-size:48px 48px; }
  .rule { position:absolute; left:0; right:0; height:6px; background:#22c55e; }
  .top { top:0; } .bot { bottom:0; opacity:0.65; }
  .inner { position:relative; z-index:2; }
  .brandrow { display:flex; align-items:center; gap:26px; margin-bottom:40px; }
  .brandrow .mm { font-size:30px; font-weight:700; letter-spacing:0.42em; text-transform:none; color:#d6d3d1; }
  h1 { font-size:96px; line-height:1.02; font-weight:800; letter-spacing:-0.02em; color:#fafaf9; }
  .tag { margin-top:30px; font-size:34px; line-height:1.4; color:#a8a29e; max-width:900px; }
  .foot { position:absolute; z-index:2; bottom:52px; left:96px; right:96px;
    display:flex; justify-content:space-between; align-items:baseline;
    font-size:26px; color:#78716c; letter-spacing:0.04em; }
  .foot .dom { color:#22c55e; font-weight:600; }
</style></head><body>
  <div class="card">
    <div class="glow"></div><div class="grid"></div>
    <div class="rule top"></div><div class="rule bot"></div>
    <div class="inner">
      <div class="brandrow">${WINGS}<span class="mm">MorScan</span></div>
      <h1>${card.name}</h1>
      <div class="tag">${card.tagline}</div>
    </div>
    <div class="foot"><span>Morpheus Block Explorer</span><span class="dom">morscan.io</span></div>
  </div>
</body></html>`;
}

// Home / default social card -> src/images/og-image.png. This is the site-wide OG
// fallback + the README hero, so it carries the full brand: wings, wordmark,
// subtitle, four stat tiles, and a provenance line. Kept here so the whole OG
// set regenerates from one pipeline. The brand renders as "MorScan"
// (capital M and S) everywhere it displays.
function homeHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1200px; height:630px; }
  .card { width:1200px; height:630px; position:relative; overflow:hidden; background:#0c0a09;
    font-family: ui-monospace, "SF Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace; color:#fafaf9;
    display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:0 80px; }
  .glow { position:absolute; inset:0;
    background: radial-gradient(760px 460px at 50% 20%, rgba(34,197,94,0.18), rgba(34,197,94,0) 62%); }
  .grid { position:absolute; inset:0; opacity:0.05;
    background-image:linear-gradient(#22c55e 1px,transparent 1px),linear-gradient(90deg,#22c55e 1px,transparent 1px);
    background-size:48px 48px; }
  .inner { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; }
  .wings { filter: drop-shadow(0 0 30px rgba(34,197,94,0.55)); margin-bottom:26px; }
  h1 { font-size:104px; line-height:1; font-weight:800; letter-spacing:-0.01em; color:#fafaf9; }
  .sub { margin-top:20px; font-size:27px; letter-spacing:0.34em; text-transform:uppercase; color:#a8a29e; }
  .divider { width:120px; height:3px; background:#22c55e; opacity:0.8; margin:34px 0 30px; }
  .tiles { display:flex; gap:18px; }
  .tile { border:1px solid #292524; background:rgba(28,25,23,0.7); padding:16px 22px; min-width:190px; }
  .tile .k { font-size:34px; font-weight:700; color:#22c55e; }
  .tile .v { font-size:18px; color:#a8a29e; letter-spacing:0.04em; margin-top:4px; }
  .foot { position:absolute; z-index:2; bottom:44px; left:0; right:0; text-align:center;
    font-size:23px; color:#78716c; letter-spacing:0.06em; }
  .foot b { color:#a8a29e; font-weight:600; }
</style></head><body>
  <div class="card">
    <div class="glow"></div><div class="grid"></div>
    <div class="inner">
      <div class="wings">${WINGS.replace('width="150" height="68"', 'width="176" height="79"')}</div>
      <h1>MorScan</h1>
      <div class="sub">Morpheus Block Explorer &middot; Base L2</div>
      <div class="divider"></div>
      <div class="tiles">
        <div class="tile"><div class="k">Providers</div><div class="v">LIVE NETWORK</div></div>
        <div class="tile"><div class="k">Sessions</div><div class="v">100K+ INDEXED</div></div>
        <div class="tile"><div class="k">Subnets</div><div class="v">BUILDER EMISSIONS</div></div>
        <div class="tile"><div class="k">Signed</div><div class="v">ED25519 RECEIPTS</div></div>
      </div>
    </div>
    <div class="foot">REAL-TIME &middot; <b>PROVENANCE-SIGNED</b> &middot; OPEN SOURCE</div>
  </div>
</body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
for (const card of CARDS) {
  await page.setContent(html(card), { waitUntil: 'networkidle' });
  const el = await page.$('.card');
  await el.screenshot({ path: join(OUT, `og-${card.slug}.png`) });
  console.log('wrote og-' + card.slug + '.png');
}
await page.setContent(homeHtml(), { waitUntil: 'networkidle' });
await (await page.$('.card')).screenshot({ path: join(OUT, 'og-image.png') });
console.log('wrote og-image.png');
await browser.close();
