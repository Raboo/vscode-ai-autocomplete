// Portions adapted from sweepai/sweep-next-edit-1.5B run_model.py @ 409016591c6c1a94f545f22328a85a3516118f34 and sweepai/sweep-next-edit-v2-7B inference.py @ 851f4ac1427ec91eb6c19d408409490d6e0c00a0 (Apache-2.0). Copyright Sweep AI.
import { spanBefore, type DiffHunk, type Snippet } from '../history';
import { clipAroundRegion, editableRegion, type LineSpan } from '../region';
import { tooLong, type CompletionFormat, type FormatAnswer, type NextEditInput } from './format';

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

  const kept: string[] = [];
  let used = 0;
  for (let n = all.length - 1; n >= 0; n--) {
    const { path, hunk } = all[n];
    if ([path, ...hunk.oldLines, ...hunk.newLines].some((t) => reserved.some((r) => t.includes(r)))) continue;
    const old = hunk.oldLines.join('\n');
    const next = hunk.newLines.join('\n');
    let header = `${FILE_SEP}${path}.diff`;
    if (variant === 'v2') {
      const start = hunk.newStart + 1;
      header = `${FILE_SEP}${path}:${start}:${start + hunk.newLines.length - 1}`;
    }
    const block = `${header}\noriginal:\n${old}\nupdated:\n${next}`;
    if (used + block.length + 1 > i.budgets.historyChars) break;
    used += block.length + 1;
    kept.push(block);
  }
  return kept.reverse();
}

/** The snippets that fit the budget, in the order given and without reserved strings. */
function pickSnippets(i: NextEditInput, variant: Variant): Snippet[] {
  const reserved = reservedFor(variant);
  let remaining = i.budgets.snippetsChars;
  const out: Snippet[] = [];
  for (const s of i.snippets) {
    if ([s.path, s.text].some((t) => reserved.some((r) => t.includes(r)))) continue;
    if (s.text.length > remaining) continue;
    remaining -= s.text.length;
    out.push(s);
  }
  return out;
}

/** The v2 file section: the file clipped around the region. */
const fileSection = (i: NextEditInput): string[] => take(i.lines, clipAroundRegion(i.lines, i.region, i.budgets.fileChars));

function problem(variant: Variant, i: NextEditInput): string | undefined {
  const window = take(i.lines, i.region);
  const texts = [...window, ...originalWindow(i, window)];
  if (variant === 'v2') texts.push(...fileSection(i));
  const reserved = reservedFor(variant);
  if (texts.some((t) => reserved.some((r) => t.includes(r)))) return 'reserved';
  return tooLong(i) ? 'tooLong' : undefined;
}

function promptV1(i: NextEditInput): ReturnType<CompletionFormat['prompt']> {
  const window = take(i.lines, i.region);
  const parts: string[] = [];
  for (const s of pickSnippets(i, 'v1')) parts.push(`${FILE_SEP}${s.path}\n${s.text}`);
  parts.push(...changeBlocks(i, 'v1'));
  parts.push(`${FILE_SEP}original/${i.path}\n${originalWindow(i, window).join('\n')}`);
  parts.push(`${FILE_SEP}current/${i.path}\n${window.join('\n')}`);
  parts.push(`${FILE_SEP}updated/${i.path}`);
  return { prompt: `${parts.join('\n')}\n`, prefill: '', stop: [FILE_SEP, END_OF_TEXT, '</s>'], maxTokens: 512 };
}

function promptV2(i: NextEditInput): ReturnType<CompletionFormat['prompt']> {
  const window = take(i.lines, i.region);
  const range = `${i.region.start + 1}:${i.region.end + 1}`;
  const snippets = pickSnippets(i, 'v2')
    .map((s) => `${FILE_SEP}${s.path}\n${s.text}\n`)
    .join('');
  const above = Math.max(0, Math.min(window.length, i.cursor.line - i.region.start));
  const prefill = window
    .slice(0, above)
    .map((l) => `${l}\n`)
    .join('');
  const prompt =
    `${snippets}${FILE_SEP}${i.path}\n${fileSection(i).join('\n')}\n\n` +
    `${changeBlocks(i, 'v2').join('\n')}\n` +
    `${FILE_SEP}original/${i.path}:${range}\n${originalWindow(i, window).join('\n')}\n` +
    `${FILE_SEP}current/${i.path}:${range}\n${windowWithCursor(i, window).join('\n')}\n` +
    `${FILE_SEP}updated/${i.path}:${range}\n${prefill}`;
  return { prompt, prefill, stop: [FILE_SEP, END_OF_TEXT], maxTokens: 1024 };
}

/** The same parse for both layouts: the answer is the window's new lines. */
function parse(answer: string, i: NextEditInput): FormatAnswer {
  if (answer.startsWith('<|')) return { kind: 'invalid', why: 'special' };
  const window = take(i.lines, i.region);
  let text = answer.endsWith('\n') ? answer.slice(0, -1) : answer;
  text = text.split(CURSOR).join('');
  if (text === '' && window.some((l) => !isBlank(l))) return { kind: 'invalid', why: 'empty' };

  const lines = text.split('\n');
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
    region: (cursorLine, lineCount) => editableRegion(cursorLine, lineCount, WINDOW_ABOVE, WINDOW_BELOW),
    problem: (i) => problem(variant, i),
    prompt: variant === 'v2' ? promptV2 : promptV1,
    parse,
  };
}
