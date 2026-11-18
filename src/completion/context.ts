import type { ContextFile } from '../types';

export interface FimWindowOptions {
  prefixLines: number;
  suffixLines: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
}

/** Offsets of each line's first character and of its end (before the \r?\n terminator). */
function indexLines(text: string): { starts: number[]; ends: number[] } {
  const starts = [0];
  const ends: number[] = [];
  let nl = text.indexOf('\n');
  while (nl !== -1) {
    ends.push(nl > 0 && text[nl - 1] === '\r' ? nl - 1 : nl);
    starts.push(nl + 1);
    nl = text.indexOf('\n', nl + 1);
  }
  ends.push(text.length);
  return { starts, ends };
}

/** Index of the last line whose start is <= offset. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function buildFimWindow(text: string, offset: number, o: FimWindowOptions): { prefix: string; suffix: string; startLine: number; endLine: number } {
  const { starts, ends } = indexLines(text);
  const last = starts.length - 1;
  const cursor = Math.max(0, Math.min(offset, text.length));
  const cursorLine = lineAt(starts, cursor);

  // The start moves in steps of a quarter of prefixLines, so the prompt start stays the same for many keystrokes (server prompt caches).
  const step = Math.max(1, Math.floor(o.prefixLines / 4));
  let startLine = Math.max(0, Math.floor((cursorLine - o.prefixLines) / step) * step);
  let startOffset = starts[startLine];
  if (cursor - startOffset > o.maxPrefixChars) {
    // The cap binds: keep every whole line that fits. A step-aligned start could leave only the cursor line.
    let cut = cursor - o.maxPrefixChars;
    if (cut < starts[cursorLine]) {
      // Cut point is above the cursor line: drop the partial leading line.
      let l = lineAt(starts, cut);
      if (starts[l] < cut) l++;
      startLine = l;
      cut = starts[l];
    } else {
      // The cursor line alone is over the cap: cut inside it.
      startLine = cursorLine;
    }
    startOffset = cut;
  }

  let endLine = Math.min(last, cursorLine + o.suffixLines);
  let endOffset = ends[endLine];
  if (endOffset - cursor > o.maxSuffixChars) {
    const cut = cursor + o.maxSuffixChars;
    if (cut > ends[cursorLine]) {
      // Cut point is below the cursor line: drop the partial trailing line.
      let l = lineAt(starts, cut);
      if (ends[l] > cut) l--;
      endLine = Math.max(l, cursorLine);
      endOffset = ends[endLine];
    } else {
      endLine = cursorLine;
      endOffset = cut;
    }
  }

  return { prefix: text.slice(startOffset, cursor), suffix: text.slice(cursor, endOffset), startLine, endLine };
}

/** A document read by line range, so a keystroke does not copy the whole text. */
export interface LineSource {
  readonly lineCount: number;
  /** The text from the start of line `first` to the end of line `last` (without its line break). */
  text(first: number, last: number): string;
  offsetAt(line: number, character: number): number;
}

/**
 * The lines buildFimWindow can use for a cursor on `cursorLine`: from the step-aligned prefix start (a multiple of the
 * step, so the window over just these lines starts on the same line) to suffixLines below the cursor.
 */
export function fimLineRange(cursorLine: number, lineCount: number, o: Pick<FimWindowOptions, 'prefixLines' | 'suffixLines'>): { first: number; last: number } {
  const step = Math.max(1, Math.floor(o.prefixLines / 4));
  const first = Math.max(0, Math.floor((cursorLine - o.prefixLines) / step) * step);
  return { first, last: Math.max(cursorLine, Math.min(lineCount - 1, cursorLine + o.suffixLines)) };
}

/** buildFimWindow over the lines of fimLineRange only; the same window as over the whole text. */
export function buildFimWindowIn(src: LineSource, cursorLine: number, character: number, o: FimWindowOptions): ReturnType<typeof buildFimWindow> {
  const { first, last } = fimLineRange(cursorLine, src.lineCount, o);
  const w = buildFimWindow(src.text(first, last), src.offsetAt(cursorLine, character) - src.offsetAt(first, 0), o);
  return { ...w, startLine: w.startLine + first, endLine: w.endLine + first };
}

interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: Set<string>;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** The lower-cased identifiers of at least two characters in the text. */
export function identifierTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENTIFIER)) if (m[0].length >= 2) out.add(m[0].toLowerCase());
  return out;
}

const QUERY_PREFIX_LINES = 30;
const QUERY_SUFFIX_LINES = 10;

/** The identifiers around the cursor (the prefix's last 30 lines and the suffix's first 10) that extra-context chunks are ranked against. */
export function cursorQuery(prefix: string, suffix: string): Set<string> {
  const before = prefix.split('\n').slice(-QUERY_PREFIX_LINES).join('\n');
  const after = suffix.split('\n').slice(0, QUERY_SUFFIX_LINES).join('\n');
  return identifierTokens(`${before}\n${after}`);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

function overlapLines(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }): number {
  return Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
}

function chunkKey(c: Chunk): string {
  return `${c.path}:${c.startLine}`;
}

export class ExtraContextRing {
  private chunks: Chunk[] = [];
  private lastPicked: string[] = [];
  private readonly maxChunks: number;
  private readonly chunkLines: number;

  constructor(o: { maxChunks?: number; chunkLines?: number } = {}) {
    this.maxChunks = o.maxChunks ?? 16;
    this.chunkLines = o.chunkLines ?? 64;
  }

  /** Forgets every chunk, e.g. after the settings that decide which files may be captured changed. */
  clear(): void {
    this.chunks = [];
    this.lastPicked = [];
  }

  add(path: string, lines: string[], centerLine: number): void {
    if (lines.length === 0) return;
    const size = Math.min(this.chunkLines, lines.length);
    const startLine = Math.max(0, Math.min(centerLine - Math.floor(size / 2), lines.length - size));
    const endLine = startLine + size - 1;
    const text = lines.slice(startLine, endLine + 1).join('\n');
    const chunk: Chunk = { path, startLine, endLine, text, tokens: identifierTokens(text) };
    // "Overlap" = shared lines are at least half of the shorter chunk. Re-capturing the same lines makes the chunk the newest
    // under the same key (`path:startLine`), so pick() still keeps its place in the prompt.
    this.chunks = this.chunks.filter((c) => c.path !== path || overlapLines(c, chunk) * 2 < Math.min(c.endLine - c.startLine + 1, size));
    this.chunks.push(chunk);
    if (this.chunks.length > this.maxChunks) this.chunks.splice(0, this.chunks.length - this.maxChunks);
  }

  /**
   * The chunks most similar to `query` (Jaccard over identifier tokens) that fit the budget, ties and zero-overlap chunks
   * newest first; without a query, simply the newest. Those returned last time (same `path:startLine`) come first in the same
   * order, the others follow in ring order (oldest first), so the prompt prefix stays stable while the set does not change
   * (server prompt caches).
   */
  pick(exclude: { path: string; startLine: number; endLine: number }, budgetChars: number, query: Set<string> = new Set()): ContextFile[] {
    const candidates = this.chunks
      .map((c, index) => ({ c, index, score: jaccard(query, c.tokens) }))
      .filter(({ c }) => !(c.path === exclude.path && overlapLines(c, exclude) > 0))
      .sort((x, y) => y.score - x.score || y.index - x.index);
    let remaining = budgetChars;
    const picked: { c: Chunk; index: number }[] = [];
    for (const x of candidates) {
      if (x.c.text.length > remaining) continue;
      remaining -= x.c.text.length;
      picked.push(x);
    }
    const members = picked.sort((x, y) => x.index - y.index).map((x) => x.c);
    const byKey = new Map(members.map((c) => [chunkKey(c), c]));
    const kept = this.lastPicked.flatMap((key) => byKey.get(key) ?? []);
    const chosen = [...kept, ...members.filter((c) => !kept.includes(c))];
    this.lastPicked = chosen.map(chunkKey);
    return chosen.map((c) => ({ path: c.path, text: c.text }));
  }
}

/**
 * The extra context of a completion: the ring's chunks ranked by `query`, then the recent edits (most volatile, so last),
 * all within `budgetChars`. The recent edits are sized first and the chunks get what they leave.
 */
export function buildExtraContext(
  ring: ExtraContextRing,
  exclude: { path: string; startLine: number; endLine: number },
  budgetChars: number,
  query: Set<string>,
  recentEdits?: (maxChars: number) => ContextFile | undefined,
): ContextFile[] {
  const recent = recentEdits?.(budgetChars);
  const chunks = ring.pick(exclude, budgetChars - (recent?.text.length ?? 0), query);
  return recent ? [...chunks, recent] : chunks;
}
