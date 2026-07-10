# Playwright CDP Automation

Playwright test project that runs **over CDP** (Chrome DevTools Protocol) against
a real, visible Chrome, plus a **web dashboard** to control the test flow and a
**Playwright MCP** wired through the same CDP endpoint.

Tests never launch their own browser — they attach to a Chrome you start with a
remote debugging port. The dashboard, the test runner, and the MCP all talk to
that one browser at `http://localhost:9222`.

```
┌─────────────┐     ┌──────────────────┐
│  Dashboard  │────▶│  Chrome (CDP)    │◀──── Playwright MCP (--cdp-endpoint)
│ :4000       │     │  :9222           │
└─────┬───────┘     └────────▲─────────┘
      │  spawns              │ connectOverCDP
      ▼                      │
  playwright test ───────────┘
```

## Prerequisites

- Node.js 18+ (tested on v24)
- Google Chrome or Microsoft Edge installed
- Dependencies installed: `npm install` and `npx playwright install chromium`

## Quick start

```bash
# 1. Start Chrome with the debugging port (dedicated profile)
npm run chrome

# 2. Run the tests over CDP
npm test

# 3. …or open the dashboard and drive everything from the browser
npm run dashboard         # → http://localhost:4000
```

## The dashboard (`npm run dashboard`)

Open **http://localhost:4000**. From there you can:

- **Start / Stop Chrome** — manage the CDP browser without the terminal.
- **Test Case Registry** — structured (manual/imported) test cases with the full
  schema (ID, Name, Module, Feature, Priority, Steps, Owner, …). Create/edit/delete,
  search + filter, bulk delete, and **Excel import/export**:
  - **⬆ Upload Excel** (`.xlsx`/`.xls`) — validates columns, duplicate IDs, empty
    required fields, and priority/status values; shows progress + an import
    summary (processed / imported / failed with per-row reasons).
  - **⬇ Template** — a formatted starter workbook with dropdowns.
  - **⬇ Export** — the current (optionally filtered) registry as xlsx.
- **Automated Specs panel** — browses the `tests/` folder; click a file to run it, or
  a single test case to run just that one.
- **Results panel** — history of past runs (persisted to
  `dashboard/run-results.json`); pick a run, click any test case by name to see
  its status, error, and failure screenshot. **Download Bug Report** and
  **Download Test Results** export formatted xlsx (bugs are auto-raised for
  failed tests; results honor the selected run).
- **Run / Run all / Stop** — trigger runs (all, by spec file, or by `--grep`
  title filter) and cancel an in-progress run.
- **Live status** — a per-test grid updates in real time (pending → running →
  passed/failed) with durations and first-line errors.
- **Live logs** — streamed stdout/stderr from the run.
- **Open HTML report** — the full Playwright report after any run.

Change the port with `DASHBOARD_PORT=5000 npm run dashboard`.

## Writing tests

Import `test`/`expect` from the CDP fixture instead of `@playwright/test`:

```ts
import { test, expect } from './fixtures';

test('my case', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example/);
});
```

The fixture (`tests/fixtures.ts`) connects over CDP, reuses Chrome's existing
context + first tab, and disconnects at the end **without killing** your Chrome,
so the same browser (and its logged-in session) survives across runs.

## Playwright MCP over CDP

`.mcp.json` registers a Playwright MCP server pointed at the same endpoint:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9222"]
    }
  }
}
```

Start Chrome first (`npm run chrome`), then open this folder in Claude Code /
your MCP client and approve the `playwright` server. The MCP will drive the very
same Chrome the tests use.

## Gemini (Google AI Studio) integration

The dashboard has an AI panel powered by Gemini. It uses your Google AI Studio
key via the REST API — no extra npm dependencies.

### Setup

1. Get a key at https://aistudio.google.com/apikey
2. Copy the template and paste your key:

   ```bash
   cp .env.example .env
   # then edit .env:  GEMINI_API_KEY=your_key_here
   ```

3. Restart the dashboard (`npm run dashboard`). The panel's status dot turns
   green and shows the model (`gemini-2.5-flash` by default).

> `.env` is git-ignored — the key never gets committed. Never paste the key
> into a chat or terminal history; only put it in `.env`.

### What the AI panel does

- **Control browser** — type a plain-English command
  ("go to playwright.dev and click Get started"). Gemini produces a step plan;
  the server executes it against the CDP Chrome and streams each step's
  pass/fail into the panel.
- **Generate test** — describe a scenario; Gemini writes a Playwright spec that
  imports the CDP `./fixtures`. Review the code and **Save to tests/**, then run
  it from the Run panel.
- **Explain failures (self-heal)** — after a run, failed tests get a
  **🩹 Explain** button that sends the error to Gemini for a likely cause and a
  concrete fix suggestion.

Change the model with `GEMINI_MODEL=gemini-2.5-pro` in `.env`.

## Jira integration (Jira Cloud)

Pull a story from Jira and let Gemini turn its description/acceptance criteria
into test cases in the registry — then run them and let failures become bugs.

### Setup
1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens
2. In `.env` set:
   ```
   JIRA_BASE_URL=https://your-org.atlassian.net
   JIRA_EMAIL=you@your-org.com
   JIRA_API_TOKEN=your_token_here
   ```
3. Restart the dashboard. The **🔗 Jira** panel (Test Cases section) turns green.

### Use
- Enter a story key (e.g. `PROJ-123`) → **🔍 Fetch story** to preview it.
- **✨ Generate test cases** → Gemini derives positive/negative/edge/validation
  cases from the story into the registry, each tagged with the story key
  (IDs like `PROJ-123-TC-1`).
- Run them from the registry/specs; failures are auto-raised as bugs and can be
  exported via **Download Bug Report**.

> The token stays in the git-ignored `.env`; nothing is written back to Jira.

## Configuration

| Env var          | Default                 | Purpose                                  |
| ---------------- | ----------------------- | ---------------------------------------- |
| `CDP_ENDPOINT`   | `http://localhost:9222` | Where tests/MCP attach                   |
| `CDP_PORT`       | `9222`                  | Debug port Chrome launches on            |
| `CHROME_PATH`    | auto-detected           | Override the browser executable          |
| `DASHBOARD_PORT` | `4000`                  | Dashboard server port                    |
| `GEMINI_API_KEY` | —                       | Google AI Studio key (set in `.env`)     |
| `GEMINI_MODEL`   | `gemini-2.5-flash`      | Gemini model for the AI panel            |
| `JIRA_BASE_URL`  | —                       | Jira Cloud URL, e.g. `https://x.atlassian.net` |
| `JIRA_EMAIL`     | —                       | Jira account email (Basic auth)          |
| `JIRA_API_TOKEN` | —                       | Jira API token (set in `.env`)           |

## Project layout

```
playwright.config.ts        Playwright config (list + html + json reporters)
tests/fixtures.ts           CDP fixture — attaches over connectOverCDP
tests/example.spec.ts       Sample tests (replace with your own)
scripts/launch-chrome.mjs   Launch Chrome with --remote-debugging-port
scripts/stop-chrome.mjs     Stop the CDP Chrome
scripts/chrome-utils.mjs    Shared Chrome path / port / status helpers
dashboard/server.mjs        Express + WebSocket control server (+ AI endpoints)
dashboard/ws-reporter.ts    Custom reporter → live status events
dashboard/gemini.mjs        Gemini (Google AI Studio) REST client
dashboard/browser-control.mjs  NL command → Playwright step plan over CDP
dashboard/public/index.html Dashboard UI (incl. Gemini panel)
.mcp.json                   Playwright MCP wired through CDP
.env.example                Template for GEMINI_API_KEY
```

## Troubleshooting

- **`connectOverCDP` fails / tests can't find the browser** — Chrome isn't
  running with the debug port. Run `npm run chrome` (or click *Start Chrome*).
- **Port 9222 already in use / flag ignored** — a normal Chrome is already open.
  This project uses a dedicated `--user-data-dir` (`.chrome-cdp-profile/`) to
  avoid that; if it still conflicts, `npm run chrome:stop` then start again.
- **Nothing happens when Chrome is already open normally** — Chrome only honors
  `--remote-debugging-port` when launched with a fresh/dedicated profile, which
  the launch script handles for you.
