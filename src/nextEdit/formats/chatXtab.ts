import type { ChatMessage } from '../../backends/types';
import { CHARS_PER_TOKEN } from '../../completion/effective';
import { CURSOR_MARKER, PIN_BACK_LINES } from '../../completion/holeFiller';
import type { DiffEntry, Snippet } from '../history';
import { clipAroundRegion, type LineSpan } from '../region';

export interface NextEditInput {
  path: string;
  lines: string[];
  cursor: { line: number; character: number };
  region: LineSpan;
  history: DiffEntry[];
  snippets: Snippet[];
}

export const CHAT_XTAB_SYSTEM = `You predict the next edit a developer will make in a code file.
You get: code the developer viewed recently (oldest first), the current file, the developer's recent edits as unified diffs (oldest first), and the code to edit, with the cursor marked ${CURSOR_MARKER}.
Rewrite the code between <|code_to_edit|> and <|/code_to_edit|> the way the developer would continue: finish what they started, and make the same change where it is still missing. Leave everything else exactly as it is, including indentation.
Answer with the rewritten code in one \`\`\` block, without the tags and without ${CURSOR_MARKER}. If nothing should change, answer NO_CHANGE.`;

export const FILE_BUDGET_CHARS = Math.round(1500 * CHARS_PER_TOKEN);
export const HISTORY_BUDGET_CHARS = Math.round(1000 * CHARS_PER_TOKEN);
export const SNIPPETS_BUDGET_CHARS = Math.round(1000 * CHARS_PER_TOKEN);

const OPEN_TAG = '<|code_to_edit|>';
const CLOSE_TAG = '<|/code_to_edit|>';

/** The newest entries whose texts and blank-line separators fit the budget, oldest first. */
function pickHistory(history: DiffEntry[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = history[i].text.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > HISTORY_BUDGET_CHARS) break;
    used += cost;
    kept.unshift(history[i].text);
  }
  return kept;
}

export function chatXtabMessages(i: NextEditInput, systemSuffix?: string): { messages: ChatMessage[]; stableChars: number } {
  const blocks: string[] = [];

  if (i.snippets.length > 0) {
    const items = i.snippets.map(
      (s) => `<|recently_viewed_code_snippet|>\ncode_snippet_file_path: ${s.path}\n${s.text}\n<|/recently_viewed_code_snippet|>`
    );
    blocks.push(`<|recently_viewed_code_snippets|>\n${items.join('\n')}\n<|/recently_viewed_code_snippets|>`);
  }

  const span = clipAroundRegion(i.lines, i.region, FILE_BUDGET_CHARS);
  const before = i.lines.slice(span.start, i.region.start);
  const fileHead = [`<|current_file_content|>`, `current_file_path: ${i.path}`, ...before];
  const fileLines = [
    ...fileHead,
    OPEN_TAG,
    ...i.lines.slice(i.region.start, i.region.end + 1),
    CLOSE_TAG,
    ...i.lines.slice(i.region.end + 1, span.end + 1),
    '<|/current_file_content|>'
  ];
  const prefix = blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
  blocks.push(fileLines.join('\n'));

  // The pin starts at the printed file line PIN_BACK_LINES above the region, or is 0 when there are fewer.
  let stableChars = 0;
  if (before.length >= PIN_BACK_LINES) {
    const head = prefix + fileHead.slice(0, fileHead.length - PIN_BACK_LINES).join('\n') + '\n';
    stableChars = /[\ud800-\udbff]/.test(head) ? [...head].length : head.length;
  }

  const history = pickHistory(i.history);
  if (history.length > 0) blocks.push(`<|edit_diff_history|>\n${history.join('\n\n')}\n<|/edit_diff_history|>`);

  const region = i.lines.slice(i.region.start, i.region.end + 1);
  const at = i.cursor.line - i.region.start;
  if (at >= 0 && at < region.length) {
    const line = region[at];
    region[at] = line.slice(0, i.cursor.character) + CURSOR_MARKER + line.slice(i.cursor.character);
  }
  blocks.push(`${OPEN_TAG}\n${region.join('\n')}\n${CLOSE_TAG}`);

  return {
    messages: [
      { role: 'system', content: systemSuffix ? `${CHAT_XTAB_SYSTEM}\n${systemSuffix}` : CHAT_XTAB_SYSTEM },
      { role: 'user', content: blocks.join('\n\n') }
    ],
    stableChars
  };
}

export type ChatXtabAnswer =
  | { kind: 'rewrite'; lines: string[] }
  | { kind: 'noChange' }
  | { kind: 'invalid'; why: 'noFence' | 'truncated' };

const isNoChange = (text: string): boolean => {
  const t = text.trim();
  return t === 'NO_CHANGE' || t === '<NO_CHANGE>';
};

/** Line indexes of the opening and closing fence (-1 when missing) and the split lines. */
function findFences(text: string): { lines: string[]; open: number; close: number } {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => l.startsWith('```'));
  let close = -1;
  if (open >= 0) close = lines.findIndex((l, n) => n > open && l.trim() === '```');
  return { lines, open, close };
}

export function parseChatXtab(text: string, complete: boolean): ChatXtabAnswer {
  // A rewrite needs its closing fence, so a finished and an unfinished stream parse alike.
  void complete;
  if (isNoChange(text)) return { kind: 'noChange' };
  const { lines, open, close } = findFences(text);
  if (open < 0) return { kind: 'invalid', why: 'noFence' };
  // Without a closing fence the answer is cut off, finished stream or not: never accept it as a rewrite.
  if (close < 0) return { kind: 'invalid', why: 'truncated' };
  const body = lines
    .slice(open + 1, close)
    .filter((l) => {
      const t = l.trim();
      return t !== OPEN_TAG && t !== CLOSE_TAG;
    })
    .map((l) => l.split(CURSOR_MARKER).join(''));
  return { kind: 'rewrite', lines: body };
}

export function chatXtabDone(text: string): boolean {
  if (isNoChange(text)) return true;
  return findFences(text).close >= 0;
}
