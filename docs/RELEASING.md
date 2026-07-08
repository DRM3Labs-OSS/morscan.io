# Releasing MorScan

MorScan ships as a single Cloudflare Worker. A release is a clean set of green
checks, a version bump, a signed tag, and a `wrangler deploy`. Keep it boring.

## Version

The version lives in two places and must match:

- `package.json` -> `"version"`
- `src/version.ts` -> `MORSCAN_VERSION`

Bump both, and add a matching top entry to [`CHANGELOG.md`](CHANGELOG.md).
MorScan follows [semantic versioning](https://semver.org).

## Pre-flight gates (all must be green)

```bash
npm run format        # biome format --write src/   (normalize)
npm run format:check  # biome format src/           (must report no changes)
npm run lint          # biome lint src/             (must be clean)
npm run typecheck     # tsc --noEmit                (must be clean)
npm run build         # wrangler deploy --dry-run   (full bundle check)
```

`npm run format` rewrites; `npm run format:check` is the read-only gate that CI
runs. If `format:check` reports changes, run `format` and commit the result.

House rule: **no em, en, or minus dashes** anywhere in tracked text (code,
comments, UI copy, docs, commit messages). CI fails the build on any hit. Use a
hyphen or reword.

## Commit, tag, push

Commit by explicit pathspec (never a bare `git commit -a`), so nothing
unintended is swept in:

```bash
git add -- package.json src/version.ts docs/CHANGELOG.md <other changed paths>
git commit -m "release: vX.Y.Z - <one-line summary of what changed>"

git tag -a vX.Y.Z -m "MorScan vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

## Deploy

```bash
npm run deploy        # wrangler deploy
```

`scripts/stamp-build.mjs` runs automatically before `dev`, `build`, `typecheck`,
and `deploy`, stamping the git commit into `src/build-info.ts` (gitignored). The
deployed build reports that commit at `/version`, in `/health`, and in the UI
footer, so any running instance traces back to an exact source commit.

For operator-specific deploys (real Cloudflare account, D1, and KV ids) keep
those values in a private, gitignored `wrangler.deploy.toml` and deploy with
`wrangler deploy --config wrangler.deploy.toml`. The committed `wrangler.toml`
stays a neutral template so a fresh clone belongs to no particular operator.
