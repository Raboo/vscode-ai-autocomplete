import { expect, test } from 'vitest';
import { EditHistory, recentEditsFile, RecentSnippets, renderDiff, spanBefore } from '../../../src/nextEdit/history';

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

test('entries carry zero-context hunks', () => {
  const h = new EditHistory();
  h.open('f', 'a\nb\nc\n');
  h.commit('f', 'a\nB\nB2\nc\n');
  const e = h.entries();
  expect(e).toHaveLength(1);
  expect(e[0].hunks).toEqual([{ oldStart: 1, newStart: 1, oldLines: ['b'], newLines: ['B', 'B2'] }]);
  expect(e[0].text).toBe('--- f\n+++ f\n@@ -2,1 +2,2 @@\n-b\n+B\n+B2');
});

test('a pure insertion has an empty old side', () => {
  const h = new EditHistory();
  h.open('f', 'a\nc\n');
  h.commit('f', 'a\nb\nc\n');
  expect(h.entries()[0].hunks).toEqual([{ oldStart: 1, newStart: 1, oldLines: [], newLines: ['b'] }]);
});

test('a pure deletion has an empty new side', () => {
  const h = new EditHistory();
  h.open('f', 'a\nb\nc\n');
  h.commit('f', 'a\nc\n');
  expect(h.entries()[0].hunks).toEqual([{ oldStart: 1, newStart: 1, oldLines: ['b'], newLines: [] }]);
});

test('previous gives the text before the latest change', () => {
  const h = new EditHistory();
  h.open('f', 'a\nb\nc\n');
  h.commit('f', 'a\nB\nB2\nc\n');
  expect(h.previous('f')).toEqual({
    lines: ['a', 'b', 'c'],
    hunks: [{ oldStart: 1, newStart: 1, oldLines: ['b'], newLines: ['B', 'B2'] }],
  });
  expect(h.previous('other')).toBeUndefined();
});

test('previous follows a merged entry', () => {
  const h = new EditHistory();
  h.open('f', 'x = 1\ny = 2\n');
  h.commit('f', 'x = 12\ny = 2\n');
  h.commit('f', 'x = 123\ny = 2\n');
  expect(h.entries()).toHaveLength(1);
  expect(h.previous('f')).toEqual({
    lines: ['x = 1', 'y = 2'],
    hunks: [{ oldStart: 0, newStart: 0, oldLines: ['x = 1'], newLines: ['x = 123'] }],
  });
});

test('previous is the newest entry of that path only', () => {
  const h = new EditHistory();
  h.open('a', '1\n');
  h.open('b', 'p\n');
  h.commit('a', '2\n');
  h.commit('b', 'q\n');
  expect(h.previous('a')?.lines).toEqual(['1']);
  expect(h.previous('b')?.lines).toEqual(['p']);
});

test('previous is undefined after a commit that exceeded the diff budget', () => {
  const h = new EditHistory();
  const lines = Array.from({ length: 3000 }, (_, i) => `x${i} = ${i}`);
  h.open('f', lines.join('\n') + '\n');
  h.commit('f', lines.join('\n') + '\nextra\n');
  expect(h.previous('f')).toBeDefined();
  h.commit('f', lines.map((l) => `    ${l}`).join('\n') + '\n');
  expect(h.previous('f')).toBeUndefined();
  // A later recorded edit makes the newest entry describe the text again.
  h.commit('f', lines.map((l) => `    ${l}`).join('\n').replace('x0 = 0', 'x0 = 1') + '\n');
  expect(h.previous('f')?.hunks).toHaveLength(1);
});

test('previous is undefined after a commit that undoes the last edit', () => {
  const h = new EditHistory();
  h.open('f', 'x = 1\ny = 2\n');
  h.commit('f', 'x = 12\ny = 2\n');
  expect(h.previous('f')).toBeDefined();
  h.commit('f', 'x = 1\ny = 2\n');
  expect(h.entries()).toEqual([]);
  expect(h.previous('f')).toBeUndefined();
});

test('previous is undefined once the entry is evicted, and after forget and clear', () => {
  const h = new EditHistory({ maxEntries: 1 });
  h.open('a', '1\n');
  h.open('b', 'p\n');
  h.commit('a', '2\n');
  h.commit('b', 'q\n');
  expect(h.previous('a')).toBeUndefined();
  expect(h.previous('b')).toBeDefined();
  h.forget('b');
  expect(h.previous('b')).toBeUndefined();
  h.open('c', 'x\n');
  h.commit('c', 'y\n');
  h.clear();
  expect(h.previous('c')).toBeUndefined();
});

test('previous drops a final newline and CRLF', () => {
  const h = new EditHistory();
  h.open('f', 'a\r\nb');
  h.commit('f', 'a\r\nB');
  expect(h.previous('f')?.lines).toEqual(['a', 'b']);
  h.open('g', '');
  h.commit('g', 'x');
  expect(h.previous('g')?.lines).toEqual([]);
});

test('spanBefore maps across an insertion', () => {
  const hunks = [{ oldStart: 1, newStart: 1, oldLines: ['b'], newLines: ['B', 'B2'] }];
  expect(spanBefore(hunks, { start: 3, end: 4 })).toEqual({ start: 2, end: 3 });
  expect(spanBefore(hunks, { start: 2, end: 3 })).toEqual({ start: 1, end: 2 });
  expect(spanBefore(hunks, { start: 0, end: 0 })).toEqual({ start: 0, end: 0 });
  expect(spanBefore(hunks, { start: 0, end: 1 })).toEqual({ start: 0, end: 1 });
});

test('spanBefore maps across a deletion and several hunks', () => {
  const del = [{ oldStart: 1, newStart: 1, oldLines: ['b', 'c'], newLines: [] }];
  expect(spanBefore(del, { start: 1, end: 2 })).toEqual({ start: 3, end: 4 });
  expect(spanBefore(del, { start: 0, end: 2 })).toEqual({ start: 0, end: 4 });
  const two = [
    { oldStart: 0, newStart: 0, oldLines: [], newLines: ['n'] },
    { oldStart: 4, newStart: 5, oldLines: ['o'], newLines: [] },
  ];
  expect(spanBefore(two, { start: 6, end: 8 })).toEqual({ start: 6, end: 8 });
  expect(spanBefore(two, { start: 2, end: 5 })).toEqual({ start: 1, end: 5 });
});

test('maxEntries can be lowered', () => {
  const h = new EditHistory();
  const lines = Array.from({ length: 8 }, (_, i) => `l${i}`);
  h.open('f', lines.join('\n') + '\n');
  for (let i = 0; i < 5; i++) {
    lines[i] = `L${i}`;
    h.commit('f', lines.join('\n') + '\n');
  }
  expect(h.entries()).toHaveLength(5);
  h.maxEntries = 2;
  lines[5] = 'L5';
  h.commit('f', lines.join('\n') + '\n');
  expect(h.entries().map((e) => e.text.split('\n')[3])).toEqual(['-l4', '-l5']);
});

test('recentEditsFile: the last 3 hunks across files, newest last, as one unified diff', () => {
  const h = new EditHistory({ maxEntries: 10 });
  h.open('a.ts', 'a1\na2\na3\na4\na5\n');
  h.commit('a.ts', 'A1\na2\na3\na4\nA5\n'); // two hunks
  h.open('b.ts', 'b1\nb2\n');
  h.commit('b.ts', 'b1\nB2\n');
  h.commit('a.ts', 'A1\na2\nnew\na3\na4\nA5\n'); // insertion
  const f = recentEditsFile(h.entries(), 3, 1e6);
  expect(f?.path).toBe('recent-edits.diff');
  expect(f?.text).toBe(
    ['--- a.ts', '+++ a.ts', '@@ -5,1 +5,1 @@', '-a5', '+A5', '--- b.ts', '+++ b.ts', '@@ -2,1 +2,1 @@', '-b2', '+B2', '--- a.ts', '+++ a.ts', '@@ -2,0 +3,1 @@', '+new'].join('\n'),
  );
});

test('recentEditsFile drops the oldest hunks to fit, and is undefined when nothing fits or there are no edits', () => {
  const h = new EditHistory();
  h.open('a', 'x\ny\n');
  h.commit('a', 'X\ny\n');
  h.open('b', 'p\n');
  h.commit('b', 'P\n');
  const full = recentEditsFile(h.entries(), 3, 1e6)!.text;
  const last = recentEditsFile(h.entries(), 3, full.length - 1)!.text;
  expect(last).toBe('--- b\n+++ b\n@@ -1,1 +1,1 @@\n-p\n+P');
  expect(recentEditsFile(h.entries(), 3, 5)).toBeUndefined();
  expect(recentEditsFile([], 3, 1e6)).toBeUndefined();
});

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`);

test('contextText has 3 context lines around a change', () => {
  const h = new EditHistory();
  const lines = numbered(20);
  h.open('f', lines.join('\n') + '\n');
  lines[9] = 'X10';
  h.commit('f', lines.join('\n') + '\n');
  const [e] = h.entries();
  expect(e.contextText).toBe('@@ -7,7 +7,7 @@\n l7\n l8\n l9\n-l10\n+X10\n l11\n l12\n l13');
  expect(e.text).toBe('--- f\n+++ f\n@@ -10,1 +10,1 @@\n-l10\n+X10');
});

test('contextText of a change at line 1 has no lines before', () => {
  const h = new EditHistory();
  const lines = numbered(20);
  h.open('f', lines.join('\n') + '\n');
  lines[0] = 'X1';
  h.commit('f', lines.join('\n') + '\n');
  expect(h.entries()[0].contextText).toBe('@@ -1,4 +1,4 @@\n-l1\n+X1\n l2\n l3\n l4');
});

test('a merged entry contextText covers the base-to-newest change', () => {
  const h = new EditHistory();
  const lines = numbered(20);
  h.open('f', lines.join('\n') + '\n');
  lines[9] = 'X10';
  h.commit('f', lines.join('\n') + '\n');
  lines[9] = 'XY10';
  h.commit('f', lines.join('\n') + '\n');
  expect(h.entries()).toHaveLength(1);
  expect(h.entries()[0].contextText).toBe('@@ -7,7 +7,7 @@\n l7\n l8\n l9\n-l10\n+XY10\n l11\n l12\n l13');
});
