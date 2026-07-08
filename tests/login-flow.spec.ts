// Sign-in flow E2E - MorScan
// The console is the single sign-in door: /login 302s there, wallet connect is
// the primary, and a secondary expander accepts an existing mor_ key.
//
// Run: MORSCAN_URL=https://staging.morscan.io MORSCAN_DEMO_KEY=mor_... npx playwright test tests/login-flow.spec.ts

import { test, expect } from '@playwright/test';

const BASE = process.env.MORSCAN_URL || 'http://localhost:8788';
// Local-dev default; override with MORSCAN_DEMO_KEY to run against a deployed instance.
const DEMO_KEY = process.env.MORSCAN_DEMO_KEY || 'mor_testkey000000000000000000000000';

test('GET /login redirects to /console (return preserved)', async ({ request }) => {
  const r1 = await request.get(`${BASE}/login`, { maxRedirects: 0 });
  expect(r1.status()).toBe(302);
  expect(r1.headers()['location']).toBe('/console');

  const r2 = await request.get(`${BASE}/login?return=/holders`, { maxRedirects: 0 });
  expect(r2.status()).toBe(302);
  expect(r2.headers()['location']).toBe('/console?return=%2Fholders');
});

test('console is wallet-first with a secondary key sign-in', async ({ page }) => {
  await page.goto(`${BASE}/console`);
  await expect(page.locator('#connect-btn')).toBeVisible();
  // Secondary key sign-in starts collapsed, expands on toggle
  await expect(page.locator('#key-signin')).toBeHidden();
  await page.click('#key-toggle');
  await expect(page.locator('#signin-key')).toBeVisible();
  // The connect page must not embed the serving key
  const html = await page.content();
  expect(html).not.toContain('window.MORSCAN_API_KEY');
});

test('key sign-in via console → lands on analytics', async ({ page }) => {
  await page.goto(`${BASE}/console?return=/analytics/overview`);
  await page.click('#key-toggle');
  await page.fill('#signin-key', DEMO_KEY);
  await page.click('#signin-btn');
  await page.waitForURL('**/analytics/overview', { timeout: 15000 });
  expect(page.url()).toContain('/analytics/overview');
});

test('chart.svg is publicly accessible', async ({ request }) => {
  const resp = await request.get(`${BASE}/chart.svg`);
  expect(resp.ok()).toBeTruthy();
  expect(resp.headers()['content-type']).toContain('image/svg+xml');
  const body = await resp.text();
  expect(body).toContain('<svg');
});

test('console connect page shows the market widget', async ({ page }) => {
  await page.goto(`${BASE}/console`);
  await expect(page.locator('#mkt-widget')).toBeVisible();
  await expect(page.locator('#t-providers')).not.toHaveText('-', { timeout: 8000 });
});
