// Portions adapted from sweepai/sweep-next-edit-1.5B run_model.py @ 409016591c6c1a94f545f22328a85a3516118f34 and sweepai/sweep-next-edit-v2-7B inference.py @ 851f4ac1427ec91eb6c19d408409490d6e0c00a0 (Apache-2.0). Copyright Sweep AI.
import { spanBefore, type DiffHunk } from '../history';
import { clipAroundRegion, editableRegion, type LineSpan } from '../region';
import { hasReserved, newestThatFit, pickSnippets, tooLong, type CompletionFormat, type FormatAnswer, type NextEditInput } from './format';

type Variant = 'v1' | 'v2';

const FILE_SEP = '<|file_sep|>';
const END_OF_TEXT = '<|endoftext|>';
const CURSOR = '<|cursor|>';

/** Sweep's trained window: 10 lines above and below the cursor. The region settings do not apply. */
const WINDOW_ABOVE = 10;
const WINDOW_BELOW = 10;
/** An answer more than this many lines longer than the window is not a plausible rewrite. */
const MAX_EXTRA_LINES = 20;

const reservedFor = (variant: Variant): string[] => (variant === 'v2' ? [FILE_SEP, END_OF_TEXT, CURSOR] : [FILE_SEP, END_OF_TEXT]);

const isBlank = (line: string): boolean => line.trim() === '';

const leadingSpaces = (line: string): number => line.length - line.replace(/^ +/, '').length;

/** The lines of a window from a file's lines, empty for an empty span. */
const take = (lines: string[], span: LineSpan): string[] => (span.end < span.start ? [] : lines.slice(span.start, span.end + 1));

/** The original window: the same region of the text before the latest change, else the current window. */
function originalWindow(i: NextEditInput, current: string[]): string[] {
  return i.previous ? take(i.previous.lines, spanBefore(i.previous.hunks, i.region)) : current;
}

function windowWithCursor(i: NextEditInput, window: string[]): string[] {
  const out = [...window];
  const at = i.cursor.line - i.region.start;
  if (at >= 0 && at < out.length) out[at] = out[at].slice(0, i.cursor.character) + CURSOR + out[at].slice(i.cursor.character);
  return out;
}

/** One change block per kept hunk, oldest first: the newest hunks whose blocks fit the budget, minus hunks with reserved strings. */
function changeBlocks(i: NextEditInput, variant: Variant): string[] {
  const reserved = reservedFor(variant);
  const all: { path: string; hunk: DiffHunk }[] = [];
  for (const entry of i.history) for (const hunk of entry.hunks) all.push({ path: entry.path, hunk });

  return newestThatFit(
    all,
    ({ path, hunk }) => {
      if (hasReserved([path, ...hunk.oldLines, ...hunk.newLines], reserved)) return undefined;
      let header = `${FILE_SEP}${path}.diff`;
      if (variant === 'v2') {
        const start = hunk.newStart + 1;
        header = `${FILE_SEP}${path}:${start}:${start + hunk.newLines.length - 1}`;
      }
      return `${header}\noriginal:\n${hunk.oldLines.join('\n')}\nupdated:\n${hunk.newLines.join('\n')}`;
    },
    i.budgets.historyChars,
  );
}

/** The v2 file section: the file clipped around the region. */
const fileSection = (i: NextEditInput): string[] => take(i.lines, clipAroundRegion(i.lines, i.region, i.budgets.fileChars));

function problem(variant: Variant, i: NextEditInput): string | undefined {
  const window = take(i.lines, i.region);
  const texts = [...window, ...originalWindow(i, window)];
  if (variant === 'v2') texts.push(...fileSection(i));
  const reserved = reservedFor(variant);
  if (hasReserved(texts, reserved)) return 'reserved';
  return tooLong(i) ? 'tooLong' : undefined;
}

function promptV1(i: NextEditInput): ReturnType<CompletionFormat['prompt']> {
  const window = take(i.lines, i.region);
  const parts: string[] = [];
  for (const s of pickSnippets(i.snippets, i.budgets.snippetsChars, reservedFor('v1'))) parts.push(`${FILE_SEP}${s.path}\n${s.text}`);
  parts.push(...changeBlocks(i, 'v1'));
  parts.push(`${FILE_SEP}original/${i.path}\n${originalWindow(i, window).join('\n')}`);
  parts.push(`${FILE_SEP}current/${i.path}\n${window.join('\n')}`);
  parts.push(`${FILE_SEP}updated/${i.path}`);
  return { prompt: `${parts.join('\n')}\n`, prefill: '', stop: [FILE_SEP, END_OF_TEXT, '</s>'], maxTokens: 512 };
}

/** v2 prefills the window's lines above the cursor line; v1 has no prefill. */
const prefilledLines = (variant: Variant, i: NextEditInput, window: string[]): number =>
  variant === 'v2' ? Math.max(0, Math.min(window.length, i.cursor.line - i.region.start)) : 0;

const prefillOf = (variant: Variant, i: NextEditInput, window: string[]): string =>
  window
    .slice(0, prefilledLines(variant, i, window))
    .map((l) => `${l}\n`)
    .join('');

function promptV2(i: NextEditInput): ReturnType<CompletionFormat['prompt']> {
  const window = take(i.lines, i.region);
  const range = `${i.region.start + 1}:${i.region.end + 1}`;
  const snippets = pickSnippets(i.snippets, i.budgets.snippetsChars, reservedFor('v2'))
    .map((s) => `${FILE_SEP}${s.path}\n${s.text}\n`)
    .join('');
  const prefill = prefillOf('v2', i, window);
  const prompt =
    `${snippets}${FILE_SEP}${i.path}\n${fileSection(i).join('\n')}\n\n` +
    `${changeBlocks(i, 'v2').join('\n')}\n` +
    `${FILE_SEP}original/${i.path}:${range}\n${originalWindow(i, window).join('\n')}\n` +
    `${FILE_SEP}current/${i.path}:${range}\n${windowWithCursor(i, window).join('\n')}\n` +
    `${FILE_SEP}updated/${i.path}:${range}\n${prefill}`;
  return { prompt, prefill, stop: [FILE_SEP, END_OF_TEXT], maxTokens: 1024 };
}

/** The same parse for both layouts: the answer (v2: the prefill plus the generated text) is the window's new lines. */
function parse(variant: Variant, answer: string, i: NextEditInput): FormatAnswer {
  const window = take(i.lines, i.region);
  const prefill = prefillOf(variant, i, window);
  // A stray cursor marker is dropped, also one the model echoes at the start of the cursor line.
  const generated = (answer.startsWith(prefill) ? answer.slice(prefill.length) : answer).split(CURSOR).join('');
  if (generated.startsWith('<|')) return { kind: 'invalid', why: 'special' };
  // Nothing (or only blank lines) generated would delete the window's non-blank lines from the cursor line down (v1: the whole window).
  const below = window.slice(prefilledLines(variant, i, window));
  if (generated.trim() === '' && below.some((l) => !isBlank(l))) return { kind: 'invalid', why: 'empty' };
  let text = answer.endsWith('\n') ? answer.slice(0, -1) : answer;
  text = text.split(CURSOR).join('');

  const lines = text.split('\n');
  // LM Studio's MLX engine drops the leading space of the first generated token: give back the one space the first generated line misses.
  const first = prefilledLines(variant, i, window);
  if (answer.startsWith(prefill) && first < lines.length && first < window.length && !isBlank(lines[first])
    && leadingSpaces(lines[first]) + 1 === leadingSpaces(window[first])) lines[first] = ` ${lines[first]}`;
  // The trailing newline cut above and the model's stop may have dropped the window's last blank lines: restore them.
  let blanksInWindow = 0;
  while (blanksInWindow < window.length && isBlank(window[window.length - 1 - blanksInWindow])) blanksInWindow++;
  let blanksInAnswer = 0;
  while (blanksInAnswer < lines.length && isBlank(lines[lines.length - 1 - blanksInAnswer])) blanksInAnswer++;
  if (blanksInAnswer < blanksInWindow) lines.push(...window.slice(window.length - (blanksInWindow - blanksInAnswer)));

  if (lines.length > window.length + MAX_EXTRA_LINES) return { kind: 'invalid', why: 'tooLong' };
  if (lines.length === window.length && lines.every((l, n) => l === window[n])) return { kind: 'noChange' };
  return { kind: 'rewrite', lines };
}

/** Sweep's next-edit prompt: `v1` follows the 0.5B/1.5B script, `v2` the 7B v2 script. */
export function sweepFormat(variant: Variant): CompletionFormat {
  return {
    id: 'sweep',
    transport: 'completion',
    region: (cursorLine, lines) => editableRegion(cursorLine, lines.length, WINDOW_ABOVE, WINDOW_BELOW),
    problem: (i) => problem(variant, i),
    prompt: variant === 'v2' ? promptV2 : promptV1,
    parse: (answer, i) => parse(variant, answer, i),
  };
}
