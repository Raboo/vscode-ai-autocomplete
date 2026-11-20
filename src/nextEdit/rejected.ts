// Remembers rejected Next Edits so the identical edit is not shown again while the text around it is unchanged.
// Pure: no `vscode` import.
import type { LineEdit } from './diff';

/** Lines of old text kept above and below the edit's range (fewer near the file's start or end). */
const CONTEXT_LINES = 2;
/** Entries kept per document. */
const MAX_PER_DOCUMENT = 5;

interface Entry {
  /** Up to CONTEXT_LINES lines above the range, the range's old lines, up to CONTEXT_LINES below, and the new lines. */
  before: string[];
  old: string[];
  after: string[];
  newLines: string[];
}

const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i]);

/** The content an edit is matched by: not its line numbers, so lines inserted above it do not matter. */
function snapshot(edit: LineEdit, docLines: string[]): Entry {
  return {
    before: docLines.slice(Math.max(0, edit.startLine - CONTEXT_LINES), edit.startLine),
    old: docLines.slice(edit.startLine, edit.endLine),
    after: docLines.slice(edit.endLine, edit.endLine + CONTEXT_LINES),
    newLines: edit.newLines,
  };
}

function sameContent(a: Entry, b: Entry): boolean {
  return same(a.newLines, b.newLines) && same(a.old, b.old) && same(a.before, b.before) && same(a.after, b.after);
}

/** Whether the entry's context (before, old, after) appears anywhere in the document. */
function appears(e: Entry, docLines: string[]): boolean {
  const block = [...e.before, ...e.old, ...e.after];
  if (block.length === 0) return true;
  for (let i = 0; i + block.length <= docLines.length; i++) {
    if (block.every((l, k) => docLines[i + k] === l)) return true;
  }
  return false;
}

export class RejectedEdits {
  private readonly byUri = new Map<string, Entry[]>();

  has(uri: string): boolean {
    return this.byUri.has(uri);
  }

  /** `docLines` are the document's lines the edit was computed on. */
  remember(uri: string, edit: LineEdit, docLines: string[]): void {
    const e = snapshot(edit, docLines);
    const entries = (this.byUri.get(uri) ?? []).filter((x) => !sameContent(x, e));
    entries.push(e);
    this.byUri.set(uri, entries.slice(-MAX_PER_DOCUMENT));
  }

  /** True when this identical edit (same old context, same new text, wherever it now sits) was rejected. */
  isRejected(uri: string, edit: LineEdit, docLines: string[]): boolean {
    const e = snapshot(edit, docLines);
    return (this.byUri.get(uri) ?? []).some((x) => sameContent(x, e));
  }

  /** Forgets the entries whose context no longer appears in the document. A cursor move does not call this. */
  prune(uri: string, docLines: string[]): void {
    const entries = this.byUri.get(uri);
    if (!entries) return;
    const kept = entries.filter((e) => appears(e, docLines));
    if (kept.length === 0) this.byUri.delete(uri);
    else this.byUri.set(uri, kept);
  }

  forget(uri: string): void {
    this.byUri.delete(uri);
  }
}
