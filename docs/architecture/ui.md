# UI Architecture

The explorer UI is read-only and public: no sign-in is required to browse any
page. `/console` is the site's single sign-in door (wallet-first) and exists for
API-key management, not for viewing the explorer.

## Template System

Most pages use a shared Mustache layout; a few (about, legal, console, 404) are
standalone documents.

```
layout.mustache (owns full HTML document: <html> through </html>)
    ↓ Mustache.render()
Content fragments (just <style> + HTML, no document shell)
```

**Flow:**
1. Handler assembles the page fragment (markup + script files under `src/ui/`)
2. Handler calls `render(PageParams)` with title, description, styles, content, scripts
3. `render()` merges layout + fragment via Mustache (header via `morscan_header.ts`)
4. Returns a complete HTML document

**Files:**
- `src/shell.ts` - `render(PageParams)` function
- `src/morscan_header.ts` - unified header component (nav planes, price ticker)
- `src/ui/layout.mustache` - shared document skeleton (head, footer, CSS vars)
- `src/handlers/ui/` - page handlers (`compute.ts`, `builder.ts`, `pages.ts`, `assets.ts`, `seo.ts`)
- `src/routes/ui.ts` - route dispatch + edge caching (CF Cache API, ~30s per page)

Large pages are split into sub-200-line fragments and recombined at build time,
e.g. `app-markup.html` + `app-script.html`, `api-markup.html` +
`api-script-1.html` + `api-script-2.html` + `api-styles.html`,
`provider-detail-markup.html` + `provider-detail-script.html`,
`wallet-detail-markup.html` + `wallet-detail-script.html`,
`console-head.html` + `console-body.html` + `console-script.html`.

## Pages

All routes are public. Canonical URLs follow `/<parent>/<subtab>`; parent paths
redirect to their first subtab and every legacy flat path (`/providers`,
`/consumers`, `/network`, `/builder/calc`, ...) 301s to its canonical
equivalent. `GET /login` 302s to `/console`.

| Path | Templates | Description |
|------|-----------|-------------|
| `/` | landing.html | Landing page |
| `/compute/network`, `/compute/providers`, `/compute/consumers` | app-markup.html + app-script.html | SPA: network stats, provider leaderboard, consumer wallets |
| `/compute/providers/:addr` | provider-detail-markup.html + script | Provider dashboard: bids, sessions, reputation |
| `/compute/consumers/wallet/:addr` | wallet-detail-markup.html + script | Wallet detail: balances, stakes, sessions |
| `/analytics/overview` | analytics-tab.html | Network analytics |
| `/api/playground`, `/api/docs` | api-markup.html + api-script-1/2.html + api-styles.html | API playground and OpenAPI docs |
| `/holders/all`, `/holders/dust` | holders.html | MOR holders, dust wallets |
| `/builder/subnets`, `/builder/calculator`, `/builder/api` | builder.html, builder-calc.html | Builder staking plane |
| `/builder/subnet/:subnetId` | builder-subnet.html | Subnet detail |
| `/pools` | pools.html | Pool stats |
| `/stake` | stake.html | Stake-for-capacity page (standalone) |
| `/console` | console-head/body/script.html | Wallet-first sign-in + API-key management (standalone) |
| `/about`, `/terms`, `/privacy` | about.html, terms.html, privacy.html | Standalone, no shell header |
| `/404` | 404.html | Error page (standalone) |

Page scripts call the metered API with a server-injected serving key
(`window.MORSCAN_API_KEY`, from the `MORSCAN_DEMO_KEY` secret); per-IP rate
limits still apply to every browser. See [`security.md`](security.md).

## Fatboy Architecture

One pre-built JSON blob powers the SPA. Rebuilt every cron cycle (1 minute).

- `buildFatboy()` in `src/handlers/fatboy.ts` runs 20+ parallel D1 queries
- Result cached in the D1 `sync_state` table as `fatboy_cache`
- Served to the SPA via `/mor/v1/ui-init` (KV-cached 30s)
- Instant page loads since all data is pre-aggregated - near-zero per-request D1 pressure

## Service Worker

Minimal SW (`src/ui/sw.txt`, served at `/sw.js`):
- Cache versioning (morscan-v1)
- Skip waiting + claim clients on install
- No prefetch - server SSR is fast enough (<100ms)

## Design

- Dark theme: `#0c0a09` background, `#fafaf9` text
- Accent: Morpheus green `#22c55e`
- Font: IBM Plex Mono (monospace throughout)
- Border radius: 0 globally (sharp corners)
- No localStorage. Ever.
