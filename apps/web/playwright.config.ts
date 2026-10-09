import { defineConfig } from '@playwright/test';

/**
 * E2E against the real stack: Next production build (BFF) -> real Nest API -> real PostgreSQL
 * (dedicated hypersender_e2e_test DB) -> real gateway worker with a FAKE WhatsApp socket.
 * Playwright starts both servers itself and stops exactly the processes it started.
 *   npm run build && npm run e2e
 */
const API = process.env.E2E_API_PORT ?? '3101';
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/.results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3200',
    channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'npx tsx test/e2e/stack.ts', cwd: '../..', url: 'http://127.0.0.1:3102/health', timeout: 180_000, reuseExistingServer: false, stdout: 'ignore', stderr: 'pipe' },
    { command: 'npx next start -p 3200', url: 'http://localhost:3200/login', timeout: 60_000, reuseExistingServer: false,
      env: { HS_API_URL: `http://127.0.0.1:${API}` } },
  ],
});
