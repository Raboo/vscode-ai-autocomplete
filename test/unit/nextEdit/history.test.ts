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

test('forget drops one path\'s snapshot and entries', () => {
  const h = new EditHistory();
  h.open('a', 'x\n');
  h.commit('a', 'y\n');
  h.open('b', 'p\n');
  h.commit('b', 'q\n');
  h.forget('a');
  expect(h.entries().map((e) => e.path)).toEqual(['b']);
  // Without a snapshot the next commit only snapshots.
  h.commit('a', 'z\n');
  expect(h.entries().map((e) => e.path)).toEqual(['b']);
});

test('RecentSnippets.forget drops that path\'s snippet', () => {
  const s = new RecentSnippets();
  s.add('a', ['aaaa'], 0);
  s.add('b', ['bbbb'], 0);
  s.forget('a');
  expect(s.pick('', 100).map((x) => x.path)).toEqual(['b']);
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

test('renderDiff of an empty text adds no blank line', () => {
  expect(renderDiff('f.py', '', 'x')).toBe('--- f.py\n+++ f.py\n@@ -0,0 +1,1 @@\n+x');
  expect(renderDiff('f.py', 'x', '')).toBe('--- f.py\n+++ f.py\n@@ -1,1 +0,0 @@\n-x');
});

test('a change too large to diff quickly records no entry and keeps the new snapshot', () => {
  const h = new EditHistory();
  const lines = Array.from({ length: 3000 }, (_, i) => `x${i} = ${i}`);
  h.open('f', lines.join('\n') + '\n');
  const reindented = lines.map((l) => `    ${l}`).join('\n') + '\n';
  const started = performance.now();
  h.commit('f', reindented);
  // Unbounded, this diff took seconds; the bound is loose for slow CI runners.
  expect(performance.now() - started).toBeLessThan(1000);
  expect(h.entries()).toEqual([]);
  // The next edit is diffed against the new text.
  h.commit('f', reindented.replace('    x0 = 0\n', '    x0 = 1\n'));
  expect(h.entries().map((e) => e.text)).toEqual(['--- f\n+++ f\n@@ -1,1 +1,1 @@\n-    x0 = 0\n+    x0 = 1']);
});

test('edits that cancel out drop the merged entry', () => {
  const h = new EditHistory();
  h.open('f', 'x = 1\ny = 2\n');
  h.commit('f', 'x = 1\ny = 2\nz = 3\n');
  h.commit('f', 'x = 12\ny = 2\nz = 3\n');
  h.commit('f', 'x = 1\ny = 2\nz = 3\n');
  expect(h.entries().map((e) => e.text)).toEqual(['--- f\n+++ f\n@@ -2,0 +3,1 @@\n+z = 3']);
});

test('a merge keeps the count, and the next new entry drops the oldest', () => {
  const h = new EditHistory();
  const lines = Array.from({ length: 8 }, (_, i) => `l${i}`);
  const text = () => lines.join('\n') + '\n';
  h.open('f', text());
  for (let i = 0; i < 5; i++) {
    lines[i] = `L${i}`;
    h.commit('f', text());
  }
  lines[4] = 'M4';
  h.commit('f', text());
  let e = h.entries();
  expect(e).toHaveLength(5);
  expect(e[4].text).toBe('--- f\n+++ f\n@@ -5,1 +5,1 @@\n-l4\n+M4');
  lines[6] = 'L6';
  h.commit('f', text());
  e = h.entries();
  expect(e).toHaveLength(5);
  expect(e[0].text).toContain('-l1\n+L1');
  expect(e[3].text).toContain('-l4\n+M4');
  expect(e[4].text).toContain('-l6\n+L6');
});

test('when the merged diff is too large, the edit becomes its own entry', () => {
  const h = new EditHistory();
  const lines = Array.from({ length: 1000 }, (_, i) => `x${i}`);
  const text = () => lines.join('\n') + '\n';
  h.open('f', text());
  // 200 changed lines: 400 edits, within the bound.
  for (let i = 0; i < 200; i++) lines[i] = `y${i}`;
  h.commit('f', text());
  // Starts on the same line, so it would merge, but from the first snapshot it is 400 changed lines.
  lines[0] = 'z0';
  for (let i = 200; i < 400; i++) lines[i] = `y${i}`;
  h.commit('f', text());
  const e = h.entries();
  expect(e).toHaveLength(2);
  expect(e[1].text.startsWith('--- f\n+++ f\n@@ -1,1 +1,1 @@\n-y0\n+z0\n@@ -201,200 +201,200 @@\n')).toBe(true);
});
