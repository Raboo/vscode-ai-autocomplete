import { expect, test } from 'vitest';
import { excerptFor, mergeExcerpts, pickIdentifiers, RelatedCache, type SymbolNode } from '../../../src/nextEdit/related';

test('pickIdentifiers sorts by distance, skips keywords and short names, one per name', () => {
  const lines = ['const alpha = foo(beta);', 'return alpha + gamma;', 'function zed() {}', 'ab = beta;'];
  const ids = pickIdentifiers(lines, { start: 0, end: 3 }, { line: 1, character: 10 });
  expect(ids.map((i) => i.name)).toEqual(['alpha', 'gamma', 'zed', 'foo', 'beta']);
  expect(ids.find((i) => i.name === 'alpha')).toEqual({ name: 'alpha', line: 1, character: 7 });
});

test('pickIdentifiers respects max and the region', () => {
  const lines = ['aaa bbb ccc', 'ddd eee', 'fff'];
  expect(pickIdentifiers(lines, { start: 0, end: 1 }, { line: 0, character: 0 }, 2).map((i) => i.name)).toEqual(['aaa', 'bbb']);
  expect(pickIdentifiers(lines, { start: 0, end: 1 }, { line: 0, character: 0 }).map((i) => i.name)).not.toContain('fff');
});

const file = Array.from({ length: 60 }, (_, i) => `line${i}`);

test('excerptFor returns a small symbol whole', () => {
  const syms: SymbolNode[] = [{ range: { start: 5, end: 15 }, children: [] }];
  expect(excerptFor(file, syms, 8)).toEqual([{ start: 5, end: 15 }]);
});

test('excerptFor outlines a long symbol: first line and each child first line', () => {
  const syms: SymbolNode[] = [
    {
      range: { start: 0, end: 49 },
      children: [
        { range: { start: 2, end: 20 }, children: [] },
        { range: { start: 25, end: 45 }, children: [] }
      ]
    }
  ];
  expect(excerptFor(file, syms, 0)).toEqual([
    { start: 0, end: 0 },
    { start: 2, end: 2 },
    { start: 25, end: 25 }
  ]);
  const snip = mergeExcerpts('a.ts', file, excerptFor(file, syms, 0));
  expect(snip.text).toBe('line0\n...\nline2\n...\nline25\n...');
});

test('excerptFor descends to the innermost symbol', () => {
  const syms: SymbolNode[] = [
    { range: { start: 0, end: 49 }, children: [{ range: { start: 2, end: 10 }, children: [] }] }
  ];
  expect(excerptFor(file, syms, 5)).toEqual([{ start: 2, end: 10 }]);
});

test('excerptFor without symbols uses ten lines clipped to the file', () => {
  expect(excerptFor(file, undefined, 5)).toEqual([{ start: 5, end: 14 }]);
  expect(excerptFor(file, [], 55)).toEqual([{ start: 55, end: 59 }]);
  expect(excerptFor(file, [{ range: { start: 0, end: 2 }, children: [] }], 30)).toEqual([{ start: 30, end: 39 }]);
});

test('mergeExcerpts merges overlapping or adjacent spans in row order', () => {
  const s = mergeExcerpts('a.ts', file, [
    { start: 10, end: 11 },
    { start: 2, end: 4 },
    { start: 5, end: 6 }
  ]);
  expect(s.path).toBe('a.ts');
  expect(s.text).toBe('line2\nline3\nline4\nline5\nline6\n...\nline10\nline11\n...');
});

test('mergeExcerpts has no trailing ... at the last line', () => {
  expect(mergeExcerpts('a.ts', file, [{ start: 58, end: 59 }]).text).toBe('line58\nline59');
});

test('RelatedCache ignores the version and returns the same array', () => {
  const c = new RelatedCache();
  const k = c.key('file:///a', 10, ['b', 'a']);
  expect(k).toBe(c.key('file:///a', 10, ['a', 'b']));
  const items = [{ path: 'x.ts', text: 'x' }];
  c.set(k, items);
  expect(c.get(c.key('file:///a', 10, ['a', 'b']))).toBe(items);
  expect(c.get(c.key('file:///a', 11, ['a', 'b']))).toBeUndefined();
});

test('RelatedCache.forgetTarget drops entries containing the path; keeps at most 32', () => {
  const c = new RelatedCache();
  c.set('k1', [{ path: 'x.ts', text: '' }]);
  c.set('k2', [{ path: 'y.ts', text: '' }]);
  c.forgetTarget('x.ts');
  expect(c.get('k1')).toBeUndefined();
  expect(c.get('k2')).toBeDefined();
  for (let i = 0; i < 40; i++) c.set(`n${i}`, []);
  expect(c.get('k2')).toBeUndefined();
  expect(c.get('n0')).toBeUndefined();
  expect(c.get('n39')).toBeDefined();
});
