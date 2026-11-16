// Turns the model's rewritten region into one line edit, drops trivial edits and decides how
// VS Code shows the rest. Pure: no `vscode` import. Positions are 0-based line/character
// (UTF-16 offsets, like VS Code); `docLines` is the document split on `\r?\n`.

/** Replace lines `[startLine, endLine)` with `newLines`; `startLine === endLine` inserts. */
export interface LineEdit {
  startLine: number;
  endLine: number;
  newLines: string[];
}

export interface Pos {
  line: number;
  character: number;
}

export type NextEditShow = { kind: 'ghost'; insertText: string } | { kind: 'edit'; start: Pos; end: Pos; text: string };

/** Trims common leading, then common trailing lines (never overlapping); undefined when equal. */
export function regionEdit(oldRegion: string[], newRegion: string[], regionStart: number): LineEdit | undefined {
  const shortest = Math.min(oldRegion.length, newRegion.length);
  let head = 0;
  while (head < shortest && oldRegion[head] === newRegion[head]) head++;
  let tail = 0;
  while (tail < shortest - head && oldRegion[oldRegion.length - 1 - tail] === newRegion[newRegion.length - 1 - tail]) tail++;
  const oldEnd = oldRegion.length - tail;
  const newEnd = newRegion.length - tail;
  if (oldEnd === head && newEnd === head) return undefined;
  return { startLine: regionStart + head, endLine: regionStart + oldEnd, newLines: newRegion.slice(head, newEnd) };
}

function significant(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l !== '');
}

/** True when old and new lines are equal after trimming each line and dropping blank lines. */
export function isTrivialEdit(e: LineEdit, docLines: string[]): boolean {
  const before = significant(docLines.slice(e.startLine, e.endLine));
  const after = significant(e.newLines);
  return before.length === after.length && before.every((l, i) => l === after[i]);
}

/** What was inserted when `next` equals `prev` with a non-empty text added at `offset`. */
function insertedAt(prev: string, next: string, offset: number): string | undefined {
  const suffix = prev.slice(offset);
  const insertedLength = next.length - prev.length;
  if (insertedLength <= 0) return undefined;
  if (!next.startsWith(prev.slice(0, offset)) || !next.endsWith(suffix)) return undefined;
  return next.slice(offset, offset + insertedLength);
}

export function classify(e: LineEdit, docLines: string[], cursor: Pos): NextEditShow {
  const { startLine: s, endLine: e2, newLines } = e;
  const c = cursor.line;

  // Widen to the cursor line when the edit starts on it, ends on it or starts right after it.
  if (s === c || e2 - 1 === c || s === c + 1) {
    const from = Math.min(s, c);
    const to = Math.max(e2, c + 1);
    const oldText = docLines.slice(from, to).join('\n');
    const newText = [...docLines.slice(from, s), ...newLines, ...docLines.slice(e2, to)].join('\n');
    const offset = docLines.slice(from, c).reduce((n, l) => n + l.length + 1, 0) + cursor.character;
    const inserted = insertedAt(oldText, newText, offset);
    if (inserted) return { kind: 'ghost', insertText: inserted };
  }

  const last = docLines.length - 1;
  const endOf = (line: number): Pos => ({ line, character: docLines[line].length });

  if (s === e2) {
    // Pure insertion.
    if (s > last) return { kind: 'edit', start: endOf(last), end: endOf(last), text: '\n' + newLines.join('\n') };
    const at = { line: s, character: 0 };
    return { kind: 'edit', start: at, end: at, text: newLines.join('\n') + '\n' };
  }
  if (newLines.length === 0) {
    // Pure deletion.
    if (e2 > last) {
      const start = s === 0 ? { line: 0, character: 0 } : endOf(s - 1);
      return { kind: 'edit', start, end: endOf(last), text: '' };
    }
    return { kind: 'edit', start: { line: s, character: 0 }, end: { line: e2, character: 0 }, text: '' };
  }
  return { kind: 'edit', start: { line: s, character: 0 }, end: endOf(e2 - 1), text: newLines.join('\n') };
}

/** Item text for the document's line ending. */
export function toItemText(text: string, eol: '\n' | '\r\n'): string {
  return text.replace(/\r?\n/g, eol);
}
