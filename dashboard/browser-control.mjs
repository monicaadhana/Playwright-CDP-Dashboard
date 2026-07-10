// Execute a Gemini-produced step plan against the CDP Chrome using Playwright.
import { chromium } from '@playwright/test';
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
Keep the plan minimal and ordered.`;

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
export async function runPlan(steps, onStep, opts = {}) {
  const { shotDir = null, shotUrlBase = null, preamble = null, skipGoto = false } = opts;
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    await page.bringToFront().catch(() => {});
    // Some flows raise a native beforeunload/confirm dialog on close — dismiss it
    // (stay on page) so it doesn't stall the run.
    const onDialog = (d) => d.accept().catch(() => {});
    page.on('dialog', onDialog);

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
        await execStep(page, step);
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
    await browser.close(); // disconnect only; leaves Chrome running
  }
}

async function execStep(page, step) {
  const timeout = 15000;
  switch (step.action) {
    case 'goto':
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    case 'click':
      await resolveLocator(page, step.locator).click({ timeout });
      break;
    case 'fill':
      await resolveLocator(page, step.locator).fill(String(step.text ?? ''), { timeout });
      break;
    case 'press':
      if (step.locator) await resolveLocator(page, step.locator).press(step.key, { timeout });
      else await page.keyboard.press(step.key);
      break;
    case 'waitFor':
      await resolveLocator(page, step.locator).waitFor({ timeout });
      break;
    case 'expectVisible': {
      const visible = await resolveLocator(page, step.locator).first().isVisible();
      if (!visible) throw new Error('element not visible');
      break;
    }
    case 'expectText': {
      const content = await resolveLocator(page, step.locator).first().textContent({ timeout });
      if (!content || !content.includes(step.text)) {
        throw new Error(`expected text "${step.text}", got "${(content ?? '').slice(0, 60)}"`);
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
