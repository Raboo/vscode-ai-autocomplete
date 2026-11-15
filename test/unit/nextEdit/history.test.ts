import { expect, test } from 'vitest';
import { EditHistory, RecentSnippets, renderDiff } from '../../../src/nextEdit/history';

test('renderDiff renders zero-context hunks with 1-based numbers', () => {
  expect(renderDiff('f.py', 'a\nb\nc\n', 'a\nB\nc\n')).toBe('--- f.py\n+++ f.py\n@@ -2,1 +2,1 @@\n-b\n+B');
});
test('renderDiff of equal texts is undefined', () => {
  expect(renderDiff('f.py', 'a\nb\n', 'a\nb\n')).toBeUndefined();
});
test('renderDiff treats CRLF and LF lines alike', () => {
  expect(renderDiff('f.py', 'a\r\nb', 'a\nb')).toBeUndefined();
});

test('commit without a snapshot only snapshots', () => {
  const h = new EditHistory();
  h.commit('f', 'a\n');
  expect(h.entries()).toEqual([]);
  h.commit('f', 'b\n');
  expect(h.entries()).toHaveLength(1);
});

test('entries are oldest first and capped at 5', () => {
  const h = new EditHistory();
  const lines = Array.from({ length: 8 }, (_, i) => `l${i}`);
  let text = lines.join('\n') + '\n';
  h.open('f', text);
  for (let i = 0; i < 7; i++) {
    lines[i] = `L${i}`;
    text = lines.join('\n') + '\n';
    h.commit('f', text);
  }
  const e = h.entries();
  expect(e).toHaveLength(5);
  expect(e[0].text).toContain('-l2\n+L2');
  expect(e[4].text).toContain('-l6\n+L6');
});

test('same-start-line edits merge into one entry', () => {
  const h = new EditHistory();
  h.open('f', 'x = 1\n');
  h.commit('f', 'x = 12\n');
  h.commit('f', 'x = 123\n');
  expect(h.entries().map((e) => e.text)).toEqual(['--- f\n+++ f\n@@ -1,1 +1,1 @@\n-x = 1\n+x = 123']);
  h.commit('f', 'x = 123\ny = 2\n');
  expect(h.entries()).toHaveLength(2);
});

test('entries(filter) drops other files', () => {
  const h = new EditHistory();
  h.open('a', '1\n');
  h.open('b', '1\n');
  h.commit('a', '2\n');
  h.commit('b', '2\n');
  expect(h.entries()).toHaveLength(2);
  const only = h.entries((p) => p === 'a');
  expect(only).toHaveLength(1);
  expect(only[0].path).toBe('a');
});

test('close and clear forget snapshots and entries', () => {
  const h = new EditHistory();
  h.open('a', '1\n');
  h.commit('a', '2\n');
  h.close('a');
  h.commit('a', '3\n');
  expect(h.entries()).toHaveLength(1);
  h.clear();
  expect(h.entries()).toEqual([]);
});

test('RecentSnippets keeps one snippet per file, newest last, at most 5', () => {
  const s = new RecentSnippets();
  s.add('a', ['1'], 0);
  s.add('b', ['2'], 0);
  s.add('a', ['3'], 0);
  expect(s.pick('', 1000).map((x) => x.path)).toEqual(['b', 'a']);
  for (const p of ['c', 'd', 'e', 'f']) s.add(p, ['x'], 0);
  expect(s.pick('', 1000).map((x) => x.path)).toEqual(['a', 'c', 'd', 'e', 'f']);
});

test('RecentSnippets trims to 20 lines around the center line', () => {
  const s = new RecentSnippets();
  const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
  s.add('a', lines, 50);
  const t = s.pick('', 10000)[0].text.split('\n');
  expect(t).toHaveLength(20);
  expect(t).toContain('l50');
  expect(t[0]).toBe('l40');
});

test('RecentSnippets.pick skips the excluded path and keeps the newest that fit the budget, returned oldest first', () => {
  const s = new RecentSnippets();
  s.add('a', ['aaaa'], 0);
  s.add('b', ['bbbb'], 0);
  s.add('c', ['cccc'], 0);
  s.add('d', ['dddd'], 0);
  expect(s.pick('d', 8).map((x) => x.path)).toEqual(['b', 'c']);
  expect(s.pick('', 4).map((x) => x.path)).toEqual(['d']);
});

test('RecentSnippets.clear forgets every snippet', () => {
  const s = new RecentSnippets();
  s.add('a', ['aaaa'], 0);
  s.clear();
  expect(s.pick('', 100)).toEqual([]);
});

test('renderDiff keeps no-newline markers out of the diff', () => {
  expect(renderDiff('f.py', 'a\nb', 'a\nB')).toBe('--- f.py\n+++ f.py\n@@ -2,1 +2,1 @@\n-b\n+B');
  expect(renderDiff('f.py', 'a\nb', 'a\nb\n')).toBeUndefined();
  const d = renderDiff('f.py', 'a\nb\n', 'a\nb\nc') as string;
  expect(d).toBe('--- f.py\n+++ f.py\n@@ -2,0 +3,1 @@\n+c');
  expect(d).not.toContain('\\');
});

test('renderDiff numbers empty ranges with the line before them', () => {
  expect(renderDiff('f.py', 'a\nb\nc\nd\n', 'a\nb\nd\n')).toBe('--- f.py\n+++ f.py\n@@ -3,1 +2,0 @@\n-c');
});
