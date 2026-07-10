import {
  test as base,
  chromium,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/**
 * CDP endpoint of the Chrome instance launched by `npm run chrome`
 * (or by the dashboard's "Start Chrome" button).
 */
const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://localhost:9222';

type WorkerFixtures = {
  /** Browser connected over CDP, shared across the whole worker. */
  cdpBrowser: Browser;
};

/**
 * `test` attaches to an already-running Chrome over CDP instead of launching
 * a fresh browser. It reuses the browser's existing default context and its
 * first page, so tests drive the real, visible Chrome window.
 */
export const test = base.extend<{}, WorkerFixtures>({
  cdpBrowser: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
      await use(browser);
      // Disconnect only — do NOT close the Chrome the dashboard manages.
      await browser.close();
    },
    { scope: 'worker' },
  ],

  context: async ({ cdpBrowser }, use) => {
    const context: BrowserContext =
      cdpBrowser.contexts()[0] ?? (await cdpBrowser.newContext());
    await use(context);
    // Leave the context open; it belongs to the persistent CDP browser.
  },

  page: async ({ context }, use) => {
    const page: Page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

export { expect };
