// Minimal Jira Cloud REST client (v3) — Basic auth with email + API token.
// Reads JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN from the environment (.env).
const FIELDS = 'summary,description,issuetype,status,priority,labels,components';

function baseUrl() {
  const raw = String(process.env.JIRA_BASE_URL || '').trim();
  if (!raw) return '';
  // Accept a full URL (even a /browse/ISSUE link) and keep just the site origin.
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

export function isConfigured() {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

function authHeader() {
  const token = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

async function jiraGet(path) {
  if (!isConfigured()) throw new Error('Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in .env.');
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira ${res.status}: ${body.slice(0, 300) || res.statusText}`);
  }
  return res.json();
}

/** Recursively flatten Atlassian Document Format (ADF) into plain text. */
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  let out = '';
  if (node.type === 'text') out += node.text || '';
  if (node.type === 'hardBreak') out += '\n';
  if (Array.isArray(node.content)) {
    for (const child of node.content) out += adfToText(child);
    if (['paragraph', 'heading', 'listItem', 'blockquote'].includes(node.type)) out += '\n';
    if (['bulletList', 'orderedList'].includes(node.type)) out += '\n';
  }
  return out;
}

/** Fetch and normalize a single issue (story). */
export async function getIssue(key) {
  const data = await jiraGet(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS}`);
  const f = data.fields || {};
  const description = typeof f.description === 'string' ? f.description : adfToText(f.description).trim();
  return {
    key: data.key,
    summary: f.summary || '',
    description,
    type: f.issuetype?.name || '',
    status: f.status?.name || '',
    priority: f.priority?.name || '',
    labels: f.labels || [],
    components: (f.components || []).map((c) => c.name),
    url: `${baseUrl()}/browse/${data.key}`,
  };
}

/** Verify credentials by fetching the current user. */
export async function health() {
  if (!isConfigured()) return { ok: false, error: 'Jira not configured' };
  try {
    const me = await jiraGet('/rest/api/3/myself');
    return { ok: true, user: me.displayName, baseUrl: baseUrl() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
