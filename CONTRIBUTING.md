# Contributing to MorScan

Contributions are welcome - open an issue or a PR. Bug fixes, new handlers, docs
improvements, and ideas are all appreciated, and small focused PRs are easiest to
review. Be kind.

MorScan is a Morpheus blockchain explorer that runs as a **Cloudflare Worker** backed
by **D1** (SQLite at the edge). It indexes Morpheus activity on Base, caches it in D1,
and serves a dashboard + read API.

## Prerequisites

- Node.js 22+ and npm
- A Cloudflare account + [`wrangler`](https://developers.cloudflare.com/workers/wrangler/)
  (for local dev and deploy)

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for first-run setup (account
id, D1 database, env vars).

## Build, test, lint

```bash
npm install

npm run typecheck     # tsc --noEmit (must be clean)
npm run lint          # biome lint src/ (must be clean)
npm run build         # wrangler deploy --dry-run (compile check)
npm run dev           # wrangler dev - local worker
```

All three gates (`typecheck`, `lint`, `build`) must pass before a PR - this is the
**green-before-commit** rule. Run them locally and keep them clean; the same checks run
in CI. If the change touches behavior with tests, run those too (`npm test`). Use
`npm run lint:fix` to auto-apply safe fixes.

## Code layout

| Path | What |
|------|------|
| `src/index.ts` | Worker entry: `fetch` (HTTP) + `scheduled` (cron indexing) |
| `src/routes/` | HTTP routing (public, api, ui) |
| `src/handlers/` | Endpoint logic (marketplace, sessions, providers, holders, analytics, health, …) |
| `src/sync/` | Chain indexer - reads Base, computes state, writes D1 |
| `src/utils/` | Provenance signing, snapshots, RPC, helpers |
| `src/ui/` | Dashboard HTML/templates (string-imported assets) |
| `src/config.ts`, `src/types.ts` | Config resolution + env/type definitions |
| `docs/` | Architecture, specs, getting-started |

## Provenance

MorScan signs its API responses and marketplace snapshots with Ed25519 receipts using
the npm package `@drm3labs-oss/provenance` (compiled WASM + JS bindings, pinned in
`package-lock.json`). That package is separately licensed (MIT) and **not** covered by
this repo's FSL-1.1-MIT license. Provenance is active when `MORSCAN_MNEMONIC` is configured; without
it, signing is skipped and the explorer still serves normally.

## Conventions

- Keep files focused and cohesive; a module that is growing sprawling should be split
  rather than left to grow. Small files are easier to review and reason about.
- **TypeScript everywhere**, including the sync and API code. Keep `tsc` and `biome` clean.
- **Vanilla front end.** The dashboard is plain TypeScript/JS with HTML5 Canvas charts.
  There is no React, no Vue, and no charting library, and the tiny/fast bundle is a
  feature. Do not add a framework or a heavy dependency to solve a UI problem; the
  runtime dependency list is seven packages and should stay small. The aesthetic is a clean,
  native monospace look; match it rather than introducing new visual systems.
- **No em dashes in any copy** (code comments, UI strings, docs, commit messages). The
  repo is swept to zero. Use a hyphen or rework the sentence.
- Commit messages describe **what changed and what you verified**, imperative mood.
- Small, atomic commits.
- Don't hardcode deployment-specific hosts/ids - route them through `src/config.ts`
  env vars (see the env table in [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)).

## Reporting bugs and proposing features

- **Bugs:** open an issue with the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).
  Include the reproduction, what you expected, what happened, and your MorScan / Node /
  wrangler versions.
- **Features and ideas:** open an issue with the
  [feature request template](.github/ISSUE_TEMPLATE/feature_request.md). Describe the
  problem first, then the proposed solution.
- **Security vulnerabilities:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Pull requests

1. Fork, branch from `main`.
2. Make the change; keep `typecheck`, `lint`, and `build` green.
3. Update docs if behavior changed.
4. Open a PR describing the change, the rationale, and how you verified it.

## License

By contributing you agree your contributions are licensed under the repository's
[FSL-1.1-MIT](LICENSE) (Fair Source: free to use, fork, and self-host; no competing hosted service for 2 years; every release becomes MIT after two years, guaranteed).
