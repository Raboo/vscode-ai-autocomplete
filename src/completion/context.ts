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

  let startLine = Math.max(0, cursorLine - o.prefixLines);
  let startOffset = starts[startLine];
  if (cursor - startOffset > o.maxPrefixChars) {
    let cut = cursor - o.maxPrefixChars;
    if (cut < starts[cursorLine]) {
      // Cut point is above the cursor line: drop the partial leading line.
      let l = lineAt(starts, cut);
      if (starts[l] < cut) l++;
      startLine = l;
      cut = starts[l];
    } else {
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

interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

function overlapLines(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }): number {
  return Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
}

export class ExtraContextRing {
  private chunks: Chunk[] = [];
  private readonly maxChunks: number;
  private readonly chunkLines: number;

  constructor(o: { maxChunks?: number; chunkLines?: number } = {}) {
    this.maxChunks = o.maxChunks ?? 16;
    this.chunkLines = o.chunkLines ?? 64;
  }

  /** Forgets every chunk, e.g. after the settings that decide which files may be captured changed. */
  clear(): void {
    this.chunks = [];
  }

  add(path: string, lines: string[], centerLine: number): void {
    if (lines.length === 0) return;
    const size = Math.min(this.chunkLines, lines.length);
    const startLine = Math.max(0, Math.min(centerLine - Math.floor(size / 2), lines.length - size));
    const endLine = startLine + size - 1;
    const chunk: Chunk = { path, startLine, endLine, text: lines.slice(startLine, endLine + 1).join('\n') };
    // "Overlap" = shared lines are at least half of the shorter chunk.
    this.chunks = this.chunks.filter((c) => c.path !== path || overlapLines(c, chunk) * 2 < Math.min(c.endLine - c.startLine + 1, size));
    this.chunks.push(chunk);
    if (this.chunks.length > this.maxChunks) this.chunks.splice(0, this.chunks.length - this.maxChunks);
  }

  /** Newest chunks that fit the budget, returned oldest-first so the prompt prefix stays stable (llama.cpp cache). */
  pick(exclude: { path: string; startLine: number; endLine: number }, budgetChars: number): ContextFile[] {
    let remaining = budgetChars;
    const chosen: Chunk[] = [];
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      if (c.path === exclude.path && overlapLines(c, exclude) > 0) continue;
      if (c.text.length > remaining) continue;
      remaining -= c.text.length;
      chosen.push(c);
    }
    return chosen.reverse().map((c) => ({ path: c.path, text: c.text }));
  }
}
