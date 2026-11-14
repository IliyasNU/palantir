import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

export default defineConfig({
  ...base,
  testMatch: 'live-isolation.spec.mjs',
  metadata: { isolationRegression: true },
  outputDir: './test-results/isolation',
  webServer: undefined,
  timeout: 90000,
});
