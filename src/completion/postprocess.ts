// Final cleanup of a completion before it is shown as ghost text.
// Written from the ideas in Continue's postprocessing; no upstream code is copied.

export interface PostCtx {
  linePrefix: string;
  lineSuffix: string;
  prevLine: string;
  suffix: string;
}

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

export function postprocess(raw: string, c: PostCtx): string | undefined {
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
