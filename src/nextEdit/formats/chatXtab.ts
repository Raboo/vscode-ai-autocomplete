import type { ChatMessage } from '../../backends/types';
import { CURSOR_MARKER, PIN_BACK_LINES } from '../../completion/holeFiller';
import type { DiffEntry } from '../history';
import { clipAroundRegion, editableRegion } from '../region';
import { tooLong, type ChatFormat, type FormatAnswer, type NextEditInput } from './format';

export const CHAT_XTAB_SYSTEM = `You predict the next edit a developer will make in a code file.
You get: code the developer viewed recently (oldest first), the current file, the developer's recent edits as unified diffs (oldest first), and the code to edit, with the cursor marked ${CURSOR_MARKER}.
Rewrite the code between <|code_to_edit|> and <|/code_to_edit|> the way the developer would continue: finish what they started, and make the same change where it is still missing. Leave everything else exactly as it is, including indentation.
Answer with the rewritten code in one \`\`\` block, without the tags and without ${CURSOR_MARKER}. If nothing should change, answer NO_CHANGE.`;

const OPEN_TAG = '<|code_to_edit|>';
const CLOSE_TAG = '<|/code_to_edit|>';

/** The newest entries whose texts and blank-line separators fit the budget, oldest first. */
function pickHistory(history: DiffEntry[], budgetChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = history[i].text.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > budgetChars) break;
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

  const span = clipAroundRegion(i.lines, i.region, i.budgets.fileChars);
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

  const history = pickHistory(i.history, i.budgets.historyChars);
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

const isNoChange = (text: string): boolean => {
  const t = text.trim();
  return t === 'NO_CHANGE' || t === '<NO_CHANGE>';
};

/**
 * Line indexes of the opening and closing fence (-1 when missing) and the split lines. The closing fence must be a whole
 * line: while the stream runs (`complete` false) the last line may still grow, and a "```" there may become "```bash".
 */
function findFences(text: string, complete: boolean): { lines: string[]; open: number; close: number } {
  const lines = text.split(/\r?\n/);
  const whole = complete ? lines.length : lines.length - 1;
  const open = lines.findIndex((l) => l.startsWith('```'));
  let close = -1;
  if (open >= 0) close = lines.findIndex((l, n) => n > open && n < whole && l.trim() === '```');
  return { lines, open, close };
}

/**
 * Why a region cannot be sent in this format, or undefined. A line starting with ``` (a Markdown code block) would close
 * the answer's fence early, so the rest of the region would read as deleted; a very long region (minified code) would make
 * a prompt far over the budget.
 */
function regionProblem(i: NextEditInput): 'fence' | 'tooLong' | undefined {
  if (i.lines.slice(i.region.start, i.region.end + 1).some((l) => l.trimStart().startsWith('```'))) return 'fence';
  return tooLong(i) ? 'tooLong' : undefined;
}

/** `complete`: the stream has ended, so its last line is whole. */
export function parseChatXtab(text: string, complete: boolean): FormatAnswer {
  if (isNoChange(text)) return { kind: 'noChange' };
  const { lines, open, close } = findFences(text, complete);
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

/** Whether a streaming answer is over: a no-change answer, or a closing fence on a whole line. */
export function chatXtabDone(text: string): boolean {
  if (isNoChange(text)) return true;
  return findFences(text, false).close >= 0;
}

/** The 3a format: the region rewritten in a fenced block on the chat route. */
export const chatXtabFormat: ChatFormat = {
  id: 'chatXtab',
  transport: 'chat',
  region: (cursorLine, lineCount, size) => editableRegion(cursorLine, lineCount, size.above, size.below),
  problem: regionProblem,
  messages: chatXtabMessages,
  done: chatXtabDone,
  parse: parseChatXtab,
};
