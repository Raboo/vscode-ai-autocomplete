import { structuredPatch } from 'diff';

export interface DiffEntry {
  path: string;
  text: string;
}

export interface Snippet {
  path: string;
  text: string;
}

function hunksOf(path: string, before: string, after: string) {
  // A missing final newline would add "\ No newline at end of file" lines and make a bare final-newline change an edit.
  const norm = (s: string) => {
    const n = s.replace(/\r\n/g, '\n');
    return n.endsWith('\n') ? n : n + '\n';
  };
  return structuredPatch(path, path, norm(before), norm(after), '', '', { context: 0 }).hunks;
}

/** Zero-context unified diff of one file with 1-based line numbers, or `undefined` when the texts are equal. */
export function renderDiff(path: string, before: string, after: string): string | undefined {
  const hunks = hunksOf(path, before, after);
  if (hunks.length === 0) return undefined;
  const out = [`--- ${path}`, `+++ ${path}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines);
  }
  return out.join('\n');
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
    if (hunks.length === 0) return;
    const last = this.list[this.list.length - 1];
    if (last && last.path === path && last.firstOldStart === hunks[0].oldStart) {
      const merged = renderDiff(path, last.base, text);
      this.list.pop();
      if (merged === undefined) return; // the edits cancelled out
      this.list.push({ ...last, text: merged, firstOldStart: hunksOf(path, last.base, text)[0].oldStart });
      return;
    }
    this.list.push({ path, text: renderDiff(path, before, text) as string, base: before, firstOldStart: hunks[0].oldStart });
    if (this.list.length > this.maxEntries) this.list.splice(0, this.list.length - this.maxEntries);
  }

  close(path: string): void {
    this.snapshots.delete(path);
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
