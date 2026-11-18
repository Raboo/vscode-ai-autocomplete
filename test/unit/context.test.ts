import { describe, expect, test } from 'vitest';
import { buildFimWindow, buildFimWindowIn, ExtraContextRing, fimLineRange, type LineSource } from '../../src/completion/context';
import { contextCaps } from '../../src/completion/effective';

const doc = (n: number, w = 10) => Array.from({ length: n }, (_, i) => String(i).padStart(w, '0'));
const OPTS = { prefixLines: 200, suffixLines: 60, maxPrefixChars: 8000, maxSuffixChars: 2500 };
const ex = (path: string, startLine: number, endLine: number) => ({ path, startLine, endLine });

describe('buildFimWindow', () => {
  test('takes N lines before and after the cursor', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line${i}`);
    const text = lines.join('\n');
    const offset = lines.slice(0, 250).join('\n').length + 1 + 3;
    const w = buildFimWindow(text, offset, OPTS);
    expect(w.startLine).toBe(50);
    expect(w.endLine).toBe(310);
    expect(w.prefix.startsWith('line50\n')).toBe(true);
    expect(w.prefix.endsWith('\nlin')).toBe(true);
    expect(w.suffix.startsWith('e250\n')).toBe(true);
    expect(w.suffix.endsWith('line310')).toBe(true);
  });

  test('clamps at document edges and treats CRLF as one break', () => {
    const w = buildFimWindow('a\r\nb\r\nc', 3, OPTS);
    expect(w).toEqual({ prefix: 'a\r\n', suffix: 'b\r\nc', startLine: 0, endLine: 2 });
    const w2 = buildFimWindow('a\r\nb\r\nc', 3, { ...OPTS, suffixLines: 0 });
    expect(w2.suffix).toBe('b');
  });

  test('empty document', () => {
    expect(buildFimWindow('', 0, OPTS)).toEqual({ prefix: '', suffix: '', startLine: 0, endLine: 0 });
  });

  test('caps a 1 MB single line', () => {
    const w = buildFimWindow('x'.repeat(1_000_000), 500_000, OPTS);
    expect(w.prefix.length).toBeLessThanOrEqual(8000);
    expect(w.suffix.length).toBeLessThanOrEqual(2500);
    expect(w.prefix.length).toBe(8000);
    expect(w.suffix.length).toBe(2500);
  });

  test('char cap drops whole leading lines when possible', () => {
    const lines = doc(300, 100);
    const text = lines.join('\n');
    const offset = text.indexOf(lines[250]) + 4;
    const w = buildFimWindow(text, offset, OPTS);
    expect(w.prefix.length).toBeLessThanOrEqual(8000);
    expect(w.prefix.split('\n')[0]).toHaveLength(100);
    expect(w.prefix).toBe(text.slice(text.indexOf(lines[w.startLine]), offset));
    expect(w.startLine).toBeGreaterThan(50);
  });

  test('char cap drops whole trailing lines when possible', () => {
    const lines = doc(300);
    const text = lines.join('\n');
    const offset = text.indexOf(lines[10]) + 4;
    const w = buildFimWindow(text, offset, { ...OPTS, suffixLines: 280 });
    expect(w.suffix.length).toBeLessThanOrEqual(2500);
    expect(w.suffix.endsWith(lines[w.endLine])).toBe(true);
    expect(w.suffix.split('\n').at(-1)).toHaveLength(10);
    expect(w.endLine).toBeLessThan(10 + 280);
    expect(w.endLine).toBeLessThanOrEqual(10 + 227);
  });

  test('cut inside the cursor line keeps the partial line', () => {
    const text = 'a\n' + 'y'.repeat(20) + 'CURSOR' + 'z'.repeat(20) + '\nb';
    const offset = 2 + 20;
    const w = buildFimWindow(text, offset, { prefixLines: 5, suffixLines: 5, maxPrefixChars: 10, maxSuffixChars: 10 });
    expect(w.prefix).toBe('y'.repeat(10));
    expect(w.suffix).toBe('CURSORzzzz');
    expect(w.startLine).toBe(1);
    expect(w.endLine).toBe(1);
  });
});

describe('stepped prefix window', () => {
  const o = { prefixLines: 8, suffixLines: 2, maxPrefixChars: 8000, maxSuffixChars: 2500 };
  const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
  const text = lines.join('\n');
  const at = (line: number, col = 0) => text.indexOf(`line${line}\n`) + col;

  test('the window start moves in steps', () => {
    expect(buildFimWindow(text, at(20), o).startLine).toBe(12);
    expect(buildFimWindow(text, at(21), o).startLine).toBe(12);
    expect(buildFimWindow(text, at(22), o).startLine).toBe(14);
  });

  test('stepped window respects the char cap', () => {
    const wide = Array.from({ length: 100 }, () => 'x'.repeat(99)).join('\n'); // 100 chars per line
    const w = buildFimWindow(wide, 50 * 100 + 3, { ...o, maxPrefixChars: 450 });
    expect(w.prefix.length).toBeLessThanOrEqual(450);
    expect(w.prefix.startsWith('x'.repeat(99) + '\n')).toBe(true);
    expect(w.startLine).toBe(46);
  });

  test('when the cap binds, every whole line that fits is kept, not only whole steps', () => {
    const wide = Array.from({ length: 100 }, () => 'x'.repeat(99)).join('\n'); // 100 chars per line
    const w = buildFimWindow(wide, 50 * 100 + 3, { ...o, maxPrefixChars: 550 });
    expect(w.startLine).toBe(45); // 5 lines + 3 chars = 503 fit; a step-aligned start (46) would drop one
    expect(w.prefix).toBe(wide.slice(45 * 100, 50 * 100 + 3));
  });

  test('stepped window never drops every line that fits', () => {
    // prefixLines 1000 (step 250), 40-char lines, the default cap: no step-aligned start fits, but 205 lines do.
    const cap = contextCaps(4700).maxPrefixChars;
    const lines = doc(1300, 39);
    const text = lines.join('\n');
    const offset = 1210 * 40;
    const w = buildFimWindow(text, offset, { prefixLines: 1000, suffixLines: 2, maxPrefixChars: cap, maxSuffixChars: 2500 });
    expect(cap).toBe(8225);
    expect(w.startLine).toBe(1005);
    expect(w.prefix).toBe(text.slice(1005 * 40, offset));
    expect(w.prefix.length + 40).toBeGreaterThan(cap); // one more line would not fit
  });

  test('200-char lines at the default prefixLines and cap keep the lines that fit', () => {
    const cap = contextCaps(4700).maxPrefixChars;
    const lines = doc(1300, 200);
    const text = lines.join('\n');
    const offset = 1201 * 201 + 4; // just past a step boundary (step 50)
    const w = buildFimWindow(text, offset, { prefixLines: 200, suffixLines: 60, maxPrefixChars: cap, maxSuffixChars: 2500 });
    expect(w.startLine).toBe(1161); // 40 whole lines above the cursor line fit
    expect(w.prefix).toBe(text.slice(1161 * 201, offset));
    expect(w.prefix.length).toBeLessThanOrEqual(cap);
  });

  test('stepped window keeps the cursor line', () => {
    const w = buildFimWindow(text, at(50, 3), { ...o, maxPrefixChars: 3 });
    expect(w.startLine).toBe(50);
    expect(w.prefix).toBe('lin');
    const w2 = buildFimWindow(text, at(50, 5), { ...o, maxPrefixChars: 3 });
    expect(w2.prefix).toBe('ne5');
  });
});

/** A document read by line range, as the provider reads a VS Code document. */
function source(text: string): LineSource & { read: number } {
  const lines = text.split(/\r?\n/);
  const starts = [0];
  for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', nl + 1)) starts.push(nl + 1);
  const src = {
    read: 0,
    lineCount: lines.length,
    offsetAt: (line: number, character: number) => starts[line] + character,
    text(first: number, last: number) {
      const t = text.slice(starts[first], starts[last] + lines[last].length);
      src.read += t.length;
      return t;
    },
  };
  return src;
}

describe('buildFimWindowIn', () => {
  const cases: [string, string, typeof OPTS][] = [
    ['LF', doc(900, 12).join('\n'), OPTS],
    ['CRLF', doc(900, 12).join('\r\n'), OPTS],
    ['prefix cap binds', doc(900, 40).join('\n'), { ...OPTS, maxPrefixChars: 1000, maxSuffixChars: 300 }],
    ['long cursor line', [...doc(300), 'x'.repeat(9000), ...doc(300)].join('\n'), OPTS],
    ['short file', doc(5).join('\n'), OPTS],
    ['empty', '', OPTS],
  ];
  test.each(cases)('gives the same window as the whole text (%s)', (_, text, o) => {
    const lines = text.split(/\r?\n/);
    for (let line = 0; line < lines.length; line += 7) {
      for (const character of [0, Math.floor(lines[line].length / 2), lines[line].length]) {
        const src = source(text);
        const offset = src.offsetAt(line, character);
        expect(buildFimWindowIn(src, line, character, o), `line ${line}:${character}`).toEqual(buildFimWindow(text, offset, o));
      }
    }
  });

  test('reads only the lines the window may use', () => {
    const text = doc(5000, 12).join('\n');
    const src = source(text);
    buildFimWindowIn(src, 2500, 3, OPTS);
    expect(src.read).toBeLessThan(13 * (OPTS.prefixLines + OPTS.suffixLines + OPTS.prefixLines / 4 + 2));
  });

  test('the range starts at the step-aligned prefix start and ends suffixLines below the cursor', () => {
    expect(fimLineRange(250, 500, OPTS)).toEqual({ first: 50, last: 310 });
    expect(fimLineRange(251, 500, OPTS)).toEqual({ first: 50, last: 311 });
    expect(fimLineRange(10, 500, OPTS)).toEqual({ first: 0, last: 70 });
    expect(fimLineRange(480, 500, OPTS)).toEqual({ first: 250, last: 499 });
  });
});

describe('ExtraContextRing', () => {
  const lines = doc(1000);

  test('chunk is centred, clamped, and joined with newlines', () => {
    const r = new ExtraContextRing({ chunkLines: 4 });
    r.add('a', ['0', '1', '2', '3', '4', '5', '6', '7'], 4);
    r.add('b', ['0', '1', '2'], 0);
    r.add('c', ['0', '1', '2', '3', '4', '5', '6', '7'], 100);
    expect(r.pick(ex('z', 0, 0), 1000)).toEqual([
      { path: 'a', text: '2\n3\n4\n5' },
      { path: 'b', text: '0\n1\n2' },
      { path: 'c', text: '4\n5\n6\n7' },
    ]);
  });

  test('keeps insertion order and evicts oldest beyond maxChunks', () => {
    const r = new ExtraContextRing({ maxChunks: 3 });
    for (const p of ['a', 'b', 'c', 'd']) r.add(p, lines, 500);
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['b', 'c', 'd']);
  });

  test('replaces an overlapping chunk of the same file, most recent last', () => {
    const r = new ExtraContextRing();
    r.add('a', lines, 100);
    r.add('b', lines, 100);
    r.add('a', lines, 110);
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['b', 'a']);
  });

  test('keeps non-overlapping chunks of the same file', () => {
    const r = new ExtraContextRing();
    r.add('a', lines, 100);
    r.add('a', lines, 300);
    expect(r.pick(ex('z', 0, 0), 1e6)).toHaveLength(2);
  });

  test('pick skips chunks overlapping the current window and respects budget', () => {
    const r = new ExtraContextRing({ chunkLines: 10 });
    r.add('a', lines, 100); // 95..104
    r.add('a', lines, 500); // 495..504
    r.add('b', lines, 100);
    const got = r.pick(ex('a', 100, 200), 1e6);
    expect(got.map((c) => `${c.path}:${c.text.slice(0, 10)}`)).toEqual(['a:0000000495', 'b:0000000095']);
    expect(r.pick(ex('z', 0, 0), 0)).toEqual([]);
    expect(r.pick(ex('z', 0, 0), 108)).toEqual([]);
  });

  test('with a budget for only two chunks the two newest return, oldest-first', () => {
    const r = new ExtraContextRing({ chunkLines: 2 });
    for (const p of ['a', 'b', 'c', 'd']) r.add(p, ['xxxx', 'yyyy'], 0); // 9 chars each, distinct paths
    expect(r.pick(ex('z', 0, 0), 18).map((c) => c.path)).toEqual(['c', 'd']);
  });

  test('skips a chunk that does not fit but keeps trying older ones', () => {
    const r = new ExtraContextRing({ chunkLines: 1 });
    r.add('small', ['ab'], 0);
    r.add('big', ['x'.repeat(50)], 0);
    expect(r.pick(ex('z', 0, 0), 10).map((c) => c.path)).toEqual(['small']);
  });

  test('clear drops every chunk', () => {
    const r = new ExtraContextRing();
    for (const p of ['a', 'b']) r.add(p, lines, 200);
    r.clear();
    expect(r.pick(ex('z', 0, 0), 1e6)).toEqual([]);
    r.add('c', lines, 200);
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['c']);
  });

  test('pick output is stable across calls (cache-friendly order)', () => {
    const r = new ExtraContextRing();
    for (const p of ['a', 'b', 'c']) r.add(p, lines, 200);
    const first = r.pick(ex('z', 0, 0), 1e6);
    expect(r.pick(ex('z', 0, 0), 1e6)).toEqual(first);
    expect(first.map((c) => c.path)).toEqual(['a', 'b', 'c']);
  });

  test('order stays stable when the picked set is unchanged', () => {
    const r = new ExtraContextRing();
    r.add('a', lines, 200);
    r.add('b', lines, 200);
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['a', 'b']);
    r.add('a', lines, 200); // a is now the newest, but the set is the same
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['a', 'b']);
    r.add('b', lines, 200);
    r.add('a', lines, 200);
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['a', 'b']);
  });

  /** Budget for exactly two default (64-line) chunks of `lines`. */
  const TWO = 2 * lines.slice(0, 64).join('\n').length;

  test('membership follows recency: after 13 newer files are viewed the oldest earlier picks drop out', () => {
    const r = new ExtraContextRing();
    r.add('a', lines, 200);
    r.add('b', lines, 200);
    expect(r.pick(ex('z', 0, 0), TWO).map((c) => c.path)).toEqual(['a', 'b']);
    for (let i = 1; i <= 13; i++) r.add(`n${i}`, lines, 200);
    expect(r.pick(ex('z', 0, 0), TWO).map((c) => c.path)).toEqual(['n12', 'n13']);
  });

  test('a re-added identical chunk counts as recent and stays in the set', () => {
    const r = new ExtraContextRing();
    r.add('a', lines, 200);
    r.add('b', lines, 200);
    expect(r.pick(ex('z', 0, 0), TWO).map((c) => c.path)).toEqual(['a', 'b']);
    r.add('c', lines, 200);
    r.add('a', lines, 200); // same text as before: a is the newest again
    expect(r.pick(ex('z', 0, 0), TWO).map((c) => c.path)).toEqual(['a', 'c']);
  });

  test('pick keeps earlier picks first and appends new ones', () => {
    const r = new ExtraContextRing();
    r.add('a', lines, 200);
    r.add('b', lines, 200);
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['a', 'b']);
    r.add('c', lines, 200);
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['a', 'b', 'c']);
    r.add('a', lines, 600); // new chunk of a: appended last
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['a', 'b', 'c', 'a']);
  });

  test('a smaller budget keeps the newest chunks, earlier picks first in their order', () => {
    const r = new ExtraContextRing({ chunkLines: 1 });
    for (const p of ['a', 'b', 'c']) r.add(p, ['xxxx'], 0);
    expect(r.pick(ex('z', 0, 0), 1e6).map((c) => c.path)).toEqual(['a', 'b', 'c']);
    r.add('d', ['xxxx'], 0);
    expect(r.pick(ex('z', 0, 0), 8).map((c) => c.path)).toEqual(['c', 'd']);
    expect(r.pick(ex('z', 0, 0), 12).map((c) => c.path)).toEqual(['c', 'd', 'b']);
  });
});
