# AGENTS.md - MorScan

Guidance for AI coding agents (and humans) working in this repo. Everything here is
**as-built** and verified against the code.

## What this is

MorScan is a **Morpheus blockchain explorer**. It runs as a **Cloudflare Worker**
backed by **D1** (SQLite at the edge): it indexes Morpheus activity on Base, caches
provider/session/bid/price state in D1, and serves a dashboard + read API.
TypeScript, no build framework beyond Wrangler.

## Build, run, test

```bash
npm install

npm run typecheck     # tsc --noEmit (must be clean)
npm run lint          # biome lint src/ (must be clean)
npm run build         # wrangler deploy --dry-run (compile check)
npm run dev           # wrangler dev - run the worker locally
```

All three gates (`typecheck`, `lint`, `build`) must stay green.

## To deploy your own

Configure `wrangler.toml` (it ships as a template with placeholders): set your
Cloudflare `account_id`, create a D1 database (`npm run db:create` / `wrangler d1
create`), set its `database_id`, and set the env vars. Full steps + the env table are
in [docs/GETTING_STARTED.md](GETTING_STARTED.md). Then `npm run deploy`.

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Worker entry: `fetch` (HTTP) + `scheduled` (cron indexing) |
| `src/routes/` | HTTP routing (public, api, ui) |
| `src/handlers/` | Endpoint logic (marketplace, sessions, providers, holders, analytics, health, …) |
| `src/sync/` | Chain indexer - reads Base, computes state, writes D1 |
| `src/utils/` | Provenance signing, snapshots, RPC helpers |
| `src/ui/` | Dashboard HTML/templates (string-imported assets) |
| `src/config.ts`, `src/types.ts` | Config resolution + env/type definitions |

## Conventions / gotchas

- Keep `typecheck`, `lint`, and `build` green; `npm run lint:fix` auto-fixes.
- TypeScript only; keep files focused and reasonably small.
- Don't hardcode deployment hosts/ids/secrets - route them through `src/config.ts` env
  vars.
- Provenance signing activates only when `MORSCAN_MNEMONIC` is set; otherwise it's
  skipped and the explorer still serves. The provenance implementation is the npm
  package `@drm3labs-oss/provenance` (compiled WASM + JS bindings); it is separately
  licensed (MIT) and not covered by this repo's FSL-1.1-MIT license.

## More

[README](../README.md) · [Getting Started](GETTING_STARTED.md) ·
[Contributing](../CONTRIBUTING.md) · [Architecture](ARCHITECTURE.md)
