import type { Snippet } from './history';
import type { LineSpan } from './region';

const KEYWORDS = new Set(
  'const let var function return class interface type import export from async await new this true false null undefined self def elif else then while for if fn pub mut impl struct enum match use mod'.split(
    ' '
  )
);

const MAX_SYMBOL_LINES = 20;
const FALLBACK_LINES = 10;
const MAX_KEYS = 32;

export interface SymbolNode {
  range: LineSpan;
  children: SymbolNode[];
}

/** Names in the region, nearest to the cursor first, one occurrence per name. */
export function pickIdentifiers(
  lines: string[],
  region: LineSpan,
  cursor: { line: number; character: number },
  max = 8
): { name: string; line: number; character: number }[] {
  const best = new Map<string, { name: string; line: number; character: number; dl: number; dc: number }>();
  const last = Math.min(region.end, lines.length - 1);
  for (let line = Math.max(0, region.start); line <= last; line++) {
    for (const m of lines[line].matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      if (name.length < 3 || KEYWORDS.has(name)) continue;
      const cand = { name, line, character: m.index, dl: Math.abs(line - cursor.line), dc: Math.abs(m.index - cursor.character) };
      const old = best.get(name);
      if (!old || cand.dl < old.dl || (cand.dl === old.dl && cand.dc < old.dc)) best.set(name, cand);
    }
  }
  return [...best.values()]
    .sort((a, b) => a.dl - b.dl || a.dc - b.dc || a.line - b.line || a.character - b.character)
    .slice(0, max)
    .map(({ name, line, character }) => ({ name, line, character }));
}

function innermost(symbols: SymbolNode[], line: number): SymbolNode | undefined {
  const hit = symbols.find((s) => s.range.start <= line && line <= s.range.end);
  if (!hit) return undefined;
  return innermost(hit.children, line) ?? hit;
}

/** The lines of the symbol that holds `line`: whole when small, else an outline. */
export function excerptFor(lines: string[], symbols: SymbolNode[] | undefined, line: number): LineSpan[] {
  const sym = symbols ? innermost(symbols, line) : undefined;
  if (!sym) return [{ start: line, end: Math.min(line + FALLBACK_LINES - 1, lines.length - 1) }];
  const { start, end } = sym.range;
  if (end - start + 1 <= MAX_SYMBOL_LINES) return [{ start, end }];
  return [{ start, end: start }, ...sym.children.map((c) => ({ start: c.range.start, end: c.range.start }))];
}

/** One snippet from spans in row order, with `...` where lines are left out. */
export function mergeExcerpts(path: string, lines: string[], spans: LineSpan[]): Snippet {
  const sorted = spans.map((s) => ({ ...s })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineSpan[] = [];
  for (const s of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && s.start <= prev.end + 1) prev.end = Math.max(prev.end, s.end);
    else merged.push(s);
  }
  const out: string[] = [];
  merged.forEach((s, i) => {
    if (i > 0) out.push('...');
    out.push(...lines.slice(s.start, s.end + 1));
  });
  const tail = merged[merged.length - 1];
  if (tail && tail.end < lines.length - 1) out.push('...');
  return { path, text: out.join('\n') };
}

/** Definitions found for a region, kept while the user types. The document version is not part of the key. */
export class RelatedCache {
  private readonly map = new Map<string, Snippet[]>();

  key(uri: string, regionStart: number, names: string[]): string {
    return [uri, String(regionStart), ...[...names].sort()].join('\u0000');
  }

  get(key: string): Snippet[] | undefined {
    return this.map.get(key);
  }

  set(key: string, items: Snippet[]): void {
    this.map.delete(key);
    this.map.set(key, items);
    while (this.map.size > MAX_KEYS) this.map.delete(this.map.keys().next().value as string);
  }

  forgetTarget(path: string): void {
    for (const [k, items] of this.map) if (items.some((s) => s.path === path)) this.map.delete(k);
  }
}
