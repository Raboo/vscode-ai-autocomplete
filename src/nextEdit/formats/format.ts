import type { ChatMessage } from '../../backends/types';
import type { DiffEntry, DiffHunk, Snippet } from '../history';
import { nextEditBudgets, type LineSpan, type NextEditBudgets } from '../region';

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
  region(cursorLine: number, lines: string[], size: { above: number; below: number }): LineSpan;
  /** Why this input cannot be sent in this format, or undefined. */
  problem(input: NextEditInput): string | undefined;
  /** The format's own split of the context budget; without it `nextEditBudgets` applies. */
  budgets?(contextTokens: number): NextEditBudgets;
  /** The format's own limit for a region that is too long; without it `tooLong` applies. */
  tooLong?(input: NextEditInput): boolean;
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

/** The budgets for `contextTokens`: the format's own split, else the default one. */
export const formatBudgets = (format: NextEditFormat, contextTokens: number): NextEditBudgets =>
  format.budgets ? format.budgets(contextTokens) : nextEditBudgets(contextTokens);

/** A region longer than twice the file budget (minified code) would make a prompt far over the budget. */
export function tooLong(input: NextEditInput): boolean {
  return input.lines.slice(input.region.start, input.region.end + 1).join('\n').length > 2 * input.budgets.fileChars;
}

/** Whether any text contains one of the format's reserved strings. */
export const hasReserved = (texts: string[], reserved: string[]): boolean => texts.some((t) => reserved.some((r) => t.includes(r)));

/** The snippets that fit `budgetChars` (by text length), in the order given, minus those with a reserved string in path or text. */
export function pickSnippets(snippets: Snippet[], budgetChars: number, reserved: string[]): Snippet[] {
  let remaining = budgetChars;
  const out: Snippet[] = [];
  for (const s of snippets) {
    if (hasReserved([s.path, s.text], reserved)) continue;
    if (s.text.length > remaining) continue;
    remaining -= s.text.length;
    out.push(s);
  }
  return out;
}

/**
 * Takes items newest first (the input is oldest first) while their rendered text plus a newline fits `budgetChars`
 * and `max` is not reached, and returns the rendered texts oldest first. `render` returns undefined to skip an item.
 * The first item that does not fit ends the selection.
 */
export function newestThatFit<T>(items: T[], render: (item: T) => string | undefined, budgetChars: number, max = Infinity): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let n = items.length - 1; n >= 0 && kept.length < max; n--) {
    const text = render(items[n]);
    if (text === undefined) continue;
    if (used + text.length + 1 > budgetChars) break;
    used += text.length + 1;
    kept.push(text);
  }
  return kept.reverse();
}
