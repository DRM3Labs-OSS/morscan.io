// Health contract conformance - MorScan
// Asserts GET /health satisfies the canonical health-contract shape for
// sku `morscan` (syncedBlock, blocksBehind, providers, activeSessions,
// stakingFactor) while keeping the legacy fields existing consumers read.
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

  test('/health keeps legacy fields intact', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`);
    const body = await resp.json();

    // Legacy top-level fields still read by existing consumers.
    expect(body.service).toBe('morscan');
    expect(typeof body.currentBlock).toBe('number');
    expect(typeof body.bids).toBe('number');
    expect(body.lastSyncTimestamp).toBeTruthy();
    expect(typeof body.claimable_list_consistent).toBe('boolean');
    expect(['consistent', 'partial']).toContain(body.accounting_signal);

    // Extended detail blocks preserved.
    expect(body.extended.contracts.diamond.address).toBeTruthy();
    expect(body.extended.contracts.mor_token).toBeTruthy();
    expect(typeof body.extended.eventCursorBlock).toBe('number');
  });
});
