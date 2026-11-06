import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  outputDir: './test-results',
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    env: { VITE_API_URL: 'http://localhost:8000' },
  },
});
