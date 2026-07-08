import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Only Playwright browser specs. Vitest unit tests live in tests/unit/*.test.ts
  // and must not be collected here.
  testMatch: '**/*.spec.ts',
  timeout: 30000,
  use: {
    baseURL: process.env.MORSCAN_URL || 'http://localhost:8788',
  },
});
