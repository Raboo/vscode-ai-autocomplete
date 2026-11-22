// Portions adapted from Continue core/nextEdit @ 5522c6f44ca0ac3528b37244818fbfa39b5af470 (Apache-2.0). Copyright Continue Dev, Inc.
import type { ChatMessage } from '../../backends/types';
import type { DiffEntry } from '../history';
import { clipLinesAroundRegion, editableRegion, type LineSpan } from '../region';
import { hasReserved, newestThatFit, pickSnippets, tooLong, type ChatFormat, type FormatAnswer, type NextEditInput } from './format';

/** Continue's Instinct system prompt as it appears in the training data (continuedev/instinct-data @ e557e3ed). */
export const INSTINCT_SYSTEM =
  "You are Instinct, an intelligent next-edit predictor developed by Continue.dev. Your role as an AI assistant is to help developers complete their code tasks by predicting the next edit that they will make within the section of code marked by <|editable_region_start|> and <|editable_region_end|> tags.\n\nYou have access to the following information to help you make informed suggestions:\n\n- Context: In the section marked \"### Context\", there are context items from potentially relevant files in the developer's codebase. Each context item consists of a <|context_file|> marker, the filepath, a <|snippet|> marker, and then some content from that file, in that order. Keep in mind that not all of the context information may be relevant to the task, so use your judgement to determine which parts to consider.\n- User Edits: In the section marked \"### User Edits:\", there is a record of the most recent changes made to the code, helping you understand the evolution of the code and the developer's intentions. These changes are listed from most recent to least recent. It's possible that some of the edit diff history is entirely irrelevant to the developer's change. The changes are provided in a unified line-diff format, i.e. with pluses and minuses for additions and deletions to the code.\n- User Excerpt: In the section marked \"### User Excerpt:\", there is a filepath to the developer's current file, and then an excerpt from that file. The <|editable_region_start|> and <|editable_region_end|> markers are within this excerpt. Your job is to rewrite only this editable region, not the whole excerpt. The excerpt provides additional context on the surroundings of the developer's edit.\n- Cursor Position: Within the user excerpt's editable region, the <|user_cursor_is_here|> flag indicates where the developer's cursor is currently located, which can be crucial for understanding what part of the code they are focusing on. Do not produce this marker in your output; simply take it into account.\n\nYour task is to predict and complete the changes the developer would have made next in the editable region. The developer may have stopped in the middle of typing. Your goal is to keep the developer on the path that you think they're following. Some examples include further implementing a class, method, or variable, or improving the quality of the code. Make sure the developer doesn't get distracted by ensuring your suggestion is relevant. Consider what changes need to be made next, if any. If you think changes should be made, ask yourself if this is truly what needs to happen. If you are confident about it, then proceed with the changes.\n\n# Steps\n\n1. **Review Context**: Analyze the context from the resources provided, such as recently viewed snippets, edit history, surrounding code, and cursor location.\n2. **Evaluate Current Code**: Determine if the current code within the tags requires any corrections or enhancements.\n3. **Suggest Edits**: If changes are required, ensure they align with the developer's patterns and improve code quality.\n4. **Maintain Consistency**: Ensure indentation and formatting follow the existing code style.\n\n# Output Format\n\n- Provide only the revised code within the tags. Do not include the tags in your output.\n- Ensure that you do not output duplicate code that exists outside of these tags.\n- Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.\n\n";

const USER_PREFIX = "Reference the user excerpt, user edits, and the snippets to understand the developer's intent. Update the editable region of the user excerpt by predicting and completing the changes they would have made next. This may be a deletion, addition, or modification of code.";

const REGION_START = '<|editable_region_start|>';
const REGION_END = '<|editable_region_end|>';
const CURSOR = '<|user_cursor_is_here|>';
const RESERVED = [REGION_START, REGION_END, CURSOR, '<|context_file|>', '<|snippet|>'];

/** Lines of the excerpt on each side of the cursor, at most. */
const WINDOW_LINES = 25;

/** The region Instinct was trained on: one line above the cursor and five below; the settings do not change it. */
export function instinctRegion(cursorLine: number, lineCount: number): LineSpan {
  return editableRegion(cursorLine, lineCount, 1, 5);
}

const renderEdit = (e: DiffEntry): string =>
  `User edited file "${e.path}"\n\n\`\`\`diff\n${e.contextText.replace(/\n+$/, '')}\n\`\`\``;

export function instinctMessages(i: NextEditInput, systemSuffix?: string): { messages: ChatMessage[]; stableChars: number } {
  const snippets = pickSnippets(i.snippets, i.budgets.snippetsChars, RESERVED);
  const edits = newestThatFit(i.history, renderEdit, i.budgets.historyChars).reverse();

  const clipped = clipLinesAroundRegion(i.lines, i.region, i.budgets.fileChars);
  const start = Math.min(i.region.start, Math.max(clipped.start, i.cursor.line - WINDOW_LINES));
  const end = Math.max(i.region.end, Math.min(clipped.end, i.cursor.line + WINDOW_LINES));

  const region = i.lines.slice(i.region.start, i.region.end + 1);
  const at = i.cursor.line - i.region.start;
  if (at >= 0 && at < region.length) {
    const line = region[at];
    region[at] = line.slice(0, i.cursor.character) + CURSOR + line.slice(i.cursor.character);
  }
  const excerpt = [...i.lines.slice(start, i.region.start), REGION_START, ...region, REGION_END, ...i.lines.slice(i.region.end + 1, end + 1)];

  const context = snippets.length
    ? '\n' + snippets.map((s) => `<|context_file|> \`${s.path}\`\n<|snippet|>\n${s.text}\n`).join('\n')
    : '';
  const head = `${USER_PREFIX}\n\n### Context:\n${context}\n\n`;
  const user =
    `${head}### User Edits:\n\n` +
    (edits.length ? `${edits.join('\n\n')}\n\n` : '\n') +
    `### User Excerpt:\n"${i.path}"\n\n${excerpt.join('\n')}\n\n`;

  return {
    messages: [
      { role: 'system', content: systemSuffix ? `${INSTINCT_SYSTEM}\n${systemSuffix}` : INSTINCT_SYSTEM },
      { role: 'user', content: user }
    ],
    stableChars: head.length
  };
}

/** Why a region cannot be sent in this format, or undefined. */
function problem(i: NextEditInput): string | undefined {
  const start = Math.max(0, i.region.start - WINDOW_LINES - 1);
  const lines = i.lines.slice(start, i.region.end + WINDOW_LINES + 2);
  if (hasReserved(lines, RESERVED)) return 'a file line contains an Instinct tag';
  if (hasReserved(i.history.map((e) => e.contextText), RESERVED)) return 'the edit history contains an Instinct tag';
  return tooLong(i) ? 'tooLong' : undefined;
}

/** The answer has no closing marker, so the last line is taken as it is (`complete` does not matter). */
export function parseInstinct(text: string): FormatAnswer {
  let lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim() !== '');
  if (open >= 0 && lines[open].startsWith('```')) {
    const close = lines.findIndex((l, n) => n > open && l.trim() === '```');
    if (close >= 0) lines = lines.slice(open + 1, close);
  }
  lines = lines.filter((l) => l.trim() !== REGION_START && l.trim() !== REGION_END).map((l) => l.split(CURSOR).join(''));
  if (lines.every((l) => l.trim() === '')) return { kind: 'invalid', why: 'empty' };
  return { kind: 'rewrite', lines };
}

/** Instinct's own wording: the model rewrites the region and stops; the stream ends by itself. */
export const instinctFormat: ChatFormat = {
  id: 'instinct',
  transport: 'chat',
  region: (cursorLine, lines) => instinctRegion(cursorLine, lines.length),
  problem,
  messages: instinctMessages,
  done: () => false,
  parse: parseInstinct
};
