# Standard Testing Prompt — Playwright MCP via CDP

> Use this prompt every time test cases are shared. It applies to this project
> (Playwright-over-CDP with a dashboard and Playwright MCP wired to CDP).

## Prompt

You are automating test cases with **Playwright MCP via CDP** against the Chrome
that is running with remote debugging at `http://localhost:9222`. Follow this
workflow for every test case I share:

1. **Ensure the CDP browser is up.** If nothing is listening on `:9222`, start it
   (`npm run chrome` or the dashboard's *Start Chrome* button). All automation
   attaches to that one Chrome over CDP — never launch a separate browser.

2. **Inspect the real page first — never guess locators.** Use the Playwright MCP
   (or a CDP inspection) to open the target page and read the *actual* DOM:
   input `id`/`name`/`placeholder`, button text, roles, and the *real*
   validation/error/toast messages (trigger them by interacting). Do not invent
   selectors or message text.

3. **Write the test in TypeScript** under `tests/`, importing the CDP fixture:
   `import { test, expect } from './fixtures';`. Prefer robust, accessible
   locators: `getByRole`, `getByLabel`, `getByPlaceholder`, then `#id`, and CSS
   only as a last resort.

4. **Use credentials from `.env`, never hardcode secrets.** Read
   `process.env.DIRO_VALID_EMAIL` / `process.env.DIRO_VALID_PASSWORD` (already set
   in the git-ignored `.env`). Skip credential-dependent tests when they are
   absent instead of failing.

5. **Run the test cases correctly.** Execute `npx playwright test <file>` (or run
   them from the dashboard). Confirm they actually exercise the intended flow.

6. **For every FAILED test case, share the screenshot.** Playwright is configured
   with `screenshot: 'only-on-failure'`, so a failure saves
   `test-results/<test>/test-failed-*.png`. Open and show that screenshot, and
   quote the failing assertion/error.

7. **Fix and re-run until correct.** If a failure is caused by a wrong assumption
   (locator, message text, timing), re-inspect the live page, correct the
   locator/assertion, and run again. Report a final pass/fail summary.

**Run testcases correctly and share screenshot for failed testcase.**

## Notes

- Some pages have reCAPTCHA; automated submits may be challenged. If a real login
  is blocked, reuse a logged-in Chrome profile rather than forcing it.
- Keep secrets out of committed files — only in `.env`.
