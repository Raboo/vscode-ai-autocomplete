import { structuredPatch, type StructuredPatchHunk } from 'diff';
import type { ContextFile } from '../types';
import type { LineSpan } from './region';

/** One zero-context change. The starts are 0-based line indexes where the change begins in the old and new text; an empty side marks where lines would go. */
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export interface DiffEntry {
  path: string;
  text: string;
  hunks: DiffHunk[];
  /** The change with 3 context lines and real hunk headers, without the `---`/`+++` lines (Zeta 2.1's history format). */
  contextText: string;
}

export interface Snippet {
  path: string;
  text: string;
}

/** Diff budget: a larger change (a reformat, a generated file) is not worth blocking the extension host for. */
const MAX_EDIT_LENGTH = 500;
const DIFF_TIMEOUT_MS = 50;

// A missing final newline would add "\ No newline at end of file" lines and make a bare final-newline change an edit.
// An empty text stays empty: "\n" would be one blank line.
function norm(s: string): string {
  const n = s.replace(/\r\n/g, '\n');
  return n === '' || n.endsWith('\n') ? n : n + '\n';
}

/** Zero-context hunks, or `undefined` when the change exceeds the diff budget. */
function hunksOf(path: string, before: string, after: string): StructuredPatchHunk[] | undefined {
  return structuredPatch(path, path, norm(before), norm(after), '', '', { context: 0, maxEditLength: MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS })?.hunks;
}

/** The 3-context hunk text for the base-to-after change; the zero-context text (minus its file headers) when the diff exceeds the budget. */
export function contextTextOf(path: string, before: string, after: string, zeroText: string): string {
  const hunks = structuredPatch(path, path, norm(before), norm(after), '', '', { context: 3, maxEditLength: MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS })?.hunks;
  return withoutFileHeader(hunks === undefined || hunks.length === 0 ? zeroText : render(path, hunks));
}

/** A rendered diff without its two `---`/`+++` lines. */
export function withoutFileHeader(diff: string): string {
  return diff.split('\n').slice(2).join('\n');
}

function toDiffHunks(hunks: StructuredPatchHunk[]): DiffHunk[] {
  return hunks.map((h) => ({
    // jsdiff's 1-based start of an empty side already names the line where lines would go, so minus 1 is right for both cases.
    oldStart: h.oldStart - 1,
    newStart: h.newStart - 1,
    oldLines: h.lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1)),
    newLines: h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)),
  }));
}

function linesOf(text: string): string[] {
  const n = norm(text);
  return n === '' ? [] : n.slice(0, -1).split('\n');
}

/** Maps a span of the new text to the old text. A bound inside a hunk's new lines expands to the hunk's whole old range, so a span that lies wholly inside a pure insertion comes back empty (`end` = `start` - 1). */
export function spanBefore(hunks: DiffHunk[], span: LineSpan): LineSpan {
  const map = (line: number, isStart: boolean): number => {
    let offset = 0;
    for (const h of hunks) {
      if (line < h.newStart) break;
      if (line < h.newStart + h.newLines.length) return isStart ? h.oldStart : h.oldStart + h.oldLines.length - 1;
      offset += h.oldLines.length - h.newLines.length;
    }
    return line + offset;
  };
  return { start: map(span.start, true), end: map(span.end, false) };
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

/** The path of the recent-edits entry in completion extra context. */
export const RECENT_EDITS_PATH = 'recent-edits.diff';

function hunkHeader(h: DiffHunk): string {
  // Standard numbering, 1-based: an empty range names the line before it.
  const oldStart = h.oldLines.length === 0 ? h.oldStart : h.oldStart + 1;
  const newStart = h.newLines.length === 0 ? h.newStart : h.newStart + 1;
  return `@@ -${oldStart},${h.oldLines.length} +${newStart},${h.newLines.length} @@`;
}

/**
 * The last `maxHunks` hunks of the entries (oldest first) as one unified diff, newest last, for completion extra context.
 * The oldest hunks are dropped until it fits `maxChars`; `undefined` when there are no edits or none fits.
 */
export function recentEditsFile(entries: DiffEntry[], maxHunks: number, maxChars: number): ContextFile | undefined {
  const all = entries.flatMap((e, entry) => e.hunks.map((hunk) => ({ entry, path: e.path, hunk })));
  for (let n = Math.min(maxHunks, all.length); n > 0; n--) {
    const out: string[] = [];
    let current = -1;
    for (const { entry, path, hunk } of all.slice(all.length - n)) {
      // Each entry's hunks are numbered against that entry's own base text, so every entry gets its own file header.
      if (entry !== current) out.push(`--- ${path}`, `+++ ${path}`);
      current = entry;
      out.push(hunkHeader(hunk), ...hunk.oldLines.map((l) => `-${l}`), ...hunk.newLines.map((l) => `+${l}`));
    }
    const text = out.join('\n');
    if (text.length <= maxChars) return { path: RECENT_EDITS_PATH, text };
  }
  return undefined;
}

interface Entry {
  path: string;
  text: string;
  hunks: DiffHunk[];
  /** The file text the entry started from, so a follow-up edit on the same line can be re-rendered against it. */
  base: string;
  /** The 3-context hunk text, computed once when the entry is recorded. */
  contextText: string;
  firstOldStart: number;
}

/** Rendered diffs of recent edits, one entry per commit; consecutive edits starting on the same line merge into one. */
export class EditHistory {
  private snapshots = new Map<string, string>();
  private list: Entry[] = [];
  /** Paths whose latest commit recorded no entry, so their newest entry no longer describes the current text. */
  private stale = new Set<string>();
  maxEntries: number;

  constructor(o: { maxEntries?: number } = {}) {
    this.maxEntries = o.maxEntries ?? 5;
  }

  open(path: string, text: string): void {
    this.snapshots.set(path, text);
  }

  commit(path: string, text: string): void {
    this.record(path, text);
    if (this.list.length > this.maxEntries) this.list.splice(0, this.list.length - this.maxEntries);
  }

  private record(path: string, text: string): void {
    const before = this.snapshots.get(path);
    this.snapshots.set(path, text);
    if (before === undefined) {
      this.stale.add(path);
      return;
    }
    const hunks = hunksOf(path, before, text);
    // Too large to diff within the budget: no entry, and the next edit is diffed against the new text.
    if (hunks === undefined) {
      this.stale.add(path);
      return;
    }
    if (hunks.length === 0) return;
    const last = this.list[this.list.length - 1];
    if (last && last.path === path && last.firstOldStart === hunks[0].oldStart) {
      const merged = hunksOf(path, last.base, text);
      // A merged diff over the budget leaves the older entry and adds this edit as its own.
      if (merged !== undefined) {
        this.list.pop();
        if (merged.length === 0) {
          this.stale.add(path); // the edits cancelled out
          return;
        }
        const mergedText = render(path, merged);
        this.list.push({ ...last, text: mergedText, contextText: contextTextOf(path, last.base, text, mergedText), hunks: toDiffHunks(merged), firstOldStart: merged[0].oldStart });
        this.stale.delete(path);
        return;
      }
    }
    const rendered = render(path, hunks);
    this.list.push({ path, text: rendered, contextText: contextTextOf(path, before, text, rendered), hunks: toDiffHunks(hunks), base: before, firstOldStart: hunks[0].oldStart });
    this.stale.delete(path);
  }

  close(path: string): void {
    this.snapshots.delete(path);
  }

  /** Drops the file's snapshot and its entries, e.g. when it may no longer be sent. */
  forget(path: string): void {
    this.snapshots.delete(path);
    this.stale.delete(path);
    this.list = this.list.filter((e) => e.path !== path);
  }

  clear(): void {
    this.snapshots.clear();
    this.stale.clear();
    this.list = [];
  }

  /** Oldest first. */
  entries(filter?: (path: string) => boolean): DiffEntry[] {
    return this.list.filter((e) => !filter || filter(e.path)).map((e) => ({ path: e.path, text: e.text, hunks: e.hunks, contextText: e.contextText }));
  }

  /** The file before the change its newest entry records, as lines, with that entry's hunks. `undefined` when the path has no entry or a later commit of it recorded none. */
  previous(path: string): { lines: string[]; hunks: DiffHunk[] } | undefined {
    if (this.stale.has(path)) return undefined;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.path === path) return { lines: linesOf(e.base), hunks: e.hunks };
    }
    return undefined;
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
    const text = lines.slice(start, start + size).join('\n');
    this.snippets.push({ path, text: start + size < lines.length ? `${text}\n...` : text });
    if (this.snippets.length > this.max) this.snippets.splice(0, this.snippets.length - this.max);
  }

  forget(path: string): void {
    this.snippets = this.snippets.filter((s) => s.path !== path);
  }

  clear(): void {
    this.snippets = [];
  }

  /** The newest snippets of other files that fit the budget, oldest first; `alsoExclude` paths are left out before the budget is spent. */
  pick(excludePath: string, budgetChars: number, alsoExclude?: ReadonlySet<string>): Snippet[] {
    let remaining = budgetChars;
    const out: Snippet[] = [];
    for (let i = this.snippets.length - 1; i >= 0; i--) {
      const s = this.snippets[i];
      if (s.path === excludePath || alsoExclude?.has(s.path) || s.text.length > remaining) continue;
      remaining -= s.text.length;
      out.push(s);
    }
    return out.reverse();
  }
}
