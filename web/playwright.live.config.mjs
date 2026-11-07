import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';
import { liveApiUrl } from './tests/browser/live-api.mjs';

const preview = process.env.BILETFLOW_PRODUCTION_PREVIEW === '1';
export default defineConfig({
  ...base,
  testMatch: ['auth.spec.mjs', 'tickets.live.spec.mjs', 'acceptance-667.live.spec.mjs'],
  grep: /(live local API:|real visitor claims|667 live:)/,
  outputDir: `./test-results/live-${preview ? 'production' : 'dev'}`,
  use: { ...base.use, viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Qyzylorda' },
  webServer: {
    ...base.webServer,
    command: preview ? 'npm run preview' : 'npm run dev',
    reuseExistingServer: false,
    env: { VITE_API_URL: liveApiUrl() },
  },
});
