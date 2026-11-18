import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

// Run after building with VITE_API_URL=http://localhost:8000.
// HTTP fixtures are test-only; no backend records are created.
export default defineConfig({
  ...base,
  testMatch: 'acceptance-667.spec.mjs',
  webServer: {
    ...base.webServer,
    command: 'npm run preview',
    reuseExistingServer: false,
  },
});
