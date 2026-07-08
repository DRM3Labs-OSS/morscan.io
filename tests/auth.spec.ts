// JWT auth integration tests - MorScan
// Verifies: login, logout, UI gating, API key gating, session cookie
//
// Run: MORSCAN_URL=https://staging.morscan.io npx playwright test tests/auth.spec.ts

import { test, expect } from '@playwright/test';

const BASE = process.env.MORSCAN_URL || 'http://localhost:8788';
// Local-dev default; override with MORSCAN_DEMO_KEY to run against a deployed instance.
const DEMO_KEY = process.env.MORSCAN_DEMO_KEY || 'mor_testkey000000000000000000000000';

test.describe('Auth: Public routes', () => {
  test('health is public', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`);
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.status).toBe('ok');
  });

  test('teaser is public', async ({ request }) => {
    const resp = await request.get(`${BASE}/teaser`);
    expect(resp.ok()).toBeTruthy();
  });

  test('/api/playground is public (open access since 1.8.0)', async ({ request }) => {
    const resp = await request.get(`${BASE}/api/playground`, { maxRedirects: 0 });
    expect(resp.status()).toBe(200);
  });

  test('/chart.svg is public', async ({ request }) => {
    const resp = await request.get(`${BASE}/chart.svg`);
    expect(resp.ok()).toBeTruthy();
    expect(resp.headers()['content-type']).toContain('image/svg+xml');
  });

  test('/mor/v1/price is public (no auth required)', async ({ request }) => {
    const resp = await request.get(`${BASE}/mor/v1/price`);
    expect([200, 503]).toContain(resp.status());
  });
});

test.describe('Auth: open-access UI (since 1.8.0)', () => {
  // The read-only explorer no longer requires sign-in; these pages serve 200
  // without a session. /login remains for the API console.
  for (const path of ['/', '/compute/consumers', '/compute/providers', '/compute/network']) {
    test(`${path} is public without session`, async ({ request }) => {
      const resp = await request.get(`${BASE}${path}`, { maxRedirects: 0 });
      expect(resp.status()).toBe(200);
    });
  }
});

test.describe('Nav: legacy URLs 301 to canonical', () => {
  const MAP: Record<string, string> = {
    '/analytics': '/analytics/overview',
    '/analytics-tab': '/analytics/overview',
    '/compute': '/compute/network',
    '/network': '/compute/network',
    '/providers': '/compute/providers',
    '/consumers': '/compute/consumers',
    '/providers/0x63da1c6b40cc9d7dcdac9a19f1a818443f452139': '/compute/providers/0x63da1c6b40cc9d7dcdac9a19f1a818443f452139',
    '/consumers/wallet/0xd03a93c91609038e1e50a8c1256a78eaee70d7c8': '/compute/consumers/wallet/0xd03a93c91609038e1e50a8c1256a78eaee70d7c8',
    '/holders': '/holders/all',
    '/builder': '/builder/subnets',
    '/builder/calc': '/builder/calculator',
    '/api': '/api/playground',
  };
  for (const [legacy, canonical] of Object.entries(MAP)) {
    test(`${legacy} -> ${canonical}`, async ({ request }) => {
      const resp = await request.get(`${BASE}${legacy}`, { maxRedirects: 0 });
      expect(resp.status()).toBe(301);
      expect(resp.headers()['location']).toBe(canonical);
    });
  }
});

test.describe('Auth: API key gating', () => {
  test('/mor/v1/all returns 401 without key', async ({ request }) => {
    const resp = await request.get(`${BASE}/mor/v1/all`);
    expect(resp.status()).toBe(401);
  });

  test('/mor/v1/all works with the serving key', async ({ request }) => {
    const resp = await request.get(`${BASE}/mor/v1/all`, {
      headers: { 'X-Morscan-Key': DEMO_KEY },
    });
    expect(resp.ok()).toBeTruthy();
  });

  test('/mor/v1/providers works with Bearer auth', async ({ request }) => {
    const resp = await request.get(`${BASE}/mor/v1/providers`, {
      headers: { 'Authorization': `Bearer ${DEMO_KEY}` },
    });
    expect(resp.ok()).toBeTruthy();
  });

  test('invalid key returns 401', async ({ request }) => {
    const resp = await request.get(`${BASE}/mor/v1/all`, {
      headers: { 'X-Morscan-Key': 'mor_invalid_key_that_does_not_exist' },
    });
    expect(resp.status()).toBe(401);
  });
});

test.describe('Auth: JWT login flow', () => {
  test('POST /login with valid key returns JWT cookie', async ({ request }) => {
    const resp = await request.post(`${BASE}/login`, {
      data: { key: DEMO_KEY, return: '/compute/consumers' },
    });
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.ok).toBeTruthy();
    expect(body.redirect).toBe('/compute/consumers');

    const setCookie = resp.headers()['set-cookie'];
    expect(setCookie).toContain('morscan_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
  });

  test('POST /login with invalid key returns 401', async ({ request }) => {
    const resp = await request.post(`${BASE}/login`, {
      data: { key: 'mor_wrong_key_wrong_key_wrong_key' },
    });
    expect(resp.status()).toBe(401);
  });

  test('POST /login with missing key returns 400', async ({ request }) => {
    const resp = await request.post(`${BASE}/login`, {
      data: {},
    });
    expect(resp.status()).toBe(400);
  });

  test('UI accessible with valid session cookie', async ({ request }) => {
    const loginResp = await request.post(`${BASE}/login`, {
      data: { key: DEMO_KEY },
    });
    const setCookie = loginResp.headers()['set-cookie'];
    const sessionToken = setCookie.match(/morscan_session=([^;]+)/)?.[1];
    expect(sessionToken).toBeTruthy();

    // / serves the landing directly (open access since 1.8.0)
    const resp = await request.get(`${BASE}/`, {
      headers: { 'Cookie': `morscan_session=${sessionToken}` },
      maxRedirects: 0,
    });
    expect(resp.status()).toBe(200);

    // /compute/providers serves 200
    const provResp = await request.get(`${BASE}/compute/providers`, {
      headers: { 'Cookie': `morscan_session=${sessionToken}` },
    });
    expect(provResp.status()).toBe(200);

    // /compute/network serves 200
    const netResp = await request.get(`${BASE}/compute/network`, {
      headers: { 'Cookie': `morscan_session=${sessionToken}` },
    });
    expect(netResp.status()).toBe(200);
  });

  test('GET /login with valid session redirects to analytics', async ({ request }) => {
    const loginResp = await request.post(`${BASE}/login`, {
      data: { key: DEMO_KEY },
    });
    const setCookie = loginResp.headers()['set-cookie'];
    const sessionToken = setCookie.match(/morscan_session=([^;]+)/)?.[1];

    const resp = await request.get(`${BASE}/login`, {
      headers: { 'Cookie': `morscan_session=${sessionToken}` },
      maxRedirects: 0,
    });
    expect(resp.status()).toBe(302);
    expect(resp.headers()['location']).toBe('/analytics/overview');
  });

  test('GET /login?return=/compute/consumers redirects to /compute/consumers', async ({ request }) => {
    const loginResp = await request.post(`${BASE}/login`, {
      data: { key: DEMO_KEY },
    });
    const setCookie = loginResp.headers()['set-cookie'];
    const sessionToken = setCookie.match(/morscan_session=([^;]+)/)?.[1];

    const resp = await request.get(`${BASE}/login?return=/compute/consumers`, {
      headers: { 'Cookie': `morscan_session=${sessionToken}` },
      maxRedirects: 0,
    });
    expect(resp.status()).toBe(302);
    expect(resp.headers()['location']).toBe('/compute/consumers');
  });
});

test.describe('Auth: Logout', () => {
  test('GET /logout clears session and redirects to /console', async ({ request }) => {
    const loginResp = await request.post(`${BASE}/login`, {
      data: { key: DEMO_KEY },
    });
    const setCookie = loginResp.headers()['set-cookie'];
    const sessionToken = setCookie.match(/morscan_session=([^;]+)/)?.[1];

    const resp = await request.get(`${BASE}/logout`, {
      headers: { 'Cookie': `morscan_session=${sessionToken}` },
      maxRedirects: 0,
    });
    expect(resp.status()).toBe(302);
    expect(resp.headers()['location']).toBe('/console');
    expect(resp.headers()['set-cookie']).toContain('Max-Age=0');
  });

  test('after logout, read-only UI stays public', async ({ request }) => {
    const resp = await request.get(`${BASE}/`, { maxRedirects: 0 });
    expect(resp.status()).toBe(200);
  });
});
