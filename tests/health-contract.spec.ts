// Health contract conformance - MorScan
// Asserts GET /health satisfies the canonical health-contract shape for
// sku `morscan` (syncedBlock, blocksBehind, providers, activeSessions,
// stakingFactor) while keeping the public fields the site reads, and that a
// request without the operator read key gets only what public-health.allow names.
//
// Run: MORSCAN_URL=https://staging.morscan.io npx playwright test tests/health-contract.spec.ts

import { test, expect } from '@playwright/test';
// This OSS repo vendors the health contract (see src/utils/health-contract.ts,
// originally @drm3/health-contract) - validate against the same module the
// producer uses so the two cannot drift apart.
import { validateHealth } from '../src/utils/health-contract';

const BASE = process.env.MORSCAN_URL || 'http://localhost:8788';

test.describe('Health contract conformance', () => {
  test('/health validates against the MorScan contract', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();

    const result = validateHealth('morscan', body);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.metrics).toMatchObject({
      syncedBlock: expect.any(Number),
      blocksBehind: expect.any(Number),
      providers: expect.any(Number),
      activeSessions: expect.any(Number),
      stakingFactor: expect.any(Number),
    });
  });

  test('/health keeps the public fields the site reads', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`);
    const body = await resp.json();

    // Top-level fields the sync bar, the syncing banner and the about page read.
    expect(body.sku).toBe('morscan');
    expect(typeof body.currentBlock).toBe('number');
    expect(typeof body.blocksBehind).toBe('number');
    expect(typeof body.bids).toBe('number');
    expect(body.lastSyncTimestamp).toBeTruthy();
    expect(typeof body.claimable_list_consistent).toBe('boolean');
    expect(['consistent', 'partial']).toContain(body.accounting_signal);

    // The per-contract detail is public; the builder pages read its cursor.
    expect(body.extended.contracts.diamond.address).toBeTruthy();
    expect(body.extended.contracts.mor_token).toBeTruthy();
    expect(typeof body.extended.contracts.builder.syncedBlock).toBe('number');
  });

  test('/health without the operator read key serves only listed fields', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`);
    expect(resp.headers()['cache-control']).toBe('no-store');
    expect(resp.headers()['vary']).toContain('X-DRM3-Ops-Key');
    const body = await resp.json();

    // public-health.allow at the repo root is the list; these are not on it.
    expect(body.service).toBeUndefined();
    expect(body.morscanVersion).toBeUndefined();
    expect(body.startBlock).toBeUndefined();
    expect(body.extended.build).toBeUndefined();
    expect(body.extended.eventCursorBlock).toBeUndefined();
    expect(Object.keys(body.extended)).toEqual(['contracts']);
  });
});
