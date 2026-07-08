#!/usr/bin/env node
// import-seed.mjs - seed a fresh MorScan D1 from a morpheus-ai-base-data snapshot.
//
// The dataset (schema, data, provenance, verification) lives in its own repo:
//   https://github.com/DRM3Labs-OSS/morpheus-ai-base-data
// This script is MorScan's consumer side: it verifies the snapshot using the
// dataset's own verifier, loads it into a fresh `morscan` D1, and sets the sync
// watermark so live indexing resumes from the snapshot block instead of grinding
// history from genesis.
//
// Prerequisites:
//   - A clone of morpheus-ai-base-data with `npm install` run in it (DATASET_DIR).
//   - The snapshot Release asset downloaded (BLOB, the .sql.gz).
//   - An authed wrangler with write access to the target D1.
//
// Usage:
//   DATASET_DIR=/path/to/morpheus-ai-base-data \
//   BLOB=/path/to/morpheus-ai-base-data-<block>.sql.gz \
//   TARGET_DB=morscan WRANGLER_CONFIG=wrangler.deploy.toml \
//   node scripts/import-seed.mjs

import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATASET_DIR = process.env.DATASET_DIR;
const BLOB = process.env.BLOB;
const TARGET_DB = process.env.TARGET_DB || 'morscan';
const WRANGLER_CONFIG = process.env.WRANGLER_CONFIG || '';
// LOCAL=1 rehearses the whole seed against a local (miniflare) D1 so you can
// dry-run it before touching a remote database. PERSIST_TO isolates that state.
const LOCAL = !!process.env.LOCAL;
const PERSIST_TO = process.env.PERSIST_TO || '';

if (!DATASET_DIR || !BLOB) {
  console.error('ERROR: set DATASET_DIR (clone of morpheus-ai-base-data) and BLOB (the .sql.gz).');
  process.exit(1);
}

const cfg = WRANGLER_CONFIG ? ['--config', WRANGLER_CONFIG] : [];
const target = [
  LOCAL ? '--local' : '--remote',
  ...(LOCAL && PERSIST_TO ? ['--persist-to', PERSIST_TO] : []),
];
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: 'pipe', ...opts });
const d1 = (extra, opts = {}) =>
  run('npx', ['wrangler', 'd1', 'execute', TARGET_DB, ...cfg, ...target, '--yes', ...extra], opts);

// 1. Verify with the dataset's OWN verifier (in-repo key, no network).
console.log('Verifying snapshot with the dataset verifier...');
try {
  const out = run('node', [join(DATASET_DIR, 'verify.mjs'), BLOB]);
  process.stdout.write(out);
  if (!/VERIFIED/.test(out)) throw new Error('verifier did not report VERIFIED');
} catch (e) {
  console.error('ERROR: snapshot verification failed. Aborting.');
  console.error(e.stdout || e.message);
  process.exit(1);
}

// 2. Read the watermark from the (now verified) manifest.
const manifest = JSON.parse(readFileSync(join(DATASET_DIR, 'manifest.json'), 'utf8'));
const wm = manifest.watermark_block;
console.log(`\nWatermark block: ${wm}`);

// 3. Guard against seeding a populated database.
try {
  const check = d1(['--json', '--command', "SELECT COUNT(*) AS n FROM sessions"]);
  const n = JSON.parse(check.slice(check.indexOf('[')))[0]?.results?.[0]?.n ?? 0;
  if (Number(n) > 0) {
    console.error(`ERROR: target ${TARGET_DB} already has ${n} sessions. This script is for a FRESH D1.`);
    process.exit(1);
  }
} catch {
  // sessions table absent on a truly fresh D1 - fine, schema step creates it.
}

// 4. Apply the schema shipped with the snapshot (authoritative for this data).
console.log('Applying schema.sql...');
d1(['--file', join(DATASET_DIR, 'schema.sql')], { stdio: 'inherit' });

// 5. Decompress and import the data.
console.log('Decompressing + importing data (this can take a while)...');
const tmp = mkdtempSync(join(tmpdir(), 'morscan-seed-'));
const dataPath = join(tmp, 'data.sql');
writeFileSync(dataPath, gunzipSync(readFileSync(BLOB)));
d1(['--file', dataPath], { stdio: 'inherit' });

// 6. Set the sync watermark so live indexing resumes from wm + 1, not genesis.
// watermark_block is min(event, builder) frontier, so resuming both streams from
// it cannot skip an event; the small overlap re-derives idempotently.
console.log('Setting sync watermark...');
const cursorSql =
  `INSERT OR REPLACE INTO sync_state (key, value) VALUES ` +
  `('last_event_block','${wm}'),('last_block','${wm}'),('schema_initialized','1'); ` +
  `INSERT OR REPLACE INTO builder_sync_state (key, value) VALUES ` +
  `('last_builder_event_block','${wm}');`;
d1(['--command', cursorSql], { stdio: 'inherit' });

console.log('');
console.log(`Done. ${TARGET_DB} is seeded through Base block ${wm}.`);
console.log(`Live sync resumes from block ${wm + 1}. Deploy/start the worker to continue indexing.`);
console.log('Note: per-provider session offsets and the holder-balance backfill are left at');
console.log('defaults; the first sync re-establishes them idempotently.');
