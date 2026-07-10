---
description: Automate shared test cases with Playwright MCP via CDP (inspect → write → run → screenshot failures)
---

You are automating test cases with **Playwright MCP via CDP** against the Chrome
running with remote debugging at `http://localhost:9222`. Follow this workflow
for the test case(s) below.

Test case(s) to implement:
$ARGUMENTS

Workflow:
1. Ensure the CDP browser is up on `:9222` (start with `npm run chrome` if not).
   Attach over CDP — never launch a separate browser.
2. Inspect the real target page first via the Playwright MCP — never guess.
   Read actual input ids/placeholders, button text/roles, and the real
   validation/error/toast messages (trigger them by interacting).
3. Write the test in TypeScript under `tests/`, importing the CDP fixture:
   `import { test, expect } from './fixtures';`. Prefer getByRole/getByLabel/
   getByPlaceholder/#id over CSS.
4. Use credentials from `.env` (`process.env.DIRO_VALID_EMAIL` /
   `DIRO_VALID_PASSWORD`) — never hardcode secrets; skip if absent.
5. Run the tests: `npx playwright test <file>` (or via the dashboard). Confirm
   they exercise the intended flow.
6. For every FAILED test case, open and SHARE the failure screenshot from
   `test-results/<test>/test-failed-*.png`, and quote the failing assertion.
7. If a failure is due to a wrong assumption, re-inspect the live page, fix the
   locator/assertion, and re-run until correct. End with a pass/fail summary.

**Run testcases correctly and share screenshot for failed testcase.**
