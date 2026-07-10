// Test Case Registry: JSON-backed store of structured (manual/imported) test
// cases plus Excel-import validation.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  mapRow,
  missingColumns,
  classifyHeaders,
  ALLOWED_PRIORITY,
  ALLOWED_AUTOMATION_STATUS,
} from './excel.mjs';

/** Apply upload "additional information": fill empty fields, append tags. */
function applyDefaults(tc, d = {}) {
  const fill = (field, val) => { if (val && !tc[field]) tc[field] = val; };
  fill('Folder', d.Folder);
  fill('Module', d.Module);
  fill('Feature', d.Feature);
  fill('Priority', d.Priority);
  fill('Automation Status', d['Automation Status']);
  fill('Owner', d.Owner);
  if (d.Tags) tc.Tags = [tc.Tags, d.Tags].filter(Boolean).join(', ');
}

export class Registry {
  constructor(file) {
    this.file = file;
    this.cases = [];
    this.folderPaths = []; // explicit folders (so empty folders can exist)
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(raw)) {
          this.cases = raw; // legacy format: bare array of cases
        } else {
          this.cases = raw.cases || [];
          this.folderPaths = raw.folderPaths || [];
        }
      }
    } catch {
      this.cases = [];
    }
  }

  save() {
    try {
      writeFileSync(this.file, JSON.stringify({ cases: this.cases, folderPaths: this.folderPaths }, null, 2), 'utf8');
    } catch {
      /* best effort */
    }
  }

  ids() {
    return new Set(this.cases.map((c) => String(c['Test Case ID']).toLowerCase()));
  }

  /**
   * All folder paths ("Project/Functionality/…"), union of explicit folders and
   * every ancestor of a path referenced by a case. Sorted.
   */
  folders() {
    const set = new Set(this.folderPaths.filter(Boolean));
    for (const c of this.cases) {
      const p = String(c.Folder || '').trim();
      if (!p) continue;
      // add the path and all its ancestors so parent nodes always exist
      const parts = p.split('/').map((s) => s.trim()).filter(Boolean);
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort();
  }

  /** Create an explicit (possibly empty) folder path. */
  addFolder(path) {
    const p = String(path || '').split('/').map((s) => s.trim()).filter(Boolean).join('/');
    if (p && !this.folderPaths.includes(p)) { this.folderPaths.push(p); this.save(); }
    return p;
  }

  /** True if `path` equals `prefix` or is nested under it. */
  static under(path, prefix) {
    return path === prefix || path.startsWith(prefix + '/');
  }

  /** Rename a folder and re-parent all descendant folders + cases. */
  renameFolder(from, to) {
    from = String(from).trim();
    to = String(to).trim();
    if (!to) return 0;
    let n = 0;
    const rewrite = (p) => (Registry.under(p, from) ? to + p.slice(from.length) : p);
    this.folderPaths = [...new Set(this.folderPaths.map(rewrite))];
    for (const c of this.cases) {
      const p = String(c.Folder || '');
      if (Registry.under(p, from)) { c.Folder = rewrite(p); n++; }
    }
    this.save();
    return n;
  }

  /** Delete a folder subtree and every test case under it. Returns cases removed. */
  deleteFolder(folder) {
    folder = String(folder).trim();
    this.folderPaths = this.folderPaths.filter((p) => !Registry.under(p, folder));
    const before = this.cases.length;
    this.cases = this.cases.filter((c) => !Registry.under(String(c.Folder || ''), folder));
    this.save();
    return before - this.cases.length;
  }

  /** List with optional search + field filters (priority, module, automationStatus, folder). */
  list({ search, priority, module, automationStatus, folder } = {}) {
    let out = this.cases;
    if (search) {
      const q = search.toLowerCase();
      out = out.filter((c) =>
        [c['Test Case ID'], c['Test Case Name'], c.Module, c.Feature, c.Tags, c.Owner, c.Folder]
          .some((v) => String(v ?? '').toLowerCase().includes(q)),
      );
    }
    if (priority) out = out.filter((c) => String(c.Priority).toLowerCase() === priority.toLowerCase());
    if (module) out = out.filter((c) => String(c.Module).toLowerCase() === module.toLowerCase());
    if (folder) {
      const f = String(folder);
      out = out.filter((c) => Registry.under(String(c.Folder || ''), f));
    }
    if (automationStatus)
      out = out.filter((c) => String(c['Automation Status']).toLowerCase() === automationStatus.toLowerCase());
    return out;
  }

  get(id) {
    return this.cases.find((c) => String(c['Test Case ID']).toLowerCase() === String(id).toLowerCase());
  }

  upsert(tc) {
    const i = this.cases.findIndex(
      (c) => String(c['Test Case ID']).toLowerCase() === String(tc['Test Case ID']).toLowerCase(),
    );
    if (i >= 0) this.cases[i] = { ...this.cases[i], ...tc };
    else this.cases.push(tc);
    this.save();
    return this.get(tc['Test Case ID']);
  }

  remove(id) {
    const before = this.cases.length;
    this.cases = this.cases.filter((c) => String(c['Test Case ID']).toLowerCase() !== String(id).toLowerCase());
    this.save();
    return this.cases.length < before;
  }

  /** Set the folder on many cases at once. Returns count moved. */
  moveMany(ids, folder) {
    const set = new Set(ids.map((s) => String(s).toLowerCase()));
    let n = 0;
    for (const c of this.cases) {
      if (set.has(String(c['Test Case ID']).toLowerCase())) { c.Folder = folder; n++; }
    }
    this.save();
    return n;
  }

  removeMany(ids) {
    const set = new Set(ids.map((s) => String(s).toLowerCase()));
    const before = this.cases.length;
    this.cases = this.cases.filter((c) => !set.has(String(c['Test Case ID']).toLowerCase()));
    this.save();
    return before - this.cases.length;
  }

  /**
   * Validate + import parsed rows, invoking onProgress(done, total) as it goes.
   * Returns { columnError, processed, imported, failed:[{row, id, reason}] }.
   */
  import(headers, rows, onProgress, defaults = {}) {
    const columns = classifyHeaders(headers);
    const missing = missingColumns(headers);
    if (missing.length) {
      return {
        columnError: `Missing mandatory column(s): ${missing.join(', ')}`,
        processed: 0, imported: 0, failed: [], columns,
      };
    }

    const existing = this.ids();
    const seenInFile = new Set();
    const failed = [];
    let imported = 0;
    const total = rows.length;

    rows.forEach((raw, i) => {
      const rowNo = i + 2; // +1 header, +1 to 1-index
      const tc = mapRow(raw);
      const id = tc['Test Case ID'];
      const reasons = [];

      if (!id) reasons.push('Empty Test Case ID');
      if (!tc['Test Case Name']) reasons.push('Empty Test Case Name');
      if (id && seenInFile.has(id.toLowerCase())) reasons.push(`Duplicate Test Case ID in file: ${id}`);
      if (id && existing.has(id.toLowerCase())) reasons.push(`Test Case ID already exists: ${id}`);
      if (tc.Priority && !ALLOWED_PRIORITY.includes(tc.Priority.toLowerCase()))
        reasons.push(`Invalid Priority "${tc.Priority}" (allowed: Critical/High/Medium/Low)`);
      if (tc['Automation Status'] && !ALLOWED_AUTOMATION_STATUS.includes(tc['Automation Status'].toLowerCase()))
        reasons.push(`Invalid Automation Status "${tc['Automation Status']}"`);

      if (reasons.length) {
        failed.push({ row: rowNo, id: id || '(blank)', reason: reasons.join('; ') });
      } else {
        applyDefaults(tc, defaults);
        tc.source = 'import';
        tc.importedAt = new Date().toISOString();
        this.cases.push(tc);
        existing.add(id.toLowerCase());
        seenInFile.add(id.toLowerCase());
        imported++;
      }
      if (onProgress && (i % 50 === 0 || i === total - 1)) onProgress(i + 1, total);
    });

    this.save();
    return { columnError: null, processed: total, imported, failed, columns };
  }
}
