import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';
import { randomUUID } from 'node:crypto';
import { liveApiUrl } from './tests/browser/live-api.mjs';

const preview = process.env.BILETFLOW_PRODUCTION_PREVIEW === '1';
const runId = process.env.BILETFLOW_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid live run ID');
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  ...base,
  testMatch: ['auth.spec.mjs', 'tickets.live.spec.mjs', 'acceptance-667.live.spec.mjs'],
  grep: /(live local API:|real visitor claims|667 live:)/,
  outputDir: `./test-results/live/${preview ? 'production' : 'dev'}-${runId}`,
  metadata: { liveMode: preview ? 'production preview' : 'dev' },
  use: { ...base.use, serviceWorkers: 'block', viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Qyzylorda' },
  webServer: {
    ...base.webServer,
    command: 'node scripts/live-web-server.mjs',
    reuseExistingServer: false,
    env: { VITE_API_URL: liveApiUrl() },
  },
});
