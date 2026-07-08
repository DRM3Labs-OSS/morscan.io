/**
 * One-time historical MOR/USD backfill for price_history.
 *
 * Fills price_history from the MOR/WETH pool's on-chain creation block forward
 * to where our live-recorded series already begins, at an hourly-ish cadence, so
 * the longer chart windows (6mo / 1yr / all-time) show real history instead of a
 * flat/empty stretch. It reuses the EXACT price math the live path uses
 * (decodeOnchainPrice from src/utils/onchain-price.ts) evaluated at each
 * historical block via an archive Base RPC, and writes idempotently
 * (INSERT OR REPLACE on ts) via `wrangler d1 execute --file`.
 *
 * Reads only: the pool slot0() and the Chainlink ETH/USD latestRoundData(), each
 * at a historical block tag. Writes only: price_history. It does not touch live
 * price recording or the block-event backfill (different table/concern).
 *
 * Resumable: a cursor file (.cursor.json) records the last block whose batch was
 * successfully written; a restart resumes from there. Re-running from scratch is
 * safe too (INSERT OR REPLACE).
 *
 * Run (from the repo root):
 *   npx esbuild tools/price-backfill/backfill.ts --bundle --platform=node \
 *     --format=esm --outfile=<tmp>/backfill.mjs && node <tmp>/backfill.mjs
 * Env required (exported from the container .env):
 *   MORSCAN_BACKFILL_ALCHEMY_URL  archive Base RPC (personal free key; kept off
 *                                 the live-sync key so backfill cannot starve it)
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  for wrangler d1 execute --remote
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeOnchainPrice, MOR_POOL_ADDRESS, CHAINLINK_ETH_USD } from '../../src/utils/onchain-price';

// keccak256(sig)[:4]; same selectors the live read uses.
const SEL_SLOT0 = '0x3850c7bd'; // slot0()
const SEL_LATEST_ROUND_DATA = '0xfeaf968c'; // latestRoundData()

// Pool creation block on Base, found by archive binary search on eth_getCode
// (first block where the pool has code). Block 20211650 is empty, 20211651 has
// code and an initialised slot0. That block is 2024-09-24T21:17:29Z - the pool
// contract's actual on-chain origin.
const POOL_CREATION_BLOCK = 20211651;

// Base is a ~2s chain, so one hourly sample is ~1800 blocks.
const STEP_BLOCKS = 1800;

// Where our LIVE-recorded series began: 2026-04-05T02:01:42Z (the original
// MIN(ts) of price_history before this backfill). The backfill fills everything
// strictly BEFORE this instant; the live recorder owns everything at/after it. A
// fixed constant (not the current MIN(ts), which our own historical rows lower)
// so re-runs always stop at the live boundary rather than at the origin.
const LIVE_SERIES_START_TS = 1775354502;

const RPC = process.env.MORSCAN_BACKFILL_ALCHEMY_URL;
if (!RPC) throw new Error('MORSCAN_BACKFILL_ALCHEMY_URL not set');

// Run this from the repo root (node reads it via an esbuild bundle elsewhere, so
// anchor all repo paths on cwd, not the bundle location).
const REPO_ROOT = process.cwd();
const HERE = join(REPO_ROOT, 'tools', 'price-backfill');
const CURSOR_FILE = join(HERE, '.cursor.json');
const SQL_TMP = join(HERE, '.batch.sql');

const RPC_BATCH_SAMPLES = 15; // samples per HTTP round-trip (x3 sub-calls each)
const FLUSH_ROWS = 500; // rows per wrangler d1 execute --file
const REQ_DELAY_MS = 250; // pace between HTTP requests (free-tier friendly)

interface JsonRpcResp { id: number; result?: unknown; error?: { code?: number; message?: string } }

const bn = (b: number): string => `0x${b.toString(16)}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number): number => Math.min(20000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

/** A per-item error is a soft (rate-limit / capacity) failure worth retrying,
 *  vs a permanent one (e.g. a reverted call) we accept and skip. */
function isRateLimit(err?: { code?: number; message?: string }): boolean {
  if (!err) return false;
  if (err.code === 429) return true;
  const m = (err.message || '').toLowerCase();
  return m.includes('compute unit') || m.includes('rate') || m.includes('capacity') ||
    m.includes('limit exceeded') || m.includes('too many') || m.includes('throughput');
}

/** Batched JSON-RPC POST. Retries the WHOLE batch (backoff) until every sub-call
 *  has a result, tolerating only permanent per-item errors so a rate-limited
 *  partial response is never silently dropped. Results are hex strings
 *  (eth_call) or objects (eth_getBlockByNumber). Throws if still incomplete
 *  after the retry budget, so the run fails loudly and resumes from the cursor
 *  rather than writing a sparse series. */
async function rpcBatch(reqs: { id: number; method: string; params: unknown[] }[]): Promise<Map<number, unknown>> {
  const body = reqs.map((r) => ({ jsonrpc: '2.0', ...r }));
  const allIds = new Set(reqs.map((r) => r.id));
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const resp = await fetch(RPC as string, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      if (resp.status === 429 || resp.status >= 500 || !resp.ok) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const arr = (await resp.json()) as JsonRpcResp[];
      if (!Array.isArray(arr)) { await sleep(backoffMs(attempt)); continue; }
      const map = new Map<number, unknown>();
      const permanentlyFailed = new Set<number>();
      for (const r of arr) {
        if (r.result !== undefined && r.result !== null) map.set(r.id, r.result);
        else if (r.error && !isRateLimit(r.error)) permanentlyFailed.add(r.id);
      }
      // Complete once every id is either resolved or permanently failed.
      let settled = true;
      for (const id of allIds) {
        if (!map.has(id) && !permanentlyFailed.has(id)) { settled = false; break; }
      }
      if (settled) return map;
      await sleep(backoffMs(attempt)); // rate-limited partial: back off, retry whole batch
    } catch {
      await sleep(backoffMs(attempt));
    }
  }
  throw new Error('rpcBatch: incomplete after retry budget');
}

interface SampleRow { ts: number; usd: number; ethUsd: number }

/** Fetch + decode a group of sample blocks in one batched round-trip. */
async function fetchSamples(blocks: number[]): Promise<SampleRow[]> {
  const reqs: { id: number; method: string; params: unknown[] }[] = [];
  blocks.forEach((b, i) => {
    const base = i * 3;
    reqs.push({ id: base + 1, method: 'eth_getBlockByNumber', params: [bn(b), false] });
    reqs.push({ id: base + 2, method: 'eth_call', params: [{ to: MOR_POOL_ADDRESS, data: SEL_SLOT0 }, bn(b)] });
    reqs.push({ id: base + 3, method: 'eth_call', params: [{ to: CHAINLINK_ETH_USD, data: SEL_LATEST_ROUND_DATA }, bn(b)] });
  });
  const map = await rpcBatch(reqs);

  const rows: SampleRow[] = [];
  blocks.forEach((_, i) => {
    const base = i * 3;
    const blk = map.get(base + 1) as { timestamp?: string } | undefined;
    const slot0 = map.get(base + 2);
    const roundData = map.get(base + 3);
    if (!blk?.timestamp || typeof slot0 !== 'string' || typeof roundData !== 'string') return; // missing sub-call
    const ts = parseInt(blk.timestamp, 16);
    if (!(ts > 0)) return;
    // Same formula as the live read; skip zero/absurd samples (pre-liquidity, etc).
    const p = decodeOnchainPrice(slot0, roundData);
    if (!p) return;
    // Same rounding recordPriceHistory writes with.
    rows.push({ ts, usd: Math.round(p.morUsd * 1e6) / 1e6, ethUsd: Math.round(p.ethUsd * 100) / 100 });
  });
  return rows;
}

// --- D1 write via wrangler --------------------------------------------------

function flushToD1(rows: SampleRow[]): void {
  if (!rows.length) return;
  const values = rows.map((r) => `(${r.ts},${r.usd},${r.ethUsd})`).join(',');
  const sql = `INSERT OR REPLACE INTO price_history (ts, usd, eth_usd) VALUES ${values};\n`;
  writeFileSync(SQL_TMP, sql);
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'morscan', '--config', 'wrangler.deploy.toml', '--remote', '--file', SQL_TMP],
    { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

interface Cursor { nextBlock: number; written: number; skipped: number }

function loadCursor(): Cursor | null {
  if (!existsSync(CURSOR_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CURSOR_FILE, 'utf8')) as Cursor;
  } catch {
    return null;
  }
}

function saveCursor(c: Cursor): void {
  mkdirSync(HERE, { recursive: true });
  writeFileSync(CURSOR_FILE, JSON.stringify(c));
}

async function main(): Promise<void> {
  // End of the backfill = the fixed live-series start (see LIVE_SERIES_START_TS).
  const existingMinTs = LIVE_SERIES_START_TS;
  console.log('backfill boundary (live start):', existingMinTs, new Date(existingMinTs * 1000).toISOString());

  const cursor = loadCursor() ?? { nextBlock: POOL_CREATION_BLOCK, written: 0, skipped: 0 };
  console.log('resuming from block', cursor.nextBlock, '(written so far', cursor.written, 'skipped', cursor.skipped, ')');

  let pending: SampleRow[] = [];
  let block = cursor.nextBlock;
  let done = false;

  while (!done) {
    // Build the next group of sample blocks.
    const group: number[] = [];
    for (let i = 0; i < RPC_BATCH_SAMPLES; i++) {
      group.push(block);
      block += STEP_BLOCKS;
    }
    const rows = await fetchSamples(group);

    // Stop once samples cross into the live series (ts >= existingMinTs).
    for (const r of rows) {
      if (r.ts >= existingMinTs) {
        done = true;
        break;
      }
      pending.push(r);
    }
    cursor.skipped += group.length - rows.length;

    if (pending.length >= FLUSH_ROWS || done) {
      const chunk = pending.slice(0, done ? pending.length : FLUSH_ROWS);
      flushToD1(chunk);
      cursor.written += chunk.length;
      pending = pending.slice(chunk.length);
      cursor.nextBlock = block; // next group to fetch on resume
      saveCursor(cursor);
      console.log('flushed', chunk.length, 'rows; block now', block,
        'lastTs', chunk.length ? new Date(chunk[chunk.length - 1].ts * 1000).toISOString() : 'n/a',
        'total written', cursor.written);
    }

    await sleep(REQ_DELAY_MS);
  }

  // Flush any remainder.
  if (pending.length) {
    flushToD1(pending);
    cursor.written += pending.length;
    saveCursor(cursor);
    console.log('final flush', pending.length, 'rows; total written', cursor.written);
  }
  console.log('DONE. written', cursor.written, 'skipped', cursor.skipped);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
