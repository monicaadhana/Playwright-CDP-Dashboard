// AIO Tests for Jira (Cloud) REST client. Reads AIO_API_KEY from the environment.
// Base + auth confirmed against a live instance:
//   base: https://tcms.aiojiraapps.com/aio-tcms/api/v1
//   auth: Authorization: AioAuth <token>
const DEFAULT_BASE = 'https://tcms.aiojiraapps.com/aio-tcms/api/v1';

export const isConfigured = () => !!process.env.AIO_API_KEY;
const base = () => (process.env.AIO_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const headers = () => ({
  Authorization: 'AioAuth ' + process.env.AIO_API_KEY,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

async function aioGet(path) {
  if (!isConfigured()) throw new Error('AIO is not configured. Set AIO_API_KEY in .env.');
  const url = base() + path;
  const MAX = 4; // total attempts = MAX + 1
  let lastErr;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    let res = null;
    try { res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(25000) }); }
    catch (e) { lastErr = e; }
    if (res && res.ok) return res.json();
    // Retry transient failures: 429 (rate limit), 5xx, and network/timeout errors.
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX) {
      if (res) { const body = await res.text().catch(() => ''); throw new Error(`AIO ${res.status}: ${body.slice(0, 160)}`); }
      throw new Error(`AIO request failed after ${attempt + 1} attempt(s): ${lastErr?.message || 'unknown error'}`);
    }
    // Honor Retry-After (seconds) when present; else exponential backoff 2/4/8/16s (cap 30s).
    let waitMs = Math.min(1000 * 2 ** (attempt + 1), 30000);
    const ra = res && res.headers.get('retry-after');
    if (ra) { const s = parseInt(ra, 10); if (!Number.isNaN(s)) waitMs = Math.min(s * 1000, 30000); }
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export const stripHtml = (s) =>
  String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();

/** Folder hierarchy → { id: "Parent/Child/…" } path map. */
export async function folderPathMap(projectKey) {
  const folders = await aioGet(`/project/${encodeURIComponent(projectKey)}/testcase/folder`);
  const map = {};
  const walk = (nodes, prefix) => {
    for (const n of nodes || []) {
      const path = prefix ? `${prefix}/${n.name}` : n.name;
      map[n.ID] = path;
      if (n.children && n.children.length) walk(n.children, path);
    }
  };
  walk(Array.isArray(folders) ? folders : folders.items || [], '');
  return map;
}

/** All test cases in a project (paginated; steps NOT included here). */
export async function listCases(projectKey) {
  const out = [];
  let startAt = 0;
  for (let guard = 0; guard < 200; guard++) {
    const page = await aioGet(`/project/${encodeURIComponent(projectKey)}/testcase?startAt=${startAt}&maxResults=100`);
    out.push(...(page.items || []));
    if (page.isLast || !page.items || !page.items.length) break;
    startAt += page.items.length;
  }
  return out;
}

/** Full detail of one case (includes steps). */
export function getDetail(projectKey, caseKey) {
  return aioGet(`/project/${encodeURIComponent(projectKey)}/testcase/${encodeURIComponent(caseKey)}/detail`);
}

/** Verify the key works and report the project's case count. */
export async function health(projectKey) {
  if (!isConfigured()) return { ok: false, error: 'AIO_API_KEY not set' };
  try {
    const page = await aioGet(`/project/${encodeURIComponent(projectKey)}/testcase?startAt=0&maxResults=1`);
    return { ok: true, hasCases: (page.items || []).length > 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Map an AIO case detail to our registry schema. Folder = "<project>/<folderPath>". */
export function mapCase(detail, folderMap, projectKey) {
  const steps = Array.isArray(detail.steps) ? detail.steps : [];
  const folderPath = detail.folder ? folderMap[detail.folder.ID] || detail.folder.name : '';
  return {
    'Test Case ID': detail.key,
    'Test Case Name': detail.title || '',
    Folder: [projectKey, folderPath].filter(Boolean).join('/'),
    'Test Scenario': stripHtml(detail.description || ''),
    Priority: detail.priority?.name || '',
    Preconditions: stripHtml(detail.precondition || ''),
    'Test Steps': steps.map((s, i) => stripHtml(s.step || '')).filter(Boolean).map((t, i) => t).join('\n'),
    'Expected Result': steps.map((s) => stripHtml(s.expectedResult || '')).filter(Boolean).join('\n'),
    'Test Data': steps.map((s) => stripHtml(s.data || s.testData || '')).filter(Boolean).join('\n'),
    Tags: Array.isArray(detail.tags) ? detail.tags.map((t) => t.name || t).join(', ') : String(detail.tags || ''),
    'Automation Status': detail.automationStatus?.name || '',
    Owner: '',
    source: 'aio',
    aioKey: detail.key,
  };
}
