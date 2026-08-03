// Execute a Gemini-produced step plan against the CDP Chrome using Playwright.
import { chromium } from '@playwright/test';
import { createWorker } from 'tesseract.js';
import { generateJSON } from './gemini.mjs';
import { CDP_ENDPOINT } from '../scripts/chrome-utils.mjs';

/** The action vocabulary Gemini is allowed to emit. Kept small and safe. */
const SYSTEM = `You convert a natural-language browser instruction into a JSON plan
that a Playwright automation runner will execute against an already-open Chrome page.

Return ONLY JSON of the form: {"steps":[ ... ]} — no prose, no markdown.

Each step is one of:
  {"action":"goto","url":"https://..."}
  {"action":"click","locator":<LOC>}
  {"action":"fill","locator":<LOC>,"text":"..."}
  {"action":"press","key":"Enter","locator":<LOC optional>}
  {"action":"waitFor","locator":<LOC>}
  {"action":"expectVisible","locator":<LOC>}
  {"action":"expectText","locator":<LOC>,"text":"substring"}
  {"action":"screenshot"}

<LOC> is a locator object, preferring accessible/semantic ones:
  {"by":"role","role":"button","name":"Sign in"}   (role: button|link|textbox|heading|checkbox|tab|...)
  {"by":"text","text":"Welcome"}
  {"by":"label","text":"Email"}
  {"by":"placeholder","text":"Search"}
  {"by":"testId","text":"submit"}
  {"by":"css","selector":".btn-primary"}   (last resort)

Prefer role/label/text locators over css. Add explicit goto steps when a URL is implied.
Keep the plan minimal and ordered.

CRITICAL interaction rules (the target app has custom widgets and hidden helper elements):
- Target only VISIBLE, meaningful elements. Never rely on a bare
  {"by":"role","role":"textbox"} when a screen has multiple inputs — prefer a placeholder,
  label, or the option's visible text. Ignore hidden helper inputs.
- Dropdowns / searchable pickers (country selector, bank selector, comboboxes, "select2"
  widgets) are NOT a single textbox. To pick a value, emit THREE steps:
  (1) click the picker/control to open it,
  (2) fill the search box that appears with the value,
  (3) click the matching option by its exact visible text (e.g. {"by":"text","text":"Trinidad and Tobago"}).
- To choose an item from a list of results, click it by its visible text.
- After any step that changes the screen (navigation, opening/closing a pop-up), add a
  waitFor or expectVisible on distinctive text of the NEW screen before the next action.`;

/** Ask Gemini to turn a command into a step plan. */
export async function planFromCommand(command, currentUrl) {
  const context = currentUrl ? `\n\nThe page is currently at: ${currentUrl}` : '';
  const data = await generateJSON(`Instruction: ${command}${context}`, { system: SYSTEM });
  const steps = Array.isArray(data) ? data : data.steps;
  if (!Array.isArray(steps)) throw new Error('Gemini plan had no "steps" array.');
  return steps;
}

/** Turn a structured (manual) test case into an executable plan, using its Test Data. */
export async function planFromTestCase(tc, baseUrl, context) {
  const prompt =
    `Convert this manual test case into an executable browser plan. Use the Test Data ` +
    `values wherever a step needs an input (e.g. email/password/search text). If a base ` +
    `URL is given and no step navigates, start with a goto.\n\n` +
    (context ? `Shared context for this run (flow, credentials, test data — apply where relevant):\n${context}\n\n` : '') +
    `Name: ${tc['Test Case Name'] || ''}\n` +
    `Test Scenario: ${tc['Test Scenario'] || '(none)'}\n` +
    `Preconditions: ${tc.Preconditions || '(none)'}\n` +
    `Steps:\n${tc['Test Steps'] || '(none)'}\n` +
    `Test Data: ${tc['Test Data'] || '(none)'}\n` +
    `Expected Result: ${tc['Expected Result'] || '(none)'}` +
    (baseUrl ? `\nBase URL: ${baseUrl}` : '');
  const data = await generateJSON(prompt, { system: SYSTEM });
  const steps = Array.isArray(data) ? data : data.steps;
  if (!Array.isArray(steps)) throw new Error('Gemini plan had no "steps" array.');
  return steps;
}

function resolveLocator(page, loc) {
  if (!loc || typeof loc !== 'object') throw new Error('Missing locator');
  switch (loc.by) {
    case 'role':
      return page.getByRole(loc.role, loc.name ? { name: loc.name } : undefined);
    case 'text':
      return page.getByText(loc.text);
    case 'label':
      return page.getByLabel(loc.text);
    case 'placeholder':
      return page.getByPlaceholder(loc.text);
    case 'testId':
      return page.getByTestId(loc.text);
    case 'css':
      return page.locator(loc.selector);
    default:
      throw new Error(`Unknown locator type: ${loc.by}`);
  }
}

function describe(step) {
  const l = step.locator;
  const loc = l ? ` [${l.by}: ${l.name || l.text || l.selector || l.role || ''}]` : '';
  switch (step.action) {
    case 'goto': return `goto ${step.url}`;
    case 'fill': return `fill${loc} = "${step.text}"`;
    case 'press': return `press ${step.key}${loc}`;
    case 'expectText': return `expect text "${step.text}"${loc}`;
    default: return `${step.action}${loc}`;
  }
}

/**
 * Connect to the CDP Chrome, run each step, and report progress via onStep().
 * @param {Array} steps
 * @param {(update: {index:number,total:number,text:string,status:string,error?:string}) => void} onStep
 */
/**
 * Open ONE CDP connection and return its browser + first page, with a persistent
 * dialog auto-accept handler attached. Reuse this across many runPlan() calls so a
 * whole group run shares a single connection — reconnecting per test deadlocks when
 * a flow (e.g. DIRO capture) leaves a native dialog open, because the dismiss handler
 * can only attach AFTER connectOverCDP, which the open dialog itself blocks.
 */
export async function connectPage() {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront().catch(() => {});
  // Some flows raise a native beforeunload/confirm dialog on close/navigate — dismiss
  // it (stay on page) so it doesn't stall the run or block the next connect.
  page.on('dialog', (d) => d.accept().catch(() => {}));
  // Document clicks in the DIRO capture trigger file downloads; consume the event so
  // Playwright handles it (to a temp file) instead of leaving it pending. DIRO captures
  // the document server-side, so we don't need the downloaded file itself.
  page.on('download', () => {});
  return { browser, page };
}

export async function runPlan(steps, onStep, opts = {}) {
  const { shotDir = null, shotUrlBase = null, preamble = null, skipGoto = false, page: externalPage = null } = opts;
  // Reuse a caller-provided page (shared connection) when given; otherwise open our
  // own connection for this single plan and close it in `finally`.
  const session = externalPage ? null : await connectPage();
  const page = externalPage ?? session.page;
  try {

    // Deterministic setup preamble: reliably reach the target screen before the
    // AI-planned case steps run (no locator guessing for navigation).
    if (preamble && preamble.text) {
      try {
        await execPreamble(page, parsePreamble(preamble.text), preamble.baseUrl, onStep);
      } catch (err) {
        onStep({ index: -1, total: steps.length, text: 'setup: reach screen', status: 'failed', error: err.message });
        return { url: page.url(), results: [{ text: 'setup: reach screen', status: 'failed', error: 'Setup failed: ' + err.message, duration: 0 }] };
      }
    }

    // Capture a screenshot of the current step; returns a servable URL or null.
    const capture = async (i) => {
      if (!shotDir) return null;
      try {
        const file = `${shotDir}/step-${i + 1}.png`;
        await page.screenshot({ path: file });
        return shotUrlBase ? `${shotUrlBase}/step-${i + 1}.png` : file;
      } catch {
        return null;
      }
    };

    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (skipGoto && step.action === 'goto') continue; // already navigated by preamble
      const text = describe(step);
      onStep({ index: i, total: steps.length, text, status: 'running' });
      const started = Date.now();
      try {
        await execStepWithRetry(page, step, onStep, { index: i, total: steps.length, text });
        const shot = await capture(i);
        onStep({ index: i, total: steps.length, text, status: 'passed', shot });
        results.push({ text, status: 'passed', shot, duration: Date.now() - started });
      } catch (err) {
        const shot = await capture(i);
        onStep({ index: i, total: steps.length, text, status: 'failed', error: err.message, shot });
        results.push({ text, status: 'failed', error: err.message, shot, duration: Date.now() - started });
        break; // stop the plan on first failure
      }
    }
    return { url: page.url(), results };
  } finally {
    // Only close a connection we opened here; a shared (external) page is closed by
    // its owner (the group run) after all cases finish. Disconnect leaves Chrome up.
    if (session) await session.browser.close();
  }
}

// Apps like DIRO keep hidden helper inputs (e.g. a paste-capture
// <textarea id="targetID" class="target">) that pollute generic role locators and trip
// strict-mode violations. Resolve every action to the FIRST VISIBLE, non-helper match so
// the AI's generic locators land on the real on-screen element instead of a hidden decoy.
// `root` is a Page OR a Frame — both expose the same getByRole/locator API.
const DECOY = ':not(#targetID):not(.target)';
function actionable(root, loc) {
  return resolveLocator(root, loc).filter({ visible: true }).and(root.locator(DECOY)).first();
}

// DIRO embeds the bank / testing99 UI (bank list, document list, download) inside an
// iframe, so main-frame-only locators miss it. Poll EVERY frame up to `timeout` for a
// visible, non-decoy match and return that frame-scoped locator, or null if none appears.
// Total visible-text length across ALL frames — used to detect whether a click had any
// effect. Main-frame-only would miss changes confined to an iframe (DIRO renders the
// bank/document UI in one), causing a real click to be misread as a no-op and re-fired.
async function totalTextLen(page) {
  let total = 0;
  for (const f of page.frames()) {
    total += await f.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
  }
  return total;
}

async function findAcrossFrames(page, loc, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    for (const frame of page.frames()) {
      try {
        const cand = actionable(frame, loc);
        if (await cand.count()) return cand;
      } catch { /* frame navigated/detached mid-search — skip */ }
    }
    if (Date.now() >= end) return null;
    await page.waitForTimeout(400);
  }
}

// ---- OCR fallback for CANVAS-rendered screens ---------------------------------------
// Part of the DIRO capture (the bank/testing99 document list, download UI) is painted on
// an HTML <canvas> — a remote-browser pixel stream with NO DOM. When a target isn't found
// in any frame's DOM, we OCR a screenshot, fuzzy-match the target text, and click the
// pixel. tesseract misreads (e.g. "Utility"->"Utiity"), so matching is fuzzy.
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// min edits to match `pat` against ANY substring of `text` (ignores extra leading/trailing
// text such as a right-column item sharing the same OCR line).
function fuzzySubstr(text, pat) {
  const n = text.length, m = pat.length;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1); cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (pat[i - 1] === text[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(...prev);
}
let _ocrWorker = null;
async function ocrWorker() { if (!_ocrWorker) _ocrWorker = await createWorker('eng'); return _ocrWorker; }
// Human-readable text from a locator spec (for OCR matching); null if it has none (css).
function locatorText(loc) { return (loc && (loc.name || loc.text)) || null; }
// OCR the current viewport (device-scale = readable), fuzzy-find `target`. Returns the
// CSS-pixel click point of the best matching line (left edge), or null if none is close.
async function ocrLocate(page, target) {
  const want = norm(target);
  if (!want) return null;
  const buf = await page.screenshot();
  const imgW = buf.readUInt32BE(16), imgH = buf.readUInt32BE(20);
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const sx = vp.w / imgW, sy = vp.h / imgH;
  const w = await ocrWorker();
  const { data } = await w.recognize(buf, {}, { blocks: true });
  const thresh = Math.max(2, Math.round(want.length * 0.25));
  let best = null, bestD = Infinity;
  for (const bl of data.blocks || []) for (const par of bl.paragraphs || []) for (const ln of par.lines || []) {
    const d = fuzzySubstr(norm(ln.text), want);
    if (d < bestD) { bestD = d; best = ln.bbox; }
  }
  if (!best || bestD > thresh) return null;
  return { x: Math.round((best.x0 + 25) * sx), y: Math.round((best.y0 + best.y1) / 2 * sy) };
}
// Full Levenshtein (for phrase windows bounded near the target length).
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => { const row = new Array(n + 1).fill(0); row[0] = i; return row; });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
// WORD-level OCR locate: fuzzy-match `target` across consecutive words and click the
// matched word run. Unlike ocrLocate (line-level, always left column), this clicks the
// actual word position — so it works for documents in EITHER column of the list.
async function ocrLocatePhrase(page, target) {
  const want = norm(target);
  if (!want) return null;
  const buf = await page.screenshot();
  const imgW = buf.readUInt32BE(16), imgH = buf.readUInt32BE(20);
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const sx = vp.w / imgW, sy = vp.h / imgH;
  const w = await ocrWorker();
  const { data } = await w.recognize(buf, {}, { blocks: true });
  const words = [];
  for (const bl of data.blocks || []) for (const par of bl.paragraphs || []) for (const ln of par.lines || []) for (const wd of ln.words || []) {
    const t = norm(wd.text);
    if (t) words.push({ t, x0: wd.bbox.x0, cy: (wd.bbox.y0 + wd.bbox.y1) / 2 });
  }
  const thresh = Math.max(2, Math.round(want.length * 0.25));
  let best = null, bestD = Infinity;
  for (let i = 0; i < words.length; i++) {
    let concat = '';
    for (let j = i; j < words.length && concat.length <= want.length + 4; j++) {
      concat += words[j].t;
      const d = lev(want, concat);
      if (d < bestD) { bestD = d; best = words[i]; }
    }
  }
  if (!best || bestD > thresh) return null;
  return { x: Math.round((best.x0 + 12) * sx), y: Math.round(best.cy * sy) };
}
// Full OCR text of the viewport (for expectText fallback on canvas screens).
async function ocrText(page) {
  const w = await ocrWorker();
  const { data } = await w.recognize(await page.screenshot());
  return data.text || '';
}

// Retry a step up to 3 times, staying on the same screen and giving the UI time to
// settle (e.g. a button that isn't active/visible yet): try → wait 5s → try → wait 10s
// → try. Navigation (goto) is not retried. Note: retrying only helps when the target is
// slow to appear/activate — it cannot find an element/text that genuinely isn't there.
const RETRY_GAPS_MS = [0, 5000, 10000];
async function execStepWithRetry(page, step, onStep, meta) {
  if (step.action === 'goto') { await execStep(page, step); return; }
  let lastErr;
  for (let attempt = 0; attempt < RETRY_GAPS_MS.length; attempt++) {
    if (RETRY_GAPS_MS[attempt]) {
      if (onStep) onStep({ ...meta, status: 'running', text: `${meta.text} — retry ${attempt} (waited ${RETRY_GAPS_MS[attempt] / 1000}s)` });
      await page.waitForTimeout(RETRY_GAPS_MS[attempt]);
    }
    try {
      await execStep(page, step, attempt === 0 ? 15000 : 8000);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function execStep(page, step, timeout = 15000) {
  switch (step.action) {
    case 'goto':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    case 'click': {
      // Try DOM (across frames) first; if the target has text, cap the DOM wait so we can
      // fall back to OCR (canvas) reasonably fast — execStepWithRetry covers paint timing.
      const text = locatorText(step.locator);
      const el = await findAcrossFrames(page, step.locator, text ? Math.min(timeout, 5000) : timeout);
      const before = await totalTextLen(page); // across all frames (see totalTextLen)
      if (el) {
        // noWaitAfter: a document click can start a file download, which would otherwise
        // hang the click waiting for the page to "settle".
        await el.click({ timeout, noWaitAfter: true });
      } else {
        // Canvas fallback: OCR-locate the text and click the pixel.
        const pt = text && (await ocrLocate(page, text));
        if (!pt) throw new Error('click target not found (DOM or OCR)');
        await page.mouse.click(pt.x, pt.y);
      }
      // Verify the click had an effect: if the control is STILL present AND the page text is
      // unchanged (in any frame), it was a no-op (button not yet wired) — throw so the retry
      // clicks again. A click that advances the screen / starts a download changes the text.
      await page.waitForTimeout(1500);
      const after = await totalTextLen(page);
      const stillThere = el ? await el.isVisible().catch(() => false) : true;
      if (stillThere && before === after) {
        throw new Error('click had no effect (control not active yet) — retrying');
      }
      break;
    }
    case 'fill': {
      const el = await findAcrossFrames(page, step.locator, timeout);
      if (!el) throw new Error('fill target not found in any frame');
      await el.fill(String(step.text ?? ''), { timeout });
      break;
    }
    case 'press':
      if (step.locator) {
        const el = await findAcrossFrames(page, step.locator, timeout);
        if (!el) throw new Error('press target not found in any frame');
        await el.press(step.key, { timeout });
      } else {
        await page.keyboard.press(step.key);
      }
      break;
    case 'waitFor':
    case 'expectVisible': {
      // Present in the DOM (any frame) OR visible on the canvas (OCR). Either satisfies it.
      const text = locatorText(step.locator);
      const el = await findAcrossFrames(page, step.locator, text ? Math.min(timeout, 5000) : timeout);
      if (el) break;
      const pt = text && (await ocrLocate(page, text));
      if (!pt) throw new Error(step.action === 'click' ? 'element not visible' : 'element did not appear (DOM or OCR)');
      break;
    }
    case 'expectText': {
      const el = await findAcrossFrames(page, step.locator, Math.min(timeout, 5000));
      if (el) {
        const content = await el.textContent({ timeout }).catch(() => null);
        if (content && content.includes(step.text)) break;
      }
      // OCR fallback: check the full canvas text contains the expected text (fuzzy).
      const want = norm(step.text);
      const d = fuzzySubstr(norm(await ocrText(page)), want);
      if (d > Math.max(2, Math.round(want.length * 0.25))) {
        throw new Error(`expected text "${step.text}" not found (DOM or OCR)`);
      }
      break;
    }
    case 'screenshot':
      await page.screenshot({ path: `test-results/ai-screenshot-${step.index ?? 0}.png` }).catch(() => {});
      break;
    default:
      throw new Error(`Unknown action: ${step.action}`);
  }
}

// ---- Deterministic setup preamble --------------------------------------------
// A tiny, reliable mini-language to reach a screen before the AI case steps run.
// Verbs (one per line, leading "1." numbering is stripped):
//   goto [url]         navigate (blank or {baseUrl} → the provided base URL)
//   waitText <text>    poll up to 55s until that text is visible
//   clickClose         robustly click the close/✕ icon (top-right)
//   click <text>       click a visible element containing <text>
//   wait <seconds>     fixed pause
export function parsePreamble(text) {
  const out = [];
  for (let raw of String(text || '').split(/\r?\n/)) {
    raw = raw.replace(/^\s*\d+[.)]\s*/, '').trim();
    if (!raw) continue;
    const low = raw.toLowerCase();
    if (/^(goto|go to|open)\b/.test(low)) out.push({ op: 'goto', arg: raw.replace(/^(goto|go to|open)\s*/i, '').trim(), raw });
    else if (/^(waittext|wait text|wait for|waitfor)\b/.test(low)) out.push({ op: 'waittext', arg: raw.replace(/^(waittext|wait text|wait for|waitfor)\s*/i, '').trim(), raw });
    else if (/^(clickclose|click close|close)\b/.test(low)) out.push({ op: 'clickclose', arg: '', raw });
    else if (/^wait\b/.test(low)) out.push({ op: 'wait', arg: raw.replace(/^wait\s*/i, '').trim(), raw });
    else if (/^click\b/.test(low)) out.push({ op: 'click', arg: raw.replace(/^click\s*/i, '').trim(), raw });
    else out.push({ op: 'waittext', arg: raw, raw }); // fallback: treat as a text to wait for
  }
  return out;
}

async function waitForText(page, text, ms = 55000) {
  const needle = String(text).toLowerCase();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      const t = await f.locator('body').innerText().catch(() => '');
      if (t.toLowerCase().includes(needle)) return true;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`timed out waiting for text: "${text}"`);
}

async function clickClose(page) {
  // Only the main frame (the visible modal) — avoid clicking a pre-loaded
  // background iframe's close, which would advance the flow instead.
  const f = page.mainFrame();
  // Exact selector order verified to work manually (no case-insensitive flag —
  // it over-matched and picked the wrong button).
  const selectors = ['button.btn-close', 'button[class*=close]', 'svg.lucide-x', '[class*=close-info]', 'div[class*=close]', '[aria-label*="close" i]', '.close'];
  for (const sel of selectors) {
    const loc = f.locator(sel).first();
    if ((await loc.count().catch(() => 0)) && (await loc.isVisible().catch(() => false))) {
      await loc.click({ force: true, timeout: 8000 });
      return true;
    }
  }
  throw new Error('could not find a close/✕ control');
}

export async function execPreamble(page, steps, baseUrl, onStep) {
  await page.bringToFront().catch(() => {});
  for (const s of steps) {
    if (onStep) onStep({ index: -1, total: 0, text: 'setup: ' + s.raw, status: 'running' });
    if (s.op === 'goto') {
      const url = s.arg && !/\{baseurl\}/i.test(s.arg) ? s.arg : baseUrl;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else if (s.op === 'wait') {
      await page.waitForTimeout((parseFloat(s.arg) || 1) * 1000);
    } else if (s.op === 'waittext') {
      await waitForText(page, s.arg, 55000);
    } else if (s.op === 'clickclose') {
      await clickClose(page);
    } else if (s.op === 'click') {
      let done = false;
      for (const f of page.frames()) {
        const loc = f.getByText(s.arg, { exact: false }).first();
        if ((await loc.count().catch(() => 0)) && (await loc.isVisible().catch(() => false))) { await loc.click({ force: true, timeout: 15000 }); done = true; break; }
      }
      if (!done) throw new Error(`could not click "${s.arg}"`);
    }
    if (onStep) onStep({ index: -1, total: 0, text: 'setup: ' + s.raw, status: 'passed' });
  }
}

// ============================================================================
// Observe→Act agent executor
// ----------------------------------------------------------------------------
// Reads a test case's OWN steps and grounds each action in the LIVE page: at every
// step it snapshots the real interactive elements (across frames) plus OCR text lines
// for canvas screens, and asks the model to pick from what ACTUALLY exists — so it
// never invents locators/labels. No blind pre-planning, no Flow-context needed.
// ============================================================================

const INTERACTIVE = 'button, a, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=textbox], [role=tab], [role=option], [role=checkbox], [role=menuitem], [contenteditable=true], .select2-selection, li';

// OCR every text line on the viewport, returning CSS-pixel click points (for canvas).
async function ocrLines(page) {
  const buf = await page.screenshot();
  const imgW = buf.readUInt32BE(16), imgH = buf.readUInt32BE(20);
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const sx = vp.w / imgW, sy = vp.h / imgH;
  const w = await ocrWorker();
  const { data } = await w.recognize(buf, {}, { blocks: true });
  const out = [];
  for (const bl of data.blocks || []) for (const par of bl.paragraphs || []) for (const ln of par.lines || []) {
    const t = (ln.text || '').replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, x: Math.round((ln.bbox.x0 + 15) * sx), y: Math.round((ln.bbox.y0 + ln.bbox.y1) / 2 * sy) });
  }
  return out;
}

// Snapshot real, visible interactive elements (all frames) + OCR lines when a canvas is present.
async function observe(page) {
  const items = [];
  let n = 0;
  const frames = page.frames();
  for (let fi = 0; fi < frames.length; fi++) {
    let handles = [];
    try { handles = await frames[fi].locator(INTERACTIVE).elementHandles(); } catch { continue; }
    for (const h of handles) {
      const info = await h.evaluate((el) => {
        const rects = el.getClientRects();
        const vis = rects.length > 0 && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
        const name = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 70);
        const map = { A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', LI: 'option' };
        const role = el.getAttribute('role') || map[el.tagName] || el.tagName.toLowerCase();
        const decoy = el.id === 'targetID' || (el.className || '').toString().includes('target');
        return { vis, name, role, decoy };
      }).catch(() => null);
      if (info && info.vis && !info.decoy && (info.name || info.role === 'textbox' || info.role === 'combobox')) {
        items.push({ ref: 'e' + (n++), role: info.role, name: info.name, handle: h });
      } else {
        await h.dispose().catch(() => {}); // drop filtered-out handles so they don't leak
      }
    }
  }
  if (await page.locator('canvas').count().catch(() => 0)) {
    try { for (const ln of await ocrLines(page)) items.push({ ref: 'e' + (n++), role: 'text', name: ln.text, ocr: { x: ln.x, y: ln.y } }); } catch {}
  }
  return items;
}

const serializeObs = (items) => items.map((i) => `${i.ref}: ${i.role} "${i.name}"`).join('\n');

const AGENT_SYSTEM = `You are a browser test agent. You perform ONE step of a manual test case at a time against the CURRENT screen. You get the list of interactive elements currently visible (each with a ref), the step, its test data, and its expected result. Decide the SINGLE next action.

Return ONLY JSON: {"action":"click|fill|press|assertPass|assertFail|done","ref":"e#","value":"...","key":"Enter","reason":"..."}
Rules:
- "ref" MUST be one from the element list. NEVER invent a ref or a label.
- "fill": put the value to type in "value" (use the test data when relevant). "press": set "key".
- Verification steps (verify/observe/check/see): if the expected item is present in the list, return "assertPass"; if it is clearly absent, return "assertFail".
- If the expected item isn't present YET but the screen looks like it is loading/transitioning (a "Please wait", spinner, or a screen that clearly hasn't finished), return "wait" (not assertFail) — you'll be shown the screen again after a short pause. Only assertFail when the screen has settled and the expected item is genuinely missing. Prefer "wait" once or twice before giving up.
- Some steps need several actions (e.g. open a dropdown, type, then click the option). Return them ONE at a time — you'll be called again after each and shown the updated screen.
- DROPDOWNS / comboboxes / "select2" search fields: do NOT fill the container. First CLICK it to open; on the NEXT turn a search textbox appears — fill THAT, then click the matching option from the list.
- If a prior action in the history shows "-> ERROR" (e.g. a fill failed), that target was wrong (e.g. not a text input) — choose a different element or click it first.
- Return "done" when the step is fully performed and needs no more actions.
- If the step appears ALREADY accomplished (its target isn't present because the flow has already moved to the next screen — e.g. a duplicate step, or a "select X" when X was already selected and a later screen is now shown), return "done" — do NOT force a click on a stale/hidden element.
- Prefer the element whose name best matches the step/data (fuzzy is fine; OCR text may be slightly misspelled).`;

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['click', 'fill', 'press', 'wait', 'assertPass', 'assertFail', 'done'] },
    ref: { type: 'string' },
    value: { type: 'string' },
    key: { type: 'string' },
  },
  required: ['action'],
};
async function decideAction(step, obsText, history) {
  const prompt = `Elements on screen:\n${obsText || '(none found)'}\n\nStep: ${step.step}\nTest data: ${step.data || '(none)'}\nExpected result: ${step.expected || '(none)'}\nActions already done for THIS step: ${history || '(none)'}\n\nSingle next action. "ref" must be ONLY an id like "e5" (never words). "value" is only the literal text to type.`;
  // responseSchema keeps output to compact valid JSON. Budget of 2048 leaves room for a
  // Pro model's thinking tokens (thinking counts toward the output budget) while still
  // capping any runaway. The decision JSON itself is tiny.
  const d = await generateJSON(prompt, { system: AGENT_SYSTEM, schema: DECISION_SCHEMA, maxOutputTokens: 2048 });
  if (d && d.ref && !/^e\d+$/.test(String(d.ref).trim())) d.ref = String(d.ref).trim().match(/e\d+/)?.[0] || d.ref; // salvage a clean ref
  return d;
}

async function executeDecision(page, decision, items) {
  const it = items.find((x) => x.ref === decision.ref);
  switch (decision.action) {
    case 'click':
      if (!it) throw new Error(`click: unknown ref ${decision.ref}`);
      if (it.handle) await it.handle.click({ timeout: 8000, noWaitAfter: true });
      else if (it.ocr) await page.mouse.click(it.ocr.x, it.ocr.y);
      break;
    case 'fill': {
      if (!it || !it.handle) throw new Error(`fill: unknown/uneditable ref ${decision.ref}`);
      try {
        await it.handle.fill(String(decision.value ?? ''), { timeout: 8000 });
      } catch (e) {
        // Non-editable target (commonly a dropdown/select2 CONTAINER): deterministically
        // click it to OPEN — the revealed search box gets filled on the next turn. This
        // removes the model's need to know "click before typing" for custom pickers.
        await it.handle.click({ timeout: 5000, noWaitAfter: true }).catch(() => { throw e; });
      }
      break;
    }
    case 'press':
      if (it && it.handle) await it.handle.press(decision.key || 'Enter', { timeout: 15000 });
      else await page.keyboard.press(decision.key || 'Enter');
      break;
    case 'wait':
      await page.waitForTimeout(3500); // let a loading/transition screen settle
      break;
    default:
      break; // no-op
  }
}

/**
 * Execute a manual test case step-by-step via observe->act. `steps` = [{step,data,expected}].
 * baseUrl is used only to open a dynamic/session URL the static case can't contain.
 * Returns { url, results:[{text,status,error,shot,duration}] } — same shape as runPlan.
 */
export async function runCaseAgent(steps, opts = {}) {
  const { baseUrl = '', page: externalPage = null, shotDir = null, shotUrlBase = null, onStep = () => {} } = opts;
  const session = externalPage ? null : await connectPage();
  const page = externalPage ?? session.page;
  const results = [];
  const MAX_ACTIONS = 10;
  try {
    if (baseUrl) { try { await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(3000); } catch {} }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const text = step.step;
      onStep({ index: i, total: steps.length, text, status: 'running' });
      const started = Date.now();
      let status = 'failed', error = 'step did not complete';
      const history = [];
      try {
        for (let a = 0; a < MAX_ACTIONS; a++) {
          // Wait for the screen to populate before deciding — pages/pop-ups render a beat
          // after navigation, and an empty snapshot must not be read as "expected missing".
          let items = await observe(page);
          for (let w = 0; items.length === 0 && w < 5; w++) { await page.waitForTimeout(2000); items = await observe(page); }
          try {
            let decision;
            try { decision = await decideAction(step, serializeObs(items), history.join('; ')); }
            catch (e) { error = 'planner error: ' + e.message; history.push('planner error -> retry'); await page.waitForTimeout(1000); continue; /* transient (e.g. JSON) — retry */ }
            if (decision.action === 'assertPass' || decision.action === 'done') { status = 'passed'; error = null; break; }
            if (decision.action === 'assertFail') { status = 'failed'; error = 'expected not met: ' + (decision.reason || ''); break; }
            let outcome = 'ok';
            try { await executeDecision(page, decision, items); }
            catch (e) { outcome = 'ERROR: ' + (e.message || '').slice(0, 60); error = e.message; /* re-observe next loop */ }
            history.push(`${decision.action}${decision.ref ? ' ' + decision.ref : ''}${decision.value ? ` "${decision.value}"` : ''} -> ${outcome}`);
            await page.waitForTimeout(1500);
          } finally {
            // Release this iteration's element handles (re-observed next loop) so they
            // don't accumulate in the CDP session over a long run.
            for (const it of items) { if (it.handle) await it.handle.dispose().catch(() => {}); }
          }
        }
      } catch (e) { status = 'failed'; error = e.message; }
      let shot = null;
      if (shotDir) { try { const f = `${shotDir}/step-${i + 1}.png`; await page.screenshot({ path: f }); shot = shotUrlBase ? `${shotUrlBase}/step-${i + 1}.png` : f; } catch {} }
      const errWithTrace = status === 'failed' && history.length ? `${error}\n[agent tried: ${history.join(' | ')}]` : error;
      onStep({ index: i, total: steps.length, text, status, error: errWithTrace, shot });
      results.push({ text, status, error: errWithTrace, shot, duration: Date.now() - started });
      if (status === 'failed') break; // stop on first failure (matches runPlan)
    }
    return { url: page.url(), results };
  } finally {
    if (session) await session.browser.close();
  }
}

// ============================================================================
// Deterministic DIRO CP_Positive capture flows
// ----------------------------------------------------------------------------
// Hand-written, reliable drives with real checkpoints — used INSTEAD of the AI executor
// for these critical flows. Run from the dashboard using the Base URL the user typed, so
// no .env access is needed. Return { url, results } like runPlan; registered per case key
// in server.mjs (DETERMINISTIC_FLOWS).
//
// All CP_Positive variants share the SAME shell (privacy → country → bank). They diverge
// only in the capture "tail": Download clicks a canvas document ("Utility bill-1") then
// submits; Screenshot dismisses "Find info" then clicks "Take photo". Each tail is an
// ordered list of [checkpointName, fn(page)]; runCaptureFlow runs the shell then the tail.
// ============================================================================

// Shared success checkpoint (both variants end here).
const VERIFY_SUCCESS = ['Verify success: "Submission successful"', async (page) => {
  // The "Verifying" pop-up stays until server-side verification completes, which can run
  // past 2 min in sandbox — wait up to 4 min for the success screen. If it never comes,
  // report WHY: stuck on "Verifying" (a real backend bug worth catching) vs. no success.
  try {
    await page.getByText(/submission successful|thank you/i).first().waitFor({ state: 'visible', timeout: 240000 });
  } catch {
    const stuck = await page.getByText(/verifying/i).first().isVisible().catch(() => false);
    if (stuck) throw new Error('Stuck on "Verifying" — verification did not complete within 4 min (possible backend bug)');
    throw new Error('Final success screen ("Submission successful") never appeared');
  }
}];

// Download variant: Start → pick the document on the canvas → submit. The document name
// is taken from the test case's own steps (e.g. "Utility bill-1", "Password protected PDF"),
// so ANY download case works — word-level OCR clicks it in either column.
const tailDownload = (document) => [
  ['Bank verification → Start', async (page) => {
    const s = page.getByRole('button', { name: /^start$/i });
    await s.waitFor({ state: 'visible', timeout: 30000 });
    await s.click({ noWaitAfter: true });
  }],
  [`Select document: ${document} (canvas / OCR)`, async (page) => {
    let pt = null;
    await page.mouse.move(500, 400).catch(() => {}); // hover the list so wheel scrolls it
    for (let a = 0; a < 15 && !pt; a++) {
      pt = await ocrLocatePhrase(page, document);
      if (pt) break;
      // Not visible yet — wait for paint on the first tries, then scroll to reveal
      // documents below the fold (the list is long; OCR only sees the viewport).
      if (a < 2) await page.waitForTimeout(4000);
      else { await page.mouse.wheel(0, 450).catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!pt) throw new Error(`Could not locate "${document}" on the canvas (not found even after scrolling)`);
    await page.mouse.click(pt.x, pt.y);
  }],
  ['Download completes → Submit', async (page) => {
    let seen = false;
    for (let a = 0; a < 45 && !seen; a++) { const t = (await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')) || ''; if (/please review|proceed anyway|download complete|submit/i.test(t)) { seen = true; break; } await page.waitForTimeout(2000); }
    if (!seen) throw new Error('Download did not complete / no review-submit screen appeared');
    for (const name of [/proceed anyway/i, /^submit$/i]) { const b = page.getByRole('button', { name }); if ((await b.count().catch(() => 0)) && (await b.first().isVisible().catch(() => false))) { await b.first().click({ noWaitAfter: true }); break; } }
  }],
  VERIFY_SUCCESS,
];

// Screenshot variant (DIRO-TC-2016): no Start button — the capture screen shows a "Find
// info" pop-up (Continue) and a "Take photo" control; then Verifying → success.
const TAIL_SCREENSHOT = [
  ['Find info pop-up → Continue', async (page) => {
    const c = page.getByRole('button', { name: /^continue$/i }).first();
    await c.waitFor({ state: 'visible', timeout: 40000 });
    await c.click({ noWaitAfter: true });
  }],
  ['Click Take photo', async (page) => {
    const t = page.getByText(/take photo/i).first();
    await t.waitFor({ state: 'visible', timeout: 20000 });
    await t.click({ noWaitAfter: true });
  }],
  VERIFY_SUCCESS,
];

// Shared shell + a variant capture tail. `tail` = [[name, fn(page)], ...].
async function runCaptureFlow(baseUrl, tail, opts = {}) {
  const { page: externalPage = null, onStep = () => {}, shotDir = null, shotUrlBase = null, country = 'Trinidad and Tobago', bank = 'Testing99' } = opts;
  const session = externalPage ? null : await connectPage();
  const page = externalPage ?? session.page; // connectPage already attached the dialog handler
  const results = [];
  const total = 4 + tail.length; // 4 shared shell steps + tail
  let i = 0;
  const step = async (text, fn) => {
    const idx = i++;
    onStep({ index: idx, total, text, status: 'running' });
    const t0 = Date.now();
    let status = 'passed', error = null;
    try { await fn(); } catch (e) { status = 'failed'; error = e.message; }
    let shot = null;
    if (shotDir) { try { const f = `${shotDir}/step-${idx + 1}.png`; await page.screenshot({ path: f }); shot = shotUrlBase ? `${shotUrlBase}/step-${idx + 1}.png` : f; } catch {} }
    onStep({ index: idx, total, text, status, error, shot });
    results.push({ text, status, error, shot, duration: Date.now() - t0 });
    if (status === 'failed') throw new Error('__stop__'); // stop the chain on first failure
  };
  try {
    // ---- Shared shell (identical across CP_Positive variants) ----
    await step('Open verification URL → Privacy pop-up', async () => {
      if (!baseUrl) throw new Error('Base URL is required — paste the verification link in the dashboard.');
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.getByRole('button', { name: 'Continue' }).waitFor({ state: 'visible', timeout: 20000 });
    });
    await step('Click Continue → Select Your Bank', async () => {
      const cont = page.getByRole('button', { name: 'Continue' });
      let ok = false;
      for (let a = 0; a < 5 && !ok; a++) { await cont.click({ timeout: 8000, noWaitAfter: true }).catch(() => {}); await page.waitForTimeout(2500); ok = await page.getByText(/Select Your Bank/i).isVisible().catch(() => false); }
      if (!ok) throw new Error('"Select Your Bank" did not appear after clicking Continue');
    });
    await step(`Select country: ${country}`, async () => {
      await page.locator('.select2-selection').first().click({ timeout: 8000 });
      await page.locator('.select2-search__field').fill(country);
      await page.waitForTimeout(1500);
      // Click the option that matches the country (substring match tolerates extra whitespace).
      await page.locator('.select2-results__option', { hasText: country }).first().click({ timeout: 8000 });
    });
    await step(`Select bank: ${bank}`, async () => {
      await page.locator('#floatingInput').fill(bank);
      await page.waitForTimeout(2000);
      // Click the first result. The card shows a provider domain (e.g. testing99.diro.me,
      // republictt.com), not always the searched name — so match a domain generically,
      // then fall back to the bank name text.
      const byDomain = page.getByText(/\b[a-z0-9-]+\.(me|com|io|net|org|co)\b/i).first();
      const byName = page.getByText(new RegExp(bank.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
      let clicked = false;
      for (const cand of [byDomain, byName]) {
        if ((await cand.count().catch(() => 0)) && (await cand.isVisible().catch(() => false))) { await cand.click({ timeout: 10000, noWaitAfter: true }); clicked = true; break; }
      }
      if (!clicked) throw new Error(`No bank result to click for "${bank}"`);
    });
    // ---- Variant capture tail ----
    for (const [name, fn] of tail) await step(name, () => fn(page));
  } catch (e) {
    if (e.message !== '__stop__') results.push({ text: 'unexpected error', status: 'failed', error: e.message, duration: 0 });
  } finally {
    if (session) await session.browser.close();
  }
  return { url: page.url(), results };
}

/**
 * Classify a test case by its OWN steps (not its key) to pick the deterministic driver.
 * Returns { variant, document? } for a DIRO capture flow, or null (→ AI executor).
 * This is what lets NEW download/screenshot cases run reliably: the routing follows the
 * step-flow signature, so a new case key is handled automatically.
 */
// Known document names on the testing99 list — used to recognize a document from a
// minimal case's title when its steps don't spell out the full click.
const KNOWN_DOCS = ['Utility bill-1', 'Utility bill-2', 'Utility bill-3', 'Utility bill-4', 'Utility bill-5', 'Password protected PDF', 'Spreadsheet PDF', 'Images and text PDF', 'Flash PDF', 'Image PDF', 'Nonsearchable PDF', 'Crookedscan PDF', 'Hybrid PDF', 'blank doc PDF', 'Text File'];

export function classifyCaptureFlow(caseSteps, opts = {}) {
  const { title = '', folder = '', profile = {} } = opts;
  const steps = caseSteps || [];
  const stepText = steps.map((s) => `${s.step || ''} ${s.expected || ''}`).join('\n');
  const all = `${title}\n${stepText}`.toLowerCase();
  // Strong signal: the full shell appears in the steps. Minimal signal: a capture-process
  // folder case whose title/steps say to take a photo or download a document — so a case
  // with ONE step (or just a descriptive title) still runs the full remembered flow.
  const hasShell = /verification url/.test(all) && /continue/.test(all) && /(select your bank|bank search|testing99)/.test(all);
  const captureFolder = /capture process|cp_positive|download|screenshot/i.test(folder);
  const wantsScreenshot = /take photo|screenshot|capture photo|take a photo/.test(all);
  const wantsDownload = /\bdownload\b|utility bill|password protected pdf|\bstatement\b|\.txt\b|\bpdf\b|\bdocument\b/.test(all);
  const isCapture = hasShell || (captureFolder && (wantsScreenshot || wantsDownload || /verify capture process|capture process/.test(all)));
  if (!isCapture) return null;

  // Country + bank: the case's ordered "Search X"/"Select X" steps (first distinct = country,
  // second = bank), else the stored profile, else the defaults.
  const picks = [];
  const SKIP_PICK = /^(your bank|the bank|a bank|bank|country|the country|continue|start|submit|proceed|take photo|a photo|close|back|next|option|the option|search)$/i;
  for (const s of steps) {
    const m = /^(?:search|select)\s+"?([^"]+?)"?\s*$/i.exec((s.step || '').trim());
    if (m) {
      const v = m[1].trim().replace(/["'.]+$/, '');
      if (v && !SKIP_PICK.test(v) && (!picks.length || picks[picks.length - 1].toLowerCase() !== v.toLowerCase())) picks.push(v);
    }
  }
  const country = picks[0] || profile.country || 'Trinidad and Tobago';
  const bank = picks[1] || profile.bank || 'Testing99';

  if (wantsScreenshot) return { variant: 'screenshot', country, bank };

  // Download document: a "Click <doc>" step → a known doc named in the title → profile default.
  let document = null;
  for (const s of steps) {
    const m = /\bclick\s+(?:on\s+)?(.+)/i.exec((s.step || '').trim());
    if (m) {
      const target = m[1].trim()
        .replace(/\s*\([^)]*(?:https?:\/\/|link)[^)]*\)/gi, '') // drop "(Link: https://…)" but keep "(Feb - Apr)"
        .replace(/\b(?:link|url)\s*[:=]\s*/gi, ' ')             // drop leftover "Link:" / "URL="
        .replace(/https?:\/\/\S+/gi, '')                        // drop any bare URL
        .replace(/["'.]+$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (target && !/^(continue|start|submit|proceed|take photo|close|back|next|sign in|login)\b/i.test(target)) { document = target; break; }
    }
  }
  if (!document) document = KNOWN_DOCS.find((d) => (title + ' ' + stepText).toLowerCase().includes(d.toLowerCase())) || null;
  document = document || profile.defaultDocument || 'Utility bill-1';
  return { variant: 'download', document, country, bank };
}

// Route a capture-flow case to the right deterministic driver based on its steps + profile.
export async function runCaptureFlowAuto(baseUrl, caseSteps, opts = {}) {
  const { title, folder, profile } = opts;
  const cls = classifyCaptureFlow(caseSteps, { title, folder, profile }) || { variant: 'download', document: (profile && profile.defaultDocument) || 'Utility bill-1', country: (profile && profile.country) || 'Trinidad and Tobago', bank: (profile && profile.bank) || 'Testing99' };
  const tail = cls.variant === 'screenshot' ? TAIL_SCREENSHOT : tailDownload(cls.document);
  return runCaptureFlow(baseUrl, tail, { ...opts, country: cls.country, bank: cls.bank });
}

// Back-compat explicit wrappers (still usable directly).
export const runCpPositive = (baseUrl, opts) => runCaptureFlow(baseUrl, tailDownload('Utility bill-1'), opts);
export const runCpPositiveScreenshot = (baseUrl, opts) => runCaptureFlow(baseUrl, TAIL_SCREENSHOT, opts);
