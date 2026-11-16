import type { ChatMessage } from '../../backends/types';
import type { DiffEntry, DiffHunk, Snippet } from '../history';
import type { LineSpan, NextEditBudgets } from '../region';

export type FormatId = 'chatXtab' | 'sweep' | 'zeta21';

/** What a Next Edit prompt is built from. */
export interface NextEditInput {
  path: string;
  lines: string[];
  cursor: { line: number; character: number };
  region: LineSpan;
  history: DiffEntry[];
  snippets: Snippet[];
  budgets: NextEditBudgets;
  /** The file before the change recorded by its newest history entry, and that entry's hunks. */
  previous?: { lines: string[]; hunks: DiffHunk[] };
}

/** A parsed answer: the region's new lines, no change, or an answer that cannot be used. */
export type FormatAnswer = { kind: 'rewrite'; lines: string[] } | { kind: 'noChange' } | { kind: 'invalid'; why: string };

interface FormatBase {
  id: FormatId;
  /** The lines the model may rewrite. `size` is the settings' lines above and below the cursor. */
  region(cursorLine: number, lineCount: number, size: { above: number; below: number }): LineSpan;
  /** Why this input cannot be sent in this format, or undefined. */
  problem(input: NextEditInput): string | undefined;
}

/** A format on the backend's chat route. */
export interface ChatFormat extends FormatBase {
  transport: 'chat';
  /** `stableChars`: the prefix of the user message that stays the same while the cursor stays in the region. */
  messages(input: NextEditInput, systemSuffix?: string): { messages: ChatMessage[]; stableChars: number };
  /** Whether a streaming answer is over. */
  done(visible: string): boolean;
  /** `complete`: the stream has ended, so its last line is whole. */
  parse(visible: string, complete: boolean): FormatAnswer;
}

/** A format on the backend's raw completion route (a template payload). */
export interface CompletionFormat extends FormatBase {
  transport: 'completion';
  /** `prefill` ends the prompt and starts the answer. */
  prompt(input: NextEditInput): { prompt: string; prefill: string; stop: string[]; maxTokens: number };
  /** `answer`: the prefill plus the generated text, without a stop string a server echoed at its end. */
  parse(answer: string, input: NextEditInput): FormatAnswer;
}

export type NextEditFormat = ChatFormat | CompletionFormat;

/** A region longer than twice the file budget (minified code) would make a prompt far over the budget. */
export function tooLong(input: NextEditInput): boolean {
  return input.lines.slice(input.region.start, input.region.end + 1).join('\n').length > 2 * input.budgets.fileChars;
}
