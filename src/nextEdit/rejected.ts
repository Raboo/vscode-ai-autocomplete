// Remembers rejected Next Edits so the identical edit is not shown again while the text around it is unchanged.
// Pure: no `vscode` import.
import type { LineEdit } from './diff';

/** Lines of old text kept above and below the edit's range. */
const CONTEXT_LINES = 2;
/** Entries kept per document. */
const MAX_PER_DOCUMENT = 5;

interface Entry {
  edit: LineEdit;
  /** The document's lines from `from` on: the edit's old lines and CONTEXT_LINES around them. */
  from: number;
  old: string[];
}

function snapshot(edit: LineEdit, docLines: string[]): Entry {
  const from = Math.max(0, edit.startLine - CONTEXT_LINES);
  return { edit, from, old: docLines.slice(from, edit.endLine + CONTEXT_LINES) };
}

function unchanged(e: Entry, docLines: string[]): boolean {
  const now = docLines.slice(e.from, e.from + e.old.length);
  return now.length === e.old.length && now.every((l, i) => l === e.old[i]);
}

function sameEdit(a: LineEdit, b: LineEdit): boolean {
  return a.startLine === b.startLine && a.endLine === b.endLine && a.newLines.length === b.newLines.length && a.newLines.every((l, i) => l === b.newLines[i]);
}

export class RejectedEdits {
  private readonly byUri = new Map<string, Entry[]>();

  /** `docLines` are the document's lines the edit was computed on. */
  remember(uri: string, edit: LineEdit, docLines: string[]): void {
    const entries = (this.byUri.get(uri) ?? []).filter((e) => !sameEdit(e.edit, edit));
    entries.push(snapshot(edit, docLines));
    this.byUri.set(uri, entries.slice(-MAX_PER_DOCUMENT));
  }

  /** True when this identical edit was rejected and the text around its range is unchanged. */
  isRejected(uri: string, edit: LineEdit, docLines: string[]): boolean {
    return (this.byUri.get(uri) ?? []).some((e) => sameEdit(e.edit, edit) && unchanged(e, docLines));
  }

  /** Forgets the entries whose surrounding text changed. A cursor move does not call this. */
  prune(uri: string, docLines: string[]): void {
    const entries = this.byUri.get(uri);
    if (!entries) return;
    const kept = entries.filter((e) => unchanged(e, docLines));
    if (kept.length === 0) this.byUri.delete(uri);
    else this.byUri.set(uri, kept);
  }

  forget(uri: string): void {
    this.byUri.delete(uri);
  }
}
