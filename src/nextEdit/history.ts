import { structuredPatch, type StructuredPatchHunk } from 'diff';

export interface DiffEntry {
  path: string;
  text: string;
}

export interface Snippet {
  path: string;
  text: string;
}

/** Diff budget: a larger change (a reformat, a generated file) is not worth blocking the extension host for. */
const MAX_EDIT_LENGTH = 500;
const DIFF_TIMEOUT_MS = 50;

/** Zero-context hunks, or `undefined` when the change exceeds the diff budget. */
function hunksOf(path: string, before: string, after: string): StructuredPatchHunk[] | undefined {
  // A missing final newline would add "\ No newline at end of file" lines and make a bare final-newline change an edit.
  // An empty text stays empty: "\n" would be one blank line.
  const norm = (s: string) => {
    const n = s.replace(/\r\n/g, '\n');
    return n === '' || n.endsWith('\n') ? n : n + '\n';
  };
  return structuredPatch(path, path, norm(before), norm(after), '', '', { context: 0, maxEditLength: MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS })?.hunks;
}

function render(path: string, hunks: StructuredPatchHunk[]): string {
  const out = [`--- ${path}`, `+++ ${path}`];
  for (const h of hunks) {
    // Standard numbering: an empty range names the line before it.
    const oldStart = h.oldLines === 0 ? h.oldStart - 1 : h.oldStart;
    const newStart = h.newLines === 0 ? h.newStart - 1 : h.newStart;
    out.push(`@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@`, ...h.lines);
  }
  return out.join('\n');
}

/** Zero-context unified diff of one file with 1-based line numbers, or `undefined` when the texts are equal or the change exceeds the diff budget. */
export function renderDiff(path: string, before: string, after: string): string | undefined {
  const hunks = hunksOf(path, before, after);
  return hunks === undefined || hunks.length === 0 ? undefined : render(path, hunks);
}

interface Entry {
  path: string;
  text: string;
  /** The file text the entry started from, so a follow-up edit on the same line can be re-rendered against it. */
  base: string;
  firstOldStart: number;
}

/** Rendered diffs of recent edits, one entry per commit; consecutive edits starting on the same line merge into one. */
export class EditHistory {
  private snapshots = new Map<string, string>();
  private list: Entry[] = [];
  private readonly maxEntries: number;

  constructor(o: { maxEntries?: number } = {}) {
    this.maxEntries = o.maxEntries ?? 5;
  }

  open(path: string, text: string): void {
    this.snapshots.set(path, text);
  }

  commit(path: string, text: string): void {
    const before = this.snapshots.get(path);
    this.snapshots.set(path, text);
    if (before === undefined) return;
    const hunks = hunksOf(path, before, text);
    // Too large to diff within the budget: no entry, and the next edit is diffed against the new text.
    if (hunks === undefined || hunks.length === 0) return;
    const last = this.list[this.list.length - 1];
    if (last && last.path === path && last.firstOldStart === hunks[0].oldStart) {
      const merged = hunksOf(path, last.base, text);
      // A merged diff over the budget leaves the older entry and adds this edit as its own.
      if (merged !== undefined) {
        this.list.pop();
        if (merged.length === 0) return; // the edits cancelled out
        this.list.push({ ...last, text: render(path, merged), firstOldStart: merged[0].oldStart });
        return;
      }
    }
    this.list.push({ path, text: render(path, hunks), base: before, firstOldStart: hunks[0].oldStart });
    if (this.list.length > this.maxEntries) this.list.splice(0, this.list.length - this.maxEntries);
  }

  close(path: string): void {
    this.snapshots.delete(path);
  }

  /** Drops the file's snapshot and its entries, e.g. when it may no longer be sent. */
  forget(path: string): void {
    this.snapshots.delete(path);
    this.list = this.list.filter((e) => e.path !== path);
  }

  clear(): void {
    this.snapshots.clear();
    this.list = [];
  }

  /** Oldest first. */
  entries(filter?: (path: string) => boolean): DiffEntry[] {
    return this.list.filter((e) => !filter || filter(e.path)).map((e) => ({ path: e.path, text: e.text }));
  }
}

/** The text around the cursor of the files visited most recently, one snippet per file, newest last. */
export class RecentSnippets {
  private snippets: Snippet[] = [];
  private readonly max: number;
  private readonly lines: number;

  constructor(o: { max?: number; lines?: number } = {}) {
    this.max = o.max ?? 5;
    this.lines = o.lines ?? 20;
  }

  add(path: string, lines: string[], centerLine: number): void {
    if (lines.length === 0) return;
    const size = Math.min(this.lines, lines.length);
    const start = Math.max(0, Math.min(centerLine - Math.floor(size / 2), lines.length - size));
    this.snippets = this.snippets.filter((s) => s.path !== path);
    this.snippets.push({ path, text: lines.slice(start, start + size).join('\n') });
    if (this.snippets.length > this.max) this.snippets.splice(0, this.snippets.length - this.max);
  }

  forget(path: string): void {
    this.snippets = this.snippets.filter((s) => s.path !== path);
  }

  clear(): void {
    this.snippets = [];
  }

  /** The newest snippets of other files that fit the budget, oldest first. */
  pick(excludePath: string, budgetChars: number): Snippet[] {
    let remaining = budgetChars;
    const out: Snippet[] = [];
    for (let i = this.snippets.length - 1; i >= 0; i--) {
      const s = this.snippets[i];
      if (s.path === excludePath || s.text.length > remaining) continue;
      remaining -= s.text.length;
      out.push(s);
    }
    return out.reverse();
  }
}
