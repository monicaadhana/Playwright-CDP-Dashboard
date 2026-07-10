// Bug store: bugs are derived from failed test cases in a run, one bug per
// failed test, and persisted so they can be filtered and exported to Excel.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SEVERITY_BY_STATUS = { timedOut: 'High', interrupted: 'High', failed: 'Medium' };

export class Bugs {
  constructor(file) {
    this.file = file;
    this.bugs = [];
    this.seq = 0;
    try {
      if (existsSync(file)) this.bugs = JSON.parse(readFileSync(file, 'utf8'));
      this.seq = this.bugs.length;
    } catch {
      this.bugs = [];
    }
  }

  save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.bugs, null, 2), 'utf8');
    } catch {
      /* best effort */
    }
  }

  nextId() {
    this.seq += 1;
    return `BUG-${String(this.seq).padStart(4, '0')}`;
  }

  /**
   * Create bug records for every failed test in a finished run.
   * @param run the run object from the results store
   * @param env { browser, os, device, environment }
   */
  fromRun(run, env = {}) {
    const created = [];
    const date = new Date(run.finishedAt ?? run.startedAt ?? Date.now()).toISOString();
    for (const t of run.tests) {
      if (!['failed', 'timedOut', 'interrupted'].includes(t.status)) continue;
      const bug = {
        'Bug ID': this.nextId(),
        'Test Case ID': t.file ? `${t.file}` : '',
        'Test Case Name': t.title,
        'Run ID': run.id,
        'Execution Date': date,
        Severity: SEVERITY_BY_STATUS[t.status] ?? 'Medium',
        Priority: t.status === 'timedOut' ? 'High' : 'Medium',
        Status: 'Open',
        'Bug Title': `${t.title} — ${t.status}`,
        Description: t.error ?? `Test ${t.status}`,
        'Failed Step Number': t.failedStep ?? '',
        'Expected Result': t.expected ?? '',
        'Actual Result': t.error ?? t.status,
        'Screenshot Reference': (t.screenshots && t.screenshots[0]) ?? '',
        Browser: env.browser ?? 'Chrome (CDP)',
        OS: env.os ?? process.platform,
        Device: env.device ?? 'Desktop',
        Environment: env.environment ?? 'CDP',
        'AI Confidence': t.aiConfidence ?? '',
        'Assigned To': '',
        Reporter: 'AI Runner',
        'Created Date': date,
        // internal fields for filtering (not exported as-is)
        _status: t.status,
      };
      this.bugs.unshift(bug);
      created.push(bug);
    }
    if (created.length) this.save();
    return created;
  }

  list({ severity, status, runId, search } = {}) {
    let out = this.bugs;
    if (severity) out = out.filter((b) => String(b.Severity).toLowerCase() === severity.toLowerCase());
    if (status) out = out.filter((b) => String(b.Status).toLowerCase() === status.toLowerCase());
    if (runId) out = out.filter((b) => String(b['Run ID']) === String(runId));
    if (search) {
      const q = search.toLowerCase();
      out = out.filter((b) =>
        [b['Bug ID'], b['Test Case Name'], b['Bug Title'], b.Description]
          .some((v) => String(v ?? '').toLowerCase().includes(q)),
      );
    }
    return out;
  }
}
