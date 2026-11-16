// The prompt layout follows the format described on the zed-industries/zeta-2.1 model card (Apache-2.0); no code is copied from any implementation.
import type { DiffEntry, Snippet } from '../history';
import { clipAroundRegion, editableRegion, type LineSpan } from '../region';
import { tooLong, type CompletionFormat, type FormatAnswer, type NextEditInput } from './format';

const EOS = '<[end▁of▁sentence]>';
const CURSOR = '<|user_cursor|>';
const RESERVED = ['<[fim-', '<filename>', '<|marker_', CURSOR, EOS];

const MAX_BLOCK_LINES = 16;
const MIN_BLOCK_LINES = 6;
const MAX_HISTORY_ENTRIES = 6;

const isBlank = (line: string): boolean => line.trim() === '';
const reserved = (...texts: string[]): boolean => texts.some((t) => RESERVED.some((r) => t.includes(r)));
const take = (lines: string[], span: LineSpan): string[] => (span.end < span.start ? [] : lines.slice(span.start, span.end + 1));

/** The 0-based line indexes where marker blocks start: after 16 lines, or at a non-blank line after a blank one once the block has 6 lines. */
export function markerBlocks(lines: string[]): number[] {
  const starts = [0];
  let blockStart = 0;
  for (let i = 1; i < lines.length; i++) {
    const size = i - blockStart;
    if (size >= MAX_BLOCK_LINES || (size >= MIN_BLOCK_LINES && !isBlank(lines[i]) && isBlank(lines[i - 1]))) {
      starts.push(i);
      blockStart = i;
    }
  }
  return starts;
}

/** The region with `<|marker_k|>` glued to each block start, the closing marker at the end and the cursor tag inserted. */
function markedRegion(i: NextEditInput, region: string[]): string {
  const lines = [...region];
  const at = i.cursor.line - i.region.start;
  if (at >= 0 && at < lines.length) lines[at] = lines[at].slice(0, i.cursor.character) + CURSOR + lines[at].slice(i.cursor.character);
  const starts = markerBlocks(region);
  const marked = lines.map((l, n) => {
    const k = starts.indexOf(n);
    return k < 0 ? l : `<|marker_${k + 1}|>${l}`;
  });
  return `${marked.join('\n')}<|marker_${starts.length + 1}|>`;
}

/** The newest entries that fit the budget (at most 6) as `--- a/` / `+++ b/` diffs, oldest first, minus entries with reserved strings. */
function historyDiffs(i: NextEditInput): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let n = i.history.length - 1; n >= 0 && kept.length < MAX_HISTORY_ENTRIES; n--) {
    const e: DiffEntry = i.history[n];
    if (reserved(e.path, e.text)) continue;
    const diff = [`--- a/${e.path}`, `+++ b/${e.path}`, ...e.text.split('\n').slice(2)].join('\n');
    if (used + diff.length + 1 > i.budgets.historyChars) break;
    used += diff.length + 1;
    kept.push(diff);
  }
  return kept.reverse();
}

/** The snippets that fit the budget, in the order given and without reserved strings. */
function pickSnippets(i: NextEditInput): Snippet[] {
  let remaining = i.budgets.snippetsChars;
  const out: Snippet[] = [];
  for (const s of i.snippets) {
    if (reserved(s.path, s.text) || s.text.length > remaining) continue;
    remaining -= s.text.length;
    out.push(s);
  }
  return out;
}

const clipped = (i: NextEditInput): LineSpan => clipAroundRegion(i.lines, i.region, i.budgets.fileChars);

function problem(i: NextEditInput): string | undefined {
  if (reserved(i.path, ...take(i.lines, clipped(i)))) return 'reserved';
  return tooLong(i) ? 'tooLong' : undefined;
}

function prompt(i: NextEditInput): ReturnType<CompletionFormat['prompt']> {
  const region = take(i.lines, i.region);
  const clip = clipped(i);
  const before = take(i.lines, { start: clip.start, end: i.region.start - 1 })
    .map((l) => `${l}\n`)
    .join('');
  const after = take(i.lines, { start: i.region.end + 1, end: clip.end });
  const suffix = after.length === 0 ? '\n' : `\n${after.join('\n')}\n`;

  const snippets = pickSnippets(i);
  const related = snippets.length === 0 ? '' : `${snippets.map((s) => `<filename>${s.path}\n${s.text}\n`).join('')}\n`;
  const diffs = historyDiffs(i);
  const history = diffs.length === 0 ? '' : `<filename>edit_history\n${diffs.map((d) => `${d}\n`).join('')}\n`;

  const text = `<[fim-suffix]>${suffix}<[fim-prefix]>${related}${history}<filename>${i.path}\n${before}${markedRegion(i, region)}\n<[fim-middle]>`;
  const regionChars = region.join('\n').length;
  return { prompt: text, prefill: '', stop: [EOS], maxTokens: Math.min(1024, Math.max(256, Math.ceil((regionChars / 3) * 1.5) + 64)) };
}

function parse(answer: string, i: NextEditInput): FormatAnswer {
  const text = answer.endsWith(EOS) ? answer.slice(0, -EOS.length) : answer;
  const tags = [...text.matchAll(/<\|marker_(\d+)\|>/g)];
  if (tags.length < 2) return { kind: 'invalid', why: 'markers' };
  const s = Number(tags[0][1]);
  const e = Number(tags[tags.length - 1][1]);
  if (s === e) return { kind: 'noChange' };

  const region = take(i.lines, i.region);
  const old = region.join('\n');
  const starts = markerBlocks(region);
  // Marker k opens block k; the one after the last block is the end of the text.
  const offsets = starts.map((line) => region.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0));
  offsets.push(old.length);
  if (s < 1 || e > offsets.length || s > e) return { kind: 'invalid', why: 'range' };

  let inner = '';
  for (let n = 0; n + 1 < tags.length; n++) inner += text.slice(tags[n].index + tags[n][0].length, tags[n + 1].index);
  inner = inner.split(CURSOR).join('');
  // The closing marker is glued to the text's end, but a model may put it on its own line.
  if (e === offsets.length && inner.endsWith('\n')) inner = inner.slice(0, -1);

  let head = old.slice(0, offsets[s - 1]);
  // Deleting the tail leaves the newline that ended the line before it.
  if (e === offsets.length && inner === '' && head.endsWith('\n')) head = head.slice(0, -1);
  const next = head + inner + old.slice(offsets[e - 1]);
  return next === old ? { kind: 'noChange' } : { kind: 'rewrite', lines: next.split('\n') };
}

/** Zed's Zeta 2.1 raw prompt: marker-delimited blocks of the editable region, edit history and related files. */
export const zeta21Format: CompletionFormat = {
  id: 'zeta21',
  transport: 'completion',
  region: (cursorLine, lineCount, size) => editableRegion(cursorLine, lineCount, size.above, size.below),
  problem,
  prompt,
  parse,
};
