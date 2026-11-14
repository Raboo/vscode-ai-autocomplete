import { describe, expect, test } from 'vitest';
import { buildFimWindow, ExtraContextRing } from '../../src/completion/context';

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
});
