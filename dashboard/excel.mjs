// Excel parsing (SheetJS, reads .xls + .xlsx) and formatted writing (ExcelJS).
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Canonical registry columns, in template order. */
export const REGISTRY_COLUMNS = [
  'Test Case ID',
  'Test Case Name',
  'Folder',
  'Module',
  'Feature',
  'Test Scenario',
  'Priority',
  'Preconditions',
  'Test Steps',
  'Test Data',
  'Expected Result',
  'Actual Result',
  'Tags',
  'Automation Status',
  'Owner',
];
export const REQUIRED_COLUMNS = ['Test Case ID', 'Test Case Name'];

// Accepted header spellings → canonical field. Everything is compared normalized
// (lower-case, collapsed spaces), so casing/spacing differences don't matter.
export const COLUMN_ALIASES = {
  'Test Case ID': ['test case id', 'testcase id', 'test case', 'tc id', 'id', 'test id', 'case id', 'key'],
  'Test Case Name': ['test case name', 'testcase name', 'test case title', 'name', 'title', 'test name', 'summary'],
  'Test Scenario': ['test scenario', 'scenario', 'test scenarios'],
  'Folder': ['folder', 'suite', 'test suite', 'path'],
  'Module': ['module', 'component'],
  'Feature': ['feature', 'features'],
  'Priority': ['priority', 'severity'],
  'Preconditions': ['preconditions', 'precondition', 'pre-conditions', 'pre condition', 'pre-condition'],
  'Test Steps': ['test steps', 'steps', 'step', 'test step', 'test case steps'],
  'Test Data': ['test data', 'data', 'testdata', 'input data'],
  'Expected Result': ['expected result', 'expected', 'expected results', 'expected outcome', 'expected output'],
  'Actual Result': ['actual result', 'actual', 'actual results', 'actual outcome', 'actual output'],
  'Tags': ['tags', 'tag', 'labels', 'label'],
  'Automation Status': ['automation status', 'automation', 'automated', 'automation state'],
  'Owner': ['owner', 'assignee', 'assigned to', 'author', 'created by'],
};
export const ALLOWED_PRIORITY = ['critical', 'high', 'medium', 'low'];
export const ALLOWED_AUTOMATION_STATUS = [
  'automated',
  'manual',
  'not automated',
  'in progress',
  'planned',
];

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// normalized alias → canonical field, built once from COLUMN_ALIASES.
const REVERSE_ALIAS = (() => {
  const m = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    m[norm(field)] = field;
    for (const a of aliases) m[norm(a)] = field;
  }
  return m;
})();

/** Resolve a raw header to a canonical field, or null if unrecognized. */
export function canonicalField(header) {
  return REVERSE_ALIAS[norm(header)] ?? null;
}

/** Split uploaded headers into recognized (with target field) and ignored. */
export function classifyHeaders(headers) {
  const recognized = [];
  const ignored = [];
  for (const h of headers) {
    const f = canonicalField(h);
    if (f) recognized.push({ header: h, field: f });
    else ignored.push(h);
  }
  return { recognized, ignored };
}

/** Read the first worksheet of an .xls/.xlsx buffer into { headers, rows }. */
export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

/** Map a raw row (any accepted header spelling) to canonical registry fields. */
export function mapRow(rawRow) {
  const out = {};
  for (const col of REGISTRY_COLUMNS) out[col] = '';
  for (const key of Object.keys(rawRow)) {
    const field = canonicalField(key);
    if (field && !out[field]) out[field] = String(rawRow[key] ?? '').trim();
  }
  return out;
}

/** Which required columns are absent (checking all accepted aliases). */
export function missingColumns(headers) {
  const present = new Set(headers.map(norm));
  return REQUIRED_COLUMNS.filter(
    (col) => !(COLUMN_ALIASES[col] || [norm(col)]).some((a) => present.has(norm(a))),
  );
}

// ---- Formatted writers (ExcelJS) -------------------------------------------
function styleHeader(ws) {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
function autosize(ws) {
  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const len = String(cell.value ?? '').length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 60);
  });
}
async function toBuffer(wb) {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Empty import template with one example row + dropdown validation. */
export async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Test Cases');
  ws.columns = REGISTRY_COLUMNS.map((c) => ({ header: c, key: c }));
  ws.addRow({
    'Test Case ID': 'TC-001',
    'Test Case Name': 'Login with valid credentials',
    Module: 'Auth',
    Feature: 'Login',
    Priority: 'High',
    Preconditions: 'User account exists',
    'Test Steps': '1. Open login page\n2. Enter email\n3. Enter password\n4. Click Sign In',
    'Expected Result': 'User is redirected to the dashboard',
    'Test Data': 'email=user@example.com; password=Secret1!',
    Tags: 'smoke, regression',
    'Automation Status': 'Manual',
    Owner: 'monica',
  });
  styleHeader(ws);
  autosize(ws);
  // Dropdowns for Priority (col E) and Automation Status (col K) on rows 2..500.
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`E${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"Critical,High,Medium,Low"'],
    };
    ws.getCell(`K${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"Automated,Manual,Not Automated,In Progress,Planned"'],
    };
  }
  return toBuffer(wb);
}

/** Registry test cases → formatted xlsx. */
export async function buildRegistryExport(cases) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Test Cases');
  ws.columns = REGISTRY_COLUMNS.map((c) => ({ header: c, key: c }));
  for (const tc of cases) ws.addRow(REGISTRY_COLUMNS.reduce((o, c) => ((o[c] = tc[c] ?? ''), o), {}));
  styleHeader(ws);
  autosize(ws);
  return toBuffer(wb);
}

const BUG_COLUMNS = [
  'Bug ID', 'Test Case ID', 'Test Case Name', 'Execution Date',
  'Status', 'Bug Title', 'Description',
  'Expected Result', 'Actual Result', 'Screenshot Reference',
];

/**
 * Bug records → formatted xlsx (bold/frozen header, autosized).
 * The screenshot is EMBEDDED into the sheet as an image, so it opens from a downloaded
 * file (and old sheets) with no server needed. `opts.artifactsDir` is where the on-disk
 * screenshots live (…/test-results); `opts.origin` adds a fallback clickable URL.
 * Resolve a stored "/artifacts/<name>/<file>.png" reference to its file on disk.
 */
function shotDiskPath(artifactsDir, rel) {
  if (!artifactsDir || !rel || /^https?:\/\//i.test(rel)) return null;
  const sub = rel.replace(/^\/?artifacts\//i, '').replace(/^\/+/, '');
  const p = path.join(artifactsDir, sub);
  return existsSync(p) ? p : null;
}
export async function buildBugReport(bugs, opts = {}) {
  const origin = String(opts.origin || '').replace(/\/$/, '');
  const artifactsDir = opts.artifactsDir || '';
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Bugs');
  ws.columns = BUG_COLUMNS.map((c) => ({ header: c, key: c }));
  const shotCol = BUG_COLUMNS.indexOf('Screenshot Reference') + 1;
  autosize(ws); // size text columns from header/typical width before we widen the shot column
  ws.getColumn(shotCol).width = 70; // room for the embedded image
  const IMG_W = 460, IMG_H = 210; // px thumbnail (DIRO screenshots are ~2.2:1)
  for (const b of bugs) {
    const added = ws.addRow(BUG_COLUMNS.reduce((o, c) => ((o[c] = b[c] ?? ''), o), {}));
    const rel = String(b['Screenshot Reference'] ?? '').trim();
    if (!rel) continue;
    const url = /^https?:\/\//i.test(rel) ? rel : origin + (rel.startsWith('/') ? rel : '/' + rel);
    const cell = added.getCell(shotCol);
    // Keep the URL as a fallback clickable link (works when the dashboard is running).
    cell.value = { text: 'Open full screenshot ↗', hyperlink: url };
    cell.font = { color: { argb: 'FF0563C1' }, underline: true };
    cell.alignment = { vertical: 'top' };
    // Embed the image itself so it's viewable offline / from the downloaded file.
    const disk = shotDiskPath(artifactsDir, rel);
    if (disk) {
      try {
        const imgId = wb.addImage({ buffer: readFileSync(disk), extension: 'png' });
        added.height = IMG_H * 0.78; // pt ≈ px*0.75, +a little for the link line
        ws.addImage(imgId, {
          tl: { col: shotCol - 1, row: added.number - 1 + 0.18 }, // just below the link text
          ext: { width: IMG_W, height: IMG_H },
          editAs: 'oneCell',
        });
      } catch { /* unreadable image — keep just the link */ }
    }
  }
  styleHeader(ws);
  return toBuffer(wb);
}

const RESULT_COLUMNS = [
  'Run ID', 'Started', 'Finished', 'Run Status', 'Test Case', 'File',
  'Status', 'Duration (ms)', 'Error', 'Screenshot',
];

/** Flattened run results → formatted xlsx. */
export async function buildTestResults(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Test Results');
  ws.columns = RESULT_COLUMNS.map((c) => ({ header: c, key: c }));
  for (const r of rows) ws.addRow(RESULT_COLUMNS.reduce((o, c) => ((o[c] = r[c] ?? ''), o), {}));
  styleHeader(ws);
  autosize(ws);
  return toBuffer(wb);
}
