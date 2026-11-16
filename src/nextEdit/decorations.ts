// Plans the decoration preview of a Next Edit for editors without the proposed inline-edit API:
// which old characters to mark, which old lines are deleted, the text to show after changed
// lines, the hint on the cursor line and whether Tab first jumps to the edit. Pure: no `vscode`
// import; the planned lines come from the result, never from the live document.
import type { NextEditDisplay } from '../config/settings';
import type { LineEdit, NextEditShow, Pos } from './diff';

export interface DecorationPlan {
  /** Character ranges in the OLD document lines that the edit replaces. */
  removed: { line: number; start: number; end: number }[];
  /** Old lines the edit deletes outright. */
  deletedLines: number[];
  /** Text shown after the end of a line. */
  added: { line: number; text: string }[];
  /** A hint for the cursor line; `text` is '' when the hint was merged into an `added` entry. */
  hint: { line: number; text: string };
  /** True when Tab first moves the cursor to `target`. */
  jump: boolean;
  target: Pos;
}

const MAX_SHOWN = 80;
const HINT_SEPARATOR = '  ·  ';

/** How to show an answer: as a VS Code inline item, as decorations, or not at all. */
export function displayFor(show: NextEditShow, display: NextEditDisplay, native: boolean): 'item' | 'decorations' | 'drop' {
  if (show.kind === 'ghost') return 'item';
  if (display === 'decorations') return 'decorations';
  if (native) return 'item';
  return display === 'auto' ? 'decorations' : 'drop';
}

function cut(text: string): string {
  const chars = [...text.trimStart()]; // code points, so a surrogate pair is never split
  return chars.length > MAX_SHOWN ? chars.slice(0, MAX_SHOWN).join('') + '…' : chars.join('');
}

function moreLines(n: number): string {
  return n === 1 ? ' (+1 line)' : ` (+${n} lines)`;
}

export function decorationPlan(edit: LineEdit, docLines: string[], cursor: Pos): DecorationPlan {
  const { startLine, endLine, newLines } = edit;
  const lastLine = Math.max(docLines.length - 1, 0);
  const clamp = (line: number): number => Math.min(Math.max(line, 0), lastLine);
  const oldCount = endLine - startLine;
  const pairs = Math.min(oldCount, newLines.length);

  const removed: DecorationPlan['removed'] = [];
  const added: DecorationPlan['added'] = [];
  for (let i = 0; i < pairs; i++) {
    const line = startLine + i;
    const before = docLines[line] ?? '';
    const after = newLines[i];
    if (before === after) continue;
    const shortest = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < shortest && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    if (before.length - suffix > prefix) {
      removed.push({ line, start: prefix, end: before.length - suffix });
    } else if (before.length > 0) {
      // Text is only inserted into the line: mark the character next to the insertion point
      // (the one before it, else the first) so the line still shows where it changes.
      const start = prefix > 0 ? prefix - 1 : 0;
      removed.push({ line, start, end: start + 1 });
    }
    added.push({ line, text: '→ ' + cut(after) });
  }

  const deletedLines: number[] = [];
  for (let line = startLine + pairs; line < endLine; line++) deletedLines.push(line);

  const extra = newLines.length - pairs;
  if (extra > 0) {
    const last = added[added.length - 1];
    if (last) {
      last.text += moreLines(extra);
    } else {
      const anchor = oldCount > 0 ? endLine - 1 : startLine - 1;
      added.push({ line: clamp(anchor), text: '+ ' + cut(newLines[pairs]) + (extra > 1 ? moreLines(extra) : '') });
    }
  }

  const jump = cursor.line < startLine - 1 || cursor.line > Math.max(endLine, startLine);
  const targetLine = clamp(startLine);
  const targetText = docLines[targetLine] ?? '';
  const firstNonBlank = targetText.search(/\S/);
  const target: Pos = { line: targetLine, character: firstNonBlank === -1 ? targetText.length : firstNonBlank };

  const hintText = jump ? `Next edit at line ${targetLine + 1} · Tab to jump · Esc to dismiss` : 'Tab to apply · Esc to dismiss';
  const sameLine = added.find((a) => a.line === cursor.line);
  let hint: DecorationPlan['hint'];
  if (sameLine) {
    sameLine.text += HINT_SEPARATOR + hintText;
    hint = { line: cursor.line, text: '' };
  } else {
    hint = { line: cursor.line, text: hintText };
  }

  return { removed, deletedLines, added, hint, jump, target };
}
