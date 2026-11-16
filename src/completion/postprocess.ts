// Final cleanup of a completion before it is shown as ghost text.
// Written from the ideas in Continue's postprocessing; no upstream code is copied.

import { stripLeadingReasoning } from '../models/thinking';

export interface PostCtx {
  linePrefix: string;
  lineSuffix: string;
  prevLine: string;
  suffix: string;
  /** Chat-route output: the stream already removed the reasoning, so nothing is stripped here. */
  chat: boolean;
}

/** Special tokens of the Next Edit formats (Zeta, Sweep, chatXtab); an answer is cut at the first one. */
export const NEXT_EDIT_TOKENS = /<\|marker_\d+\|>|<\|user_cursor\|>|<\|file_sep\|>|<\|endoftext\|>|<\|cursor\|>/;

const MIN_SUFFIX_RETYPE = 4;
const REPEAT_WINDOW = 30;
const REPEAT_COUNT = 3;

function stripCodeFences(text: string): string {
  let t = text;
  if (/^\s*```/.test(t)) t = t.replace(/^\s*```[^\n]*\n?/, '');
  t = t.replace(/\n?[ \t]*```\s*$/, '');
  return t;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

const toLf = (s: string): string => s.replace(/\r\n/g, '\n');

/** Accepts raw document text (CRLF allowed); the result uses `\n` line breaks. */
export function postprocess(rawInput: string, ctxInput: PostCtx): string | undefined {
  const cut = rawInput.search(NEXT_EDIT_TOKENS);
  if (cut >= 0) rawInput = rawInput.slice(0, cut);
  // FIM output is code: only a reasoning block at its very start is removed.
  const raw = toLf(ctxInput.chat ? rawInput : stripLeadingReasoning(rawInput));
  const c: PostCtx = {
    linePrefix: toLf(ctxInput.linePrefix),
    lineSuffix: toLf(ctxInput.lineSuffix),
    prevLine: toLf(ctxInput.prevLine),
    suffix: toLf(ctxInput.suffix),
    chat: ctxInput.chat,
  };
  if (raw.trim() === '') return undefined;

  const text = stripCodeFences(raw).trimEnd();
  if (text.trim() === '') return undefined;

  // repeats the previous line
  if (c.prevLine.trim() !== '' && text.trim() === c.prevLine.trim()) return undefined;

  // just retypes the suffix
  const t = raw.trim();
  if (t.length >= MIN_SUFFIX_RETYPE && c.suffix.trimStart().startsWith(t)) return undefined;

  // degenerate repetition
  if (text.length >= REPEAT_WINDOW) {
    const tail = text.slice(-REPEAT_WINDOW);
    if (countOccurrences(text, tail) >= REPEAT_COUNT) return undefined;
  }

  return text;
}

export function toInsertion(
  completion: string,
  lineSuffix: string,
): { insertText: string; replaceToEndOfLine: boolean } {
  const rest = lineSuffix.trim();
  return {
    insertText: completion,
    replaceToEndOfLine: rest !== '' && completion.trimEnd().endsWith(rest),
  };
}
