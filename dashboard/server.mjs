// Dashboard server: control the Playwright-over-CDP test flow from a browser.
//   - start / stop the CDP Chrome
//   - run / stop test runs (all, by file, or by title grep)
//   - stream live logs + per-test status over WebSocket
//   - serve the Playwright HTML report
import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, writeFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CDP_ENDPOINT, cdpStatus } from '../scripts/chrome-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load GEMINI_API_KEY (and friends) from .env, then import the AI modules.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env file — AI features report "not configured" */
}
const gemini = await import('./gemini.mjs');
const { planFromCommand, planFromTestCase, runPlan, connectPage, runCaseAgent, classifyCaptureFlow, runCaptureFlowAuto } = await import('./browser-control.mjs');
const multer = (await import('multer')).default;

// ---- Capture-flow PROFILE (the remembered flow config) ------------------------------
// The full capture flow lives in the deterministic driver, so a case doesn't need to
// spell out every step. This profile remembers the shared, non-step values (country,
// bank, default document) so a MINIMAL case (e.g. one step "download document") still
// runs the whole flow. Set it once via the dashboard "Flow & test-data" field with lines
// like  Country: India   Bank: Testing99   Document: Utility bill-2  — it's persisted here.
const CAPTURE_PROFILE_FILE = path.join(ROOT, 'dashboard', 'capture-profile.json');
const DEFAULT_CAPTURE_PROFILE = { country: 'Trinidad and Tobago', bank: 'Testing99', defaultDocument: 'Utility bill-1' };
function loadCaptureProfile() {
  try { return { ...DEFAULT_CAPTURE_PROFILE, ...(existsSync(CAPTURE_PROFILE_FILE) ? JSON.parse(readFileSync(CAPTURE_PROFILE_FILE, 'utf8')) : {}) }; }
  catch { return { ...DEFAULT_CAPTURE_PROFILE }; }
}
function saveCaptureProfile(p) { try { writeFileSync(CAPTURE_PROFILE_FILE, JSON.stringify(p, null, 2), 'utf8'); } catch {} return p; }
// Parse Country/Bank/Document lines from the dashboard Flow field and persist them, so the
// user provides the flow config ONCE and it's remembered for later minimal cases.
function applyFlowOverrides(profile, description) {
  const grab = (re) => { const m = re.exec(description || ''); return m ? m[1].trim() : null; };
  const country = grab(/country\s*[:=]\s*([^\n]+)/i);
  const bank = grab(/\bbank\s*[:=]\s*([^\n]+)/i);
  const doc = grab(/document\s*[:=]\s*([^\n]+)/i);
  let changed = false;
  if (country) { profile.country = country; changed = true; }
  if (bank) { profile.bank = bank; changed = true; }
  if (doc) { profile.defaultDocument = doc; changed = true; }
  if (changed) { try { writeFileSync(CAPTURE_PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf8'); } catch {} }
  return profile;
}
const excel = await import('./excel.mjs');
const jira = await import('./jira.mjs');
const aio = await import('./aio.mjs');
const { Registry } = await import('./registry.mjs');
const { Bugs } = await import('./bugs.mjs');
const PORT = Number(process.env.DASHBOARD_PORT ?? 4000);
const MARKER = '@@PW@@';

const registry = new Registry(path.join(__dirname, 'testcases.json'));
const bugs = new Bugs(path.join(__dirname, 'bugs.json'));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB — comfortably fits 5000+ rows
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve the Playwright HTML report (regenerated after every run).
app.use('/report', express.static(path.join(ROOT, 'playwright-report')));
// Serve failure screenshots / traces so the Results panel can show them.
app.use('/artifacts', express.static(path.join(ROOT, 'test-results')));

const TESTS_DIR = path.join(ROOT, 'tests');
const RESULTS_FILE = path.join(__dirname, 'run-results.json');

const server = createServer(app);
const wss = new WebSocketServer({ server });

/** Broadcast a JSON message to every connected dashboard. */
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// ---- test run state ---------------------------------------------------------
let testProc = null;

function log(line, stream = 'stdout') {
  broadcast({ channel: 'log', line, stream });
}

// ---- results history (persisted to run-results.json) ------------------------
const MAX_RUNS = 25;
let runs = [];
let currentRun = null;
try {
  if (existsSync(RESULTS_FILE)) runs = JSON.parse(readFileSync(RESULTS_FILE, 'utf8'));
} catch {
  runs = [];
}
function saveRuns() {
  try {
    writeFileSync(RESULTS_FILE, JSON.stringify(runs.slice(0, MAX_RUNS)), 'utf8');
  } catch {
    /* best-effort persistence */
  }
}
const screenshotUrl = (rel) =>
  rel && rel.startsWith('test-results/') ? '/artifacts/' + rel.slice('test-results/'.length) : null;

// Guarantee every test case has at least one screenshot: capture the page's final
// state (pass or fail) into <shotDir>/final.png. Works even for cases that failed
// before any step ran (e.g. a Gemini planning error), since the shared page is live.
// Returns the servable URL, or null if the page couldn't be captured.
async function captureFinalShot(page, shotDir, shotName) {
  if (!page) return null;
  try {
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'final.png') });
    return `/artifacts/${shotName}/final.png`;
  } catch {
    return null;
  }
}

/** Build the run-history store from the reporter event stream. */
function recordEvent(event) {
  if (event.type === 'begin') {
    currentRun = {
      id: String(Date.now()),
      startedAt: Date.now(),
      status: 'running',
      total: event.total,
      tests: (event.tests ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        file: t.file ?? '',
        status: 'pending',
      })),
    };
  } else if (!currentRun) {
    return;
  } else if (event.type === 'testBegin') {
    const t = currentRun.tests.find((x) => x.id === event.id);
    if (t) t.status = 'running';
  } else if (event.type === 'testEnd') {
    let t = currentRun.tests.find((x) => x.id === event.id);
    if (!t) {
      t = { id: event.id, title: event.title };
      currentRun.tests.push(t);
    }
    t.title = event.title;
    t.file = event.file ?? t.file ?? '';
    t.status = event.status;
    t.duration = event.duration;
    t.error = event.error ?? null;
    t.screenshots = (event.screenshots ?? []).map(screenshotUrl).filter(Boolean);
  } else if (event.type === 'end') {
    currentRun.status = event.status;
    currentRun.finishedAt = Date.now();
    runs.unshift(currentRun);
    runs = runs.slice(0, MAX_RUNS);
    saveRuns();
    // Auto-raise a bug per failed test in this run.
    const newBugs = bugs.fromRun(currentRun);
    broadcast({ channel: 'results', updated: true });
    if (newBugs.length) broadcast({ channel: 'bugs', added: newBugs.length });
    currentRun = null;
  }
}

function resolvePlaywrightCli() {
  const cli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  return existsSync(cli) ? cli : null;
}

function runTests({ grep, file }) {
  if (testProc) return { ok: false, error: 'A run is already in progress.' };

  // ws-reporter drives the live status grid; html feeds the "Open report" link.
  const args = ['test', `--reporter=${path.join(__dirname, 'ws-reporter.ts')},html`];
  if (file) args.push(file);
  if (grep) args.push('--grep', grep);

  const cli = resolvePlaywrightCli();
  let cmd, cmdArgs, useShell;
  if (cli) {
    cmd = process.execPath; // node
    cmdArgs = [cli, ...args];
    useShell = false;
  } else {
    cmd = 'npx';
    cmdArgs = ['playwright', ...args];
    useShell = true;
  }

  broadcast({ channel: 'run', state: 'started', grep: grep ?? null, file: file ?? null });
  log(`$ playwright ${args.join(' ')}`, 'meta');

  testProc = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    shell: useShell,
    env: { ...process.env, CDP_ENDPOINT, FORCE_COLOR: '0' },
  });

  let buffer = '';
  const handleChunk = (chunk, stream) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith(MARKER)) {
        try {
          const event = JSON.parse(line.slice(MARKER.length));
          recordEvent(event);
          broadcast({ channel: 'event', event });
        } catch {
          /* ignore malformed marker */
        }
      } else if (line.length) {
        log(line, stream);
      }
    }
  };

  testProc.stdout.on('data', (c) => handleChunk(c, 'stdout'));
  testProc.stderr.on('data', (c) => handleChunk(c, 'stderr'));
  testProc.on('close', (code) => {
    if (buffer.length) log(buffer, 'stdout');
    buffer = '';
    testProc = null;
    broadcast({ channel: 'run', state: 'finished', code });
    log(`Run finished (exit code ${code})`, 'meta');
  });

  return { ok: true };
}

function stopTests() {
  if (!testProc) return { ok: false, error: 'No run in progress.' };
  const pid = testProc.pid;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    testProc.kill('SIGTERM');
  }
  log('Stopping current run…', 'meta');
  return { ok: true };
}

function runScript(scriptName) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'scripts', scriptName)], {
      cwd: ROOT,
      env: process.env,
    });
    proc.stdout.on('data', (c) => log(c.toString().trimEnd(), 'meta'));
    proc.stderr.on('data', (c) => log(c.toString().trimEnd(), 'stderr'));
    proc.on('close', (code) => resolve(code));
  });
}

// ---- API --------------------------------------------------------------------
app.get('/api/status', async (_req, res) => {
  const chrome = await cdpStatus();
  res.json({
    chrome: chrome ? { up: true, browser: chrome.Browser, endpoint: CDP_ENDPOINT } : { up: false, endpoint: CDP_ENDPOINT },
    running: !!testProc,
  });
});

app.post('/api/chrome/start', async (_req, res) => {
  log('Starting CDP Chrome…', 'meta');
  const code = await runScript('launch-chrome.mjs');
  const chrome = await cdpStatus();
  broadcast({ channel: 'chrome', up: !!chrome });
  res.json({ ok: code === 0, up: !!chrome });
});

app.post('/api/chrome/stop', async (_req, res) => {
  log('Stopping CDP Chrome…', 'meta');
  await runScript('stop-chrome.mjs');
  const chrome = await cdpStatus();
  broadcast({ channel: 'chrome', up: !!chrome });
  res.json({ ok: true, up: !!chrome });
});

app.post('/api/tests/run', (req, res) => {
  const grep = typeof req.body?.grep === 'string' ? req.body.grep.trim() : '';
  const file = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
  res.json(runTests({ grep, file }));
});

app.post('/api/tests/stop', (_req, res) => {
  res.json(stopTests());
});

// Browse the tests/ folder: each spec file with the test titles inside it.
app.get('/api/tests/list', (_req, res) => {
  const TITLE_RE = /\btest(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])([^'"`]+)\1/g;
  const walk = (dir, base = '') => {
    let out = [];
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out = out.concat(walk(path.join(dir, e.name), rel));
      } else if (/\.spec\.(ts|js|mjs)$/.test(e.name)) {
        let titles = [];
        try {
          const src = readFileSync(path.join(dir, e.name), 'utf8');
          titles = [...src.matchAll(TITLE_RE)].map((m) => m[2]);
        } catch {
          /* unreadable */
        }
        out.push({ file: `tests/${rel}`, name: e.name, titles });
      }
    }
    return out;
  };
  res.json({ files: walk(TESTS_DIR) });
});

// Validate a spec path is inside tests/ and is a spec file (no traversal).
function safeSpecPath(file) {
  const rel = path.posix.normalize(String(file || '').replace(/\\/g, '/'));
  if (!rel.startsWith('tests/') || rel.includes('..') || !/\.spec\.(ts|js|mjs)$/.test(rel)) return null;
  return { rel, abs: path.join(ROOT, rel) };
}

// Read a test file's contents (for the editor).
app.get('/api/tests/file', (req, res) => {
  const sp = safeSpecPath(req.query.file);
  if (!sp) return res.status(400).json({ ok: false, error: 'Invalid test file path.' });
  if (!existsSync(sp.abs)) return res.status(404).json({ ok: false, error: 'File not found.' });
  try {
    res.json({ ok: true, file: sp.rel, code: readFileSync(sp.abs, 'utf8') });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Save edits back to a test file (create or overwrite).
app.post('/api/tests/save', (req, res) => {
  const sp = safeSpecPath(req.body?.file);
  if (!sp) return res.status(400).json({ ok: false, error: 'Path must be tests/*.spec.(ts|js|mjs)' });
  try {
    writeFileSync(sp.abs, String(req.body?.code ?? ''), 'utf8');
    log(`Saved ${sp.rel}`, 'meta');
    res.json({ ok: true, file: sp.rel });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete a test file.
app.post('/api/tests/delete', (req, res) => {
  const sp = safeSpecPath(req.body?.file);
  if (!sp) return res.status(400).json({ ok: false, error: 'Invalid test file path.' });
  if (!existsSync(sp.abs)) return res.status(404).json({ ok: false, error: 'File not found.' });
  try {
    unlinkSync(sp.abs);
    log(`Deleted ${sp.rel}`, 'meta');
    res.json({ ok: true, file: sp.rel });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Run history — every run with its per-test results (name, status, screenshots).
app.get('/api/results', (_req, res) => {
  res.json({ runs, running: currentRun });
});

// Record a manual/externally-driven run (e.g. a hand-driven exploratory test).
app.post('/api/results/record', (req, res) => {
  const b = req.body || {};
  const tests = Array.isArray(b.tests) ? b.tests : [];
  if (!tests.length) return res.status(400).json({ ok: false, error: 'No tests provided.' });
  const started = b.startedAt || Date.now();
  const run = {
    id: b.id || 'man-' + Date.now(),
    startedAt: started,
    finishedAt: b.finishedAt || Date.now(),
    status: b.status || (tests.every((t) => t.status === 'passed') ? 'passed' : 'failed'),
    source: b.source || 'manual',
    group: b.group || '',
    tests,
  };
  runs.unshift(run);
  runs = runs.slice(0, MAX_RUNS);
  saveRuns();
  const nb = bugs.fromRun(run);
  broadcast({ channel: 'results', updated: true });
  if (nb.length) broadcast({ channel: 'bugs', added: nb.length });
  res.json({ ok: true, runId: run.id, bugs: nb.length });
});

// Delete a run and its derived bugs.
app.delete('/api/results/:runId', (req, res) => {
  const id = String(req.params.runId);
  const before = runs.length;
  runs = runs.filter((r) => String(r.id) !== id);
  saveRuns();
  const b0 = bugs.bugs.length;
  bugs.bugs = bugs.bugs.filter((x) => String(x['Run ID']) !== id);
  bugs.save();
  broadcast({ channel: 'results', updated: true });
  broadcast({ channel: 'bugs', removed: true });
  res.json({ ok: true, removedRun: before - runs.length, removedBugs: b0 - bugs.bugs.length });
});

// ---- Test Case Registry -----------------------------------------------------
app.get('/api/registry', (req, res) => {
  const { search, priority, module, automationStatus, folder } = req.query;
  res.json({
    cases: registry.list({ search, priority, module, automationStatus, folder }),
    total: registry.cases.length,
    folders: registry.folders(),
  });
});

app.get('/api/registry/folders', (_req, res) => res.json({ folders: registry.folders() }));

app.post('/api/registry/folder', (req, res) => {
  const path = registry.addFolder(req.body?.path);
  if (!path) return res.status(400).json({ ok: false, error: 'Folder path is required.' });
  broadcast({ channel: 'registry', updated: true });
  res.json({ ok: true, path });
});

app.post('/api/registry/rename-folder', (req, res) => {
  const from = String(req.body?.from ?? '');
  const to = String(req.body?.to ?? '').trim();
  if (!to) return res.status(400).json({ ok: false, error: 'New folder name is required.' });
  const updated = registry.renameFolder(from, to);
  broadcast({ channel: 'registry', updated: true });
  res.json({ ok: true, updated });
});

app.post('/api/registry/delete-folder', (req, res) => {
  const folder = String(req.body?.folder ?? '');
  const deleted = registry.deleteFolder(folder);
  broadcast({ channel: 'registry', updated: true });
  res.json({ ok: true, deleted });
});

app.post('/api/registry', (req, res) => {
  const tc = req.body || {};
  if (!tc['Test Case ID'] || !tc['Test Case Name'])
    return res.status(400).json({ ok: false, error: 'Test Case ID and Name are required.' });
  res.json({ ok: true, case: registry.upsert(tc) });
});

app.put('/api/registry/:id', (req, res) => {
  if (!registry.get(req.params.id)) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, case: registry.upsert({ ...req.body, 'Test Case ID': req.params.id }) });
});

app.delete('/api/registry/:id', (req, res) => {
  res.json({ ok: registry.remove(req.params.id) });
});

app.post('/api/registry/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  res.json({ ok: true, deleted: registry.removeMany(ids) });
});

app.post('/api/registry/bulk-move', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const folder = String(req.body?.folder ?? '').trim();
  const moved = registry.moveMany(ids, folder);
  broadcast({ channel: 'registry', updated: true });
  res.json({ ok: true, moved });
});

// Execute a whole functionality (group of cases) as ONE combined run.
let groupRunBusy = false;
app.post('/api/registry/run-group', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const groupName = String(req.body?.groupName || 'Functionality');
  const baseUrl = String(req.body?.baseUrl || '').trim();
  if (!ids.length) return res.status(400).json({ ok: false, error: 'No test cases in this functionality.' });
  if (!gemini.isConfigured()) return res.status(400).json({ ok: false, error: 'Gemini is not configured.' });
  if (!(await cdpStatus())) return res.status(400).json({ ok: false, error: 'Start Chrome first.' });
  if (groupRunBusy || caseRunBusy) return res.status(409).json({ ok: false, error: 'A run is already in progress.' });

  groupRunBusy = true;
  res.json({ ok: true, total: ids.length });

  const started = Date.now();
  const runId = `grp-${started}`;
  const tests = [];
  broadcast({ channel: 'grouprun', state: 'start', group: groupName, total: ids.length });
  log(`Run functionality "${groupName}" — ${ids.length} case(s)`, 'meta');
  // One shared CDP connection for the whole group (see connectPage) — reconnecting
  // per case deadlocks once a flow leaves a native dialog open. Closed in `finally`.
  let sharedSession = null;
  try {
    sharedSession = await connectPage();
    for (let i = 0; i < ids.length; i++) {
      const tc = registry.get(ids[i]);
      if (!tc) continue;
      broadcast({ channel: 'grouprun', state: 'case', group: groupName, index: i, total: ids.length, title: tc['Test Case Name'], status: 'running' });
      const shotName = `grp-${started}-${String(tc['Test Case ID']).replace(/[^\w.-]/g, '_')}`;
      const shotDir = path.join(ROOT, 'test-results', shotName);
      let status = 'passed', error = null, failedStep = '', steps = [];
      const t0 = Date.now();
      try {
        mkdirSync(shotDir, { recursive: true });
        const plan = await planFromTestCase(tc, baseUrl);
        const result = await runPlan(plan, () => {}, { shotDir, shotUrlBase: `/artifacts/${shotName}`, page: sharedSession.page });
        steps = result.results;
        const fi = steps.findIndex((s) => s.status === 'failed');
        status = steps.length && fi === -1 ? 'passed' : 'failed';
        if (fi >= 0) { error = steps[fi].error; failedStep = fi + 1; }
      } catch (e) {
        status = 'failed';
        error = e.message;
      }
      // Always capture a final screenshot so every case has at least one.
      const finalShot = await captureFinalShot(sharedSession.page, shotDir, shotName);
      const shots = steps.map((s) => s.shot).filter(Boolean);
      if (finalShot) shots.push(finalShot);
      tests.push({
        id: tc['Test Case ID'],
        title: `${tc['Test Case ID']} — ${tc['Test Case Name']}`,
        file: tc['Test Case ID'],
        status,
        duration: Date.now() - t0,
        error,
        failedStep,
        expected: tc['Expected Result'] || '',
        screenshots: shots,
        steps,
      });
      broadcast({ channel: 'grouprun', state: 'case', group: groupName, index: i, total: ids.length, title: tc['Test Case Name'], status });
    }
    const passed = tests.filter((t) => t.status === 'passed').length;
    const run = {
      id: runId,
      startedAt: started,
      finishedAt: Date.now(),
      status: tests.length && passed === tests.length ? 'passed' : 'failed',
      source: 'functionality',
      group: groupName,
      tests,
    };
    runs.unshift(run);
    runs = runs.slice(0, MAX_RUNS);
    saveRuns();
    const newBugs = bugs.fromRun(run);
    broadcast({ channel: 'grouprun', state: 'done', group: groupName, passed, failed: tests.length - passed, total: tests.length, runId });
    broadcast({ channel: 'results', updated: true });
    if (newBugs.length) broadcast({ channel: 'bugs', added: newBugs.length });
    log(`Functionality "${groupName}" → ${passed}/${tests.length} passed`, passed === tests.length ? 'meta' : 'stderr');
  } catch (err) {
    broadcast({ channel: 'grouprun', state: 'error', group: groupName, error: err.message });
    log(`Functionality run error: ${err.message}`, 'stderr');
  } finally {
    if (sharedSession) await sharedSession.browser.close().catch(() => {}); // disconnect only; leaves Chrome running
    groupRunBusy = false;
  }
});

// Execute a registry (manual) test case via the AI step-executor over CDP.
let caseRunBusy = false;
app.post('/api/registry/:id/run', async (req, res) => {
  const tc = registry.get(req.params.id);
  if (!tc) return res.status(404).json({ ok: false, error: 'Test case not found.' });
  if (!gemini.isConfigured()) return res.status(400).json({ ok: false, error: 'Gemini is not configured (set GEMINI_API_KEY).' });
  if (!(await cdpStatus())) return res.status(400).json({ ok: false, error: 'Start Chrome first.' });
  if (caseRunBusy) return res.status(409).json({ ok: false, error: 'A test-case run is already in progress.' });

  const baseUrl = String(req.body?.baseUrl || '').trim();
  const tcId = tc['Test Case ID'];
  caseRunBusy = true;
  res.json({ ok: true }); // executes asynchronously; progress streams over WS ('ai' channel)

  const started = Date.now();
  const shotName = `reg-${String(tcId).replace(/[^\w.-]/g, '_')}-${started}`;
  const shotDir = path.join(ROOT, 'test-results', shotName);
  let sharedSession = null;
  try {
    mkdirSync(shotDir, { recursive: true });
    sharedSession = await connectPage();
    broadcast({ channel: 'ai', kind: 'control', state: 'planning', command: `Run ${tcId} — ${tc['Test Case Name']}` });
    log(`Run test case ${tcId}: ${tc['Test Case Name']}`, 'meta');
    const steps = await planFromTestCase(tc, baseUrl);
    broadcast({ channel: 'ai', kind: 'control', state: 'plan', steps });

    const result = await runPlan(
      steps,
      (update) => {
        broadcast({ channel: 'ai', kind: 'control', state: 'step', update });
        log(`  [${update.status}] ${update.text}${update.error ? ' — ' + update.error : ''}`, update.status === 'failed' ? 'stderr' : 'meta');
      },
      { shotDir, shotUrlBase: `/artifacts/${shotName}`, page: sharedSession.page },
    );

    const steps2 = result.results;
    const firstFailIdx = steps2.findIndex((r) => r.status === 'failed');
    const passed = steps2.length > 0 && firstFailIdx === -1;
    // Always capture a final screenshot so the case has at least one.
    const finalShot = await captureFinalShot(sharedSession.page, shotDir, shotName);
    const shots = steps2.map((r) => r.shot).filter(Boolean);
    if (finalShot) shots.push(finalShot);
    const run = {
      id: `reg-${started}`,
      startedAt: started,
      finishedAt: Date.now(),
      status: passed ? 'passed' : 'failed',
      source: 'registry',
      tests: [{
        id: tcId,
        title: `${tcId} — ${tc['Test Case Name']}`,
        file: tcId,
        status: passed ? 'passed' : 'failed',
        duration: steps2.reduce((a, r) => a + (r.duration || 0), 0),
        error: firstFailIdx >= 0 ? steps2[firstFailIdx].error : null,
        failedStep: firstFailIdx >= 0 ? firstFailIdx + 1 : '',
        expected: tc['Expected Result'] || '',
        screenshots: shots,
        steps: steps2,
      }],
    };
    runs.unshift(run);
    runs = runs.slice(0, MAX_RUNS);
    saveRuns();
    const newBugs = bugs.fromRun(run);
    broadcast({ channel: 'ai', kind: 'control', state: 'done', result });
    broadcast({ channel: 'results', updated: true });
    if (newBugs.length) broadcast({ channel: 'bugs', added: newBugs.length });
    log(`Test case ${tcId} → ${run.status}`, run.status === 'passed' ? 'meta' : 'stderr');
  } catch (err) {
    broadcast({ channel: 'ai', kind: 'control', state: 'error', error: err.message });
    log(`Test case run error: ${err.message}`, 'stderr');
  } finally {
    if (sharedSession) await sharedSession.browser.close().catch(() => {}); // disconnect only; leaves Chrome running
    caseRunBusy = false;
  }
});

// Excel import — parses in the background and streams progress over WS.
let importSeq = 0;
app.post('/api/registry/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
  const name = req.file.originalname || '';
  if (!/\.(xlsx|xls)$/i.test(name))
    return res.status(400).json({ ok: false, error: 'Invalid file format. Upload .xlsx or .xls.' });

  // "Additional information" applied to every imported row (from the modal).
  const b = req.body || {};
  const defaults = {
    Folder: (b.Folder || '').trim(),
    Module: (b.Module || '').trim(),
    Feature: (b.Feature || '').trim(),
    Priority: (b.Priority || '').trim(),
    'Automation Status': (b['Automation Status'] || '').trim(),
    Owner: (b.Owner || '').trim(),
    Tags: (b.Tags || '').trim(),
  };

  const jobId = `imp-${++importSeq}`;
  res.json({ ok: true, jobId });

  setImmediate(() => {
    broadcast({ channel: 'import', jobId, state: 'parsing', file: name });
    let parsed;
    try {
      parsed = excel.parseWorkbook(req.file.buffer);
    } catch (err) {
      broadcast({ channel: 'import', jobId, state: 'error', error: 'Could not read file: ' + err.message });
      return;
    }
    if (!parsed.rows.length) {
      broadcast({ channel: 'import', jobId, state: 'error', error: 'The sheet has no data rows.' });
      return;
    }
    const summary = registry.import(parsed.headers, parsed.rows, (done, total) => {
      broadcast({ channel: 'import', jobId, state: 'progress', done, total });
    }, defaults);
    if (summary.columnError) {
      broadcast({ channel: 'import', jobId, state: 'error', error: summary.columnError });
      return;
    }
    broadcast({ channel: 'import', jobId, state: 'done', summary });
    broadcast({ channel: 'registry', updated: true });
  });
});

// ---- Bugs -------------------------------------------------------------------
app.get('/api/bugs', (req, res) => {
  const { severity, status, runId, search } = req.query;
  res.json({ bugs: bugs.list({ severity, status, runId, search }) });
});

// ---- Excel downloads (formatted) --------------------------------------------
function sendXlsx(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

app.get('/api/registry/template.xlsx', async (_req, res) => {
  sendXlsx(res, await excel.buildTemplate(), 'test-cases-template.xlsx');
});

app.get('/api/registry/export.xlsx', async (req, res) => {
  const { search, priority, module, automationStatus, folder } = req.query;
  const cases = registry.list({ search, priority, module, automationStatus, folder });
  sendXlsx(res, await excel.buildRegistryExport(cases), 'test-cases.xlsx');
});

app.get('/api/bugs/export.xlsx', async (req, res) => {
  const { severity, status, runId, search } = req.query;
  const origin = `${req.protocol}://${req.get('host')}`; // absolute base for clickable screenshot links
  sendXlsx(res, await excel.buildBugReport(bugs.list({ severity, status, runId, search }), { origin }), 'bug-report.xlsx');
});

app.get('/api/results/export.xlsx', async (req, res) => {
  const runId = req.query.runId;
  const chosen = runId ? runs.filter((r) => String(r.id) === String(runId)) : runs;
  const flat = [];
  for (const run of chosen) {
    for (const t of run.tests) {
      flat.push({
        'Run ID': run.id,
        Started: new Date(run.startedAt).toISOString(),
        Finished: run.finishedAt ? new Date(run.finishedAt).toISOString() : '',
        'Run Status': run.status,
        'Test Case': t.title,
        File: t.file ?? '',
        Status: t.status,
        'Duration (ms)': t.duration ?? '',
        Error: t.error ?? '',
        Screenshot: (t.screenshots && t.screenshots[0]) ?? '',
      });
    }
  }
  sendXlsx(res, await excel.buildTestResults(flat), 'test-results.xlsx');
});

// ---- Jira integration -------------------------------------------------------
app.get('/api/jira/status', (_req, res) => {
  res.json({ configured: jira.isConfigured(), baseUrl: process.env.JIRA_BASE_URL || '' });
});

app.get('/api/jira/verify', async (_req, res) => {
  res.json(await jira.health());
});

app.get('/api/jira/issue/:key', async (req, res) => {
  try {
    res.json({ ok: true, issue: await jira.getIssue(req.params.key) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

const STORY_SYSTEM = `You are a senior QA engineer. From the Jira story below, derive a
thorough set of test cases covering the acceptance criteria — include positive, negative,
edge, and validation scenarios. Return JSON: {"testCases":[ ... ]}. Each test case has:
name, module, priority (one of Critical/High/Medium/Low), preconditions,
steps (numbered, one per line), expected, testData, tags. Be specific and concise.`;

const STORY_SCHEMA = {
  type: 'object',
  properties: {
    testCases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, module: { type: 'string' }, priority: { type: 'string' },
          preconditions: { type: 'string' }, steps: { type: 'string' }, expected: { type: 'string' },
          testData: { type: 'string' }, tags: { type: 'string' },
        },
        required: ['name', 'steps', 'expected'],
      },
    },
  },
  required: ['testCases'],
};

// Fetch a story and generate test cases from it into the registry.
app.post('/api/jira/generate', async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'Story key is required.' });
  if (!gemini.isConfigured()) return res.status(400).json({ ok: false, error: 'Gemini is not configured (set GEMINI_API_KEY).' });
  try {
    const issue = await jira.getIssue(key);
    const prompt =
      `Story: ${issue.key} — ${issue.summary}\n` +
      `Type: ${issue.type} | Priority: ${issue.priority}\n` +
      `Description / acceptance criteria:\n${issue.description || '(none provided)'}`;
    const out = await gemini.generateJSON(prompt, { system: STORY_SYSTEM, schema: STORY_SCHEMA, maxOutputTokens: 8192 });
    const cases = Array.isArray(out.testCases) ? out.testCases : [];
    if (!cases.length) throw new Error('Gemini returned no test cases for this story.');

    const existing = registry.ids();
    const imported = [];
    let n = 0;
    for (const c of cases) {
      n++;
      let id = `${issue.key}-TC-${n}`;
      while (existing.has(id.toLowerCase())) id = `${issue.key}-TC-${n}-${Math.floor(n * 7 % 97)}`;
      existing.add(id.toLowerCase());
      const pr = ['critical', 'high', 'medium', 'low'].includes(String(c.priority).toLowerCase()) ? c.priority : 'Medium';
      const tc = {
        'Test Case ID': id,
        'Test Case Name': c.name || `${issue.key} case ${n}`,
        Module: c.module || issue.components[0] || issue.type,
        Feature: issue.summary,
        Priority: pr,
        Preconditions: c.preconditions || '',
        'Test Steps': c.steps || '',
        'Expected Result': c.expected || '',
        'Test Data': c.testData || '',
        Tags: [issue.key, c.tags].filter(Boolean).join(', '),
        'Automation Status': 'Manual',
        Owner: process.env.JIRA_EMAIL || '',
        source: 'jira',
        jiraKey: issue.key,
      };
      registry.upsert(tc);
      imported.push(tc);
    }
    broadcast({ channel: 'registry', updated: true });
    res.json({ ok: true, issue, generated: cases.length, imported: imported.length, cases: imported });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- AI (Gemini) ------------------------------------------------------------
app.get('/api/ai/status', (_req, res) => {
  res.json({ configured: gemini.isConfigured(), model: gemini.MODEL });
});

const SPEC_SYSTEM = `You write Playwright test specs for a project that runs over CDP.
Tests MUST import the custom fixture, not @playwright/test:

  import { test, expect } from './fixtures';

Use accessible locators (getByRole/getByLabel/getByText). Return JSON:
{"filename":"tests/<name>.spec.ts","code":"<full TypeScript file>","explanation":"one line"}
The filename must live under tests/ and end with .spec.ts.`;

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    filename: { type: 'string' },
    code: { type: 'string' },
    explanation: { type: 'string' },
  },
  required: ['filename', 'code'],
};

app.post('/api/ai/generate', async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) return res.status(400).json({ ok: false, error: 'Empty prompt.' });
  try {
    const out = await gemini.generateJSON(`Scenario: ${prompt}`, {
      system: SPEC_SYSTEM,
      schema: SPEC_SCHEMA,
      maxOutputTokens: 8192,
    });
    if (!out.code) throw new Error('Gemini returned no code.');
    let filename = String(out.filename || 'tests/generated.spec.ts').replace(/\\/g, '/');
    if (!filename.startsWith('tests/')) filename = 'tests/' + path.basename(filename);
    if (!filename.endsWith('.spec.ts')) filename += '.spec.ts';
    res.json({ ok: true, filename, code: out.code, explanation: out.explanation ?? '' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai/save', (req, res) => {
  const filename = String(req.body?.filename ?? '').replace(/\\/g, '/');
  const code = String(req.body?.code ?? '');
  // Normalize with POSIX semantics so the check stays separator-agnostic on
  // Windows (path.normalize would turn "/" into "\" and break startsWith).
  const safe = path.posix.normalize(filename);
  if (!safe.startsWith('tests/') || !safe.endsWith('.spec.ts') || safe.includes('..')) {
    return res.status(400).json({ ok: false, error: 'Filename must be tests/*.spec.ts' });
  }
  try {
    writeFileSync(path.join(ROOT, safe), code, 'utf8');
    log(`Saved ${safe}`, 'meta');
    res.json({ ok: true, filename: safe });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai/explain', async (req, res) => {
  const title = String(req.body?.title ?? 'a test');
  const error = String(req.body?.error ?? '').slice(0, 4000);
  if (!error) return res.status(400).json({ ok: false, error: 'No error text provided.' });
  try {
    const answer = await gemini.generate(
      `A Playwright test failed.\nTest: ${title}\nError:\n${error}\n\n` +
        `Explain the likely cause in 2-3 sentences, then suggest a concrete fix ` +
        `(e.g. a better locator or wait). Be concise.`,
      { system: 'You are a senior Playwright engineer helping debug a failing test.' },
    );
    res.json({ ok: true, answer });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

let controlBusy = false;
app.post('/api/ai/control', async (req, res) => {
  const command = String(req.body?.command ?? '').trim();
  if (!command) return res.status(400).json({ ok: false, error: 'Empty command.' });
  if (controlBusy) return res.status(409).json({ ok: false, error: 'A control run is already active.' });
  if (!(await cdpStatus())) return res.status(400).json({ ok: false, error: 'Start Chrome first.' });

  controlBusy = true;
  res.json({ ok: true }); // run asynchronously; progress streams over WS
  try {
    broadcast({ channel: 'ai', kind: 'control', state: 'planning', command });
    log(`AI control: ${command}`, 'meta');
    const steps = await planFromCommand(command);
    broadcast({ channel: 'ai', kind: 'control', state: 'plan', steps });
    const result = await runPlan(steps, (update) => {
      broadcast({ channel: 'ai', kind: 'control', state: 'step', update });
      log(`  [${update.status}] ${update.text}${update.error ? ' — ' + update.error : ''}`, update.status === 'failed' ? 'stderr' : 'meta');
    });
    broadcast({ channel: 'ai', kind: 'control', state: 'done', result });
    log(`AI control finished at ${result.url}`, 'meta');
  } catch (err) {
    broadcast({ channel: 'ai', kind: 'control', state: 'error', error: err.message });
    log(`AI control error: ${err.message}`, 'stderr');
  } finally {
    controlBusy = false;
  }
});

// ---- AIO Tests import --------------------------------------------------------
app.get('/api/aio/status', (_req, res) => {
  res.json({ configured: aio.isConfigured(), baseUrl: process.env.AIO_BASE_URL || 'https://tcms.aiojiraapps.com/aio-tcms/api/v1' });
});

// Preview: folders in a project with their case counts.
app.get('/api/aio/folders/:projectKey', async (req, res) => {
  try {
    const key = req.params.projectKey;
    const [map, cases] = await Promise.all([aio.folderPathMap(key), aio.listCases(key)]);
    const counts = {};
    for (const c of cases) {
      const path = c.folder ? map[c.folder.ID] || c.folder.name : '(no folder)';
      counts[path] = (counts[path] || 0) + 1;
    }
    const folders = Object.entries(counts).map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
    res.json({ ok: true, total: cases.length, folders });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Matches a folder path against a query by full segment-run (so "Request send
// Page" matches "Client portal/…/Request send Page" and a mid folder matches its
// whole subtree). Empty query = match everything.
const folderMatch = (path, query) => !query || ('/' + String(path) + '/').includes('/' + query + '/');

// Fetch (live, not stored) the test cases in an AIO folder/subtree for display.
app.get('/api/aio/cases/:projectKey', async (req, res) => {
  try {
    const key = req.params.projectKey;
    const folderPath = String(req.query.folderPath || '').trim();
    const [map, cases] = await Promise.all([aio.folderPathMap(key), aio.listCases(key)]);
    let out = cases.map((c) => ({ key: c.key, title: c.title, folder: c.folder ? map[c.folder.ID] || c.folder.name : '' }));
    if (folderPath) out = out.filter((c) => folderMatch(c.folder, folderPath));
    res.json({ ok: true, cases: out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Steps of a single AIO case — for the dashboard step-preview (clicking a case key).
// These are the SAME steps the run feeds to the AI, so the preview reflects reality.
app.get('/api/aio/case/:projectKey/:caseKey', async (req, res) => {
  try {
    const { projectKey, caseKey } = req.params;
    const detail = await aio.getDetail(projectKey, caseKey);
    const steps = (Array.isArray(detail.steps) ? detail.steps : []).map((s) => ({
      step: aio.stripHtml(s.step || ''),
      data: aio.stripHtml(s.data || s.testData || ''),
      expected: aio.stripHtml(s.expectedResult || ''),
    }));
    res.json({ ok: true, title: detail.title || caseKey, steps });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Capture-flow profile (remembered country/bank/default document) — read/saved by the
// dashboard "Capture flow config" box, and used to run minimal capture cases.
app.get('/api/capture-profile', (_req, res) => res.json({ ok: true, profile: loadCaptureProfile() }));
app.post('/api/capture-profile', (req, res) => {
  const p = loadCaptureProfile();
  if (req.body?.country != null) p.country = String(req.body.country).trim() || p.country;
  if (req.body?.bank != null) p.bank = String(req.body.bank).trim() || p.bank;
  if (req.body?.document != null) p.defaultDocument = String(req.body.document).trim() || p.defaultDocument;
  res.json({ ok: true, profile: saveCaptureProfile(p) });
});

// Fetch an AIO folder's test cases and RUN them via the AI executor — nothing is
// saved to the registry; the combined result + bugs land in Run Results, tagged
// to the folder. `description` gives shared flow/test-data context to the AI.
let aioRunBusy = false;
app.post('/api/aio/run', async (req, res) => {
  const projectKey = String(req.body?.projectKey || '').trim();
  const folderPath = String(req.body?.folderPath || '').trim();
  const description = String(req.body?.description || '').trim();
  const baseUrl = String(req.body?.baseUrl || '').trim();
  const setup = String(req.body?.setup || '').trim(); // deterministic preamble to reach the screen
  // Optional subset of case keys to run (from the dashboard checkboxes). When omitted,
  // the whole folder runs (backwards-compatible).
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : null;
  if (!projectKey) return res.status(400).json({ ok: false, error: 'AIO project key is required.' });
  if (!aio.isConfigured()) return res.status(400).json({ ok: false, error: 'AIO is not configured (set AIO_API_KEY).' });
  if (!gemini.isConfigured()) return res.status(400).json({ ok: false, error: 'Gemini is not configured (set GEMINI_API_KEY).' });
  if (!(await cdpStatus())) return res.status(400).json({ ok: false, error: 'Start Chrome first.' });
  if (aioRunBusy || groupRunBusy || caseRunBusy) return res.status(409).json({ ok: false, error: 'A run is already in progress.' });

  aioRunBusy = true;
  res.json({ ok: true });

  const started = Date.now();
  const runId = `aio-${started}`;
  const group = `AIO: ${projectKey}${folderPath ? '/' + folderPath : ''}`;
  try {
    broadcast({ channel: 'grouprun', state: 'start', group, total: 0 });
    const map = await aio.folderPathMap(projectKey);
    let cases = await aio.listCases(projectKey);
    if (folderPath) cases = cases.filter((c) => folderMatch(c.folder ? map[c.folder.ID] || c.folder.name : '', folderPath));
    // Restrict to the selected case keys (preserving the selected order) when provided.
    if (ids && ids.length) {
      const want = new Set(ids);
      cases = cases.filter((c) => want.has(String(c.key)));
      cases.sort((a, b) => ids.indexOf(String(a.key)) - ids.indexOf(String(b.key)));
    }
    if (!cases.length) { broadcast({ channel: 'grouprun', state: 'error', group, error: ids ? 'None of the selected test cases were found.' : 'No test cases found for that folder.' }); aioRunBusy = false; return; }
    broadcast({ channel: 'grouprun', state: 'start', group, total: cases.length });
    log(`AIO run "${group}" — ${cases.length} case(s)`, 'meta');
    // Remembered capture-flow config; the "Capture flow config" box (explicit fields) and
    // the Flow field (Country:/Bank:/Document: lines) can set/override + persist it.
    let captureProfile = applyFlowOverrides(loadCaptureProfile(), description);
    const uiOv = {};
    if (req.body?.country) uiOv.country = String(req.body.country).trim();
    if (req.body?.bank) uiOv.bank = String(req.body.bank).trim();
    if (req.body?.document) uiOv.defaultDocument = String(req.body.document).trim();
    if (Object.keys(uiOv).length) captureProfile = saveCaptureProfile({ ...captureProfile, ...uiOv });

    const tests = [];
    // One shared CDP connection for the ENTIRE run — reconnecting per case deadlocks
    // once a flow leaves a native dialog open (see connectPage). The persistent page's
    // dialog handler stays live across all cases; the per-case setup preamble resets
    // it back to the target screen.
    const sharedSession = await connectPage();
    try {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      broadcast({ channel: 'grouprun', state: 'case', group, index: i, total: cases.length, title: c.title, status: 'running' });
      const shotName = `aio-${started}-${String(c.key).replace(/[^\w.-]/g, '_')}`;
      const shotDir = path.join(ROOT, 'test-results', shotName);
      let status = 'passed', error = null, failedStep = '', steps = [], expected = '';
      const t0 = Date.now();
      try {
        mkdirSync(shotDir, { recursive: true });
        const detail = await aio.getDetail(projectKey, c.key);
        const tc = aio.mapCase(detail, map, projectKey);
        expected = tc['Expected Result'] || '';
        const onStep = (u) => log(`  [${u.status}] ${(u.text || '').slice(0, 70)}${u.error ? ' — ' + u.error : ''}`, u.status === 'failed' ? 'stderr' : 'meta');
        const caseSteps = (Array.isArray(detail.steps) ? detail.steps : []).map((s) => ({
          step: aio.stripHtml(s.step || ''),
          data: aio.stripHtml(s.data || s.testData || ''),
          expected: aio.stripHtml(s.expectedResult || ''),
        }));
        // Route by the case's STEP-FLOW signature (not its key): any DIRO capture flow
        // (download/screenshot, any document) runs the reliable deterministic driver —
        // even a MINIMAL case (title/one step), filling shared values from the remembered
        // profile. Everything else uses the observe→act AI executor.
        const caseFolder = folderPath || (c.folder ? map[c.folder.ID] || c.folder.name : '');
        const cls = classifyCaptureFlow(caseSteps, { title: c.title, folder: caseFolder, profile: captureProfile });
        let result;
        if (cls) {
          log(`  (deterministic capture-flow: ${cls.variant}${cls.document ? ' / ' + cls.document : ''} | ${cls.country} / ${cls.bank})`, 'meta');
          result = await runCaptureFlowAuto(baseUrl, caseSteps, {
            page: sharedSession.page, shotDir, shotUrlBase: `/artifacts/${shotName}`, onStep,
            title: c.title, folder: caseFolder, profile: captureProfile,
          });
        } else {
          result = await runCaseAgent(caseSteps, {
            baseUrl, page: sharedSession.page, shotDir, shotUrlBase: `/artifacts/${shotName}`, onStep,
          });
        }
        steps = result.results;
        const fi = steps.findIndex((s) => s.status === 'failed');
        status = steps.length && fi === -1 ? 'passed' : 'failed';
        if (fi >= 0) { error = steps[fi].error; failedStep = fi + 1; }
      } catch (e) {
        status = 'failed';
        error = e.message;
      }
      // Always capture a final screenshot so every case has at least one.
      const finalShot = await captureFinalShot(sharedSession.page, shotDir, shotName);
      const shots = steps.map((s) => s.shot).filter(Boolean);
      if (finalShot) shots.push(finalShot);
      tests.push({
        id: c.key, title: `${c.key} — ${c.title}`, file: c.key, status,
        duration: Date.now() - t0, error, failedStep, expected,
        screenshots: shots, steps,
      });
      broadcast({ channel: 'grouprun', state: 'case', group, index: i, total: cases.length, title: c.title, status });
    }
    } finally {
      await sharedSession.browser.close().catch(() => {}); // disconnect only; leaves Chrome running
    }
    const passed = tests.filter((t) => t.status === 'passed').length;
    const run = { id: runId, startedAt: started, finishedAt: Date.now(), status: passed === tests.length ? 'passed' : 'failed', source: 'aio', group, tests };
    runs.unshift(run);
    runs = runs.slice(0, MAX_RUNS);
    saveRuns();
    const newBugs = bugs.fromRun(run);
    broadcast({ channel: 'grouprun', state: 'done', group, passed, failed: tests.length - passed, total: tests.length, runId });
    broadcast({ channel: 'results', updated: true });
    if (newBugs.length) broadcast({ channel: 'bugs', added: newBugs.length });
    log(`AIO run "${group}" → ${passed}/${tests.length} passed`, passed === tests.length ? 'meta' : 'stderr');
  } catch (err) {
    broadcast({ channel: 'grouprun', state: 'error', group, error: err.message });
    log(`AIO run error: ${err.message}`, 'stderr');
  } finally {
    aioRunBusy = false;
  }
});

wss.on('connection', async (ws) => {
  const chrome = await cdpStatus();
  ws.send(JSON.stringify({ channel: 'chrome', up: !!chrome }));
  ws.send(JSON.stringify({ channel: 'run', state: testProc ? 'started' : 'idle' }));
});

server.listen(PORT, () => {
  console.log(`\n  Playwright CDP dashboard → http://localhost:${PORT}\n`);
  console.log(`  CDP endpoint: ${CDP_ENDPOINT}`);
});
