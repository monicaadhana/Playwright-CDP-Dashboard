import { defineConfig } from '@playwright/test';

// Load secrets/credentials (GEMINI_API_KEY, DIRO_VALID_*) from .env so both the
// CLI (`npx playwright test`) and the dashboard pick them up. Node 20.12+/24.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env — env vars may still come from the shell */
}

/**
 * Playwright config for running tests over CDP.
 *
 * Tests do NOT launch their own browser. Instead the CDP fixture in
 * `tests/fixtures.ts` attaches to a Chrome instance that is already running
 * with `--remote-debugging-port` (see `npm run chrome`). The endpoint is read
 * from CDP_ENDPOINT and defaults to http://localhost:9222.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A single worker keeps all tests on the one shared CDP browser.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
