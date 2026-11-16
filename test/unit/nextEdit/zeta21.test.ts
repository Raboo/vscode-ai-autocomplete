import { describe, expect, it } from 'vitest';
import { pickFormat } from '../../../src/nextEdit/formats';
import type { NextEditInput } from '../../../src/nextEdit/formats/format';
import { markerBlocks, zeta21Format } from '../../../src/nextEdit/formats/zeta21';
import { nextEditBudgets } from '../../../src/nextEdit/region';

// Our own fixture (from a live probe): circle.py with `area(r)` renamed to `area(radius)`, the cursor at the end of `def circumference(r):`.
const FILE = [
  'def area(radius):',
  '    return 3.14159 * radius * radius',
  '',
  '',
  'def circumference(r):',
  '    return 2 * 3.14159 * r',
  '',
  '',
  'def diameter(r):',
  '    return 2 * r',
];

const DIFF = [
  '--- circle.py',
  '+++ circle.py',
  '@@ -1,2 +1,2 @@',
  '-def area(r):',
  '-    return 3.14159 * r * r',
  '+def area(radius):',
  '+    return 3.14159 * radius * radius',
].join('\n');

const EOS = '<[end▁of▁sentence]>';

const input = (over: Partial<NextEditInput> = {}): NextEditInput => ({
  path: 'circle.py',
  lines: FILE,
  cursor: { line: 4, character: 'def circumference(r):'.length },
  region: { start: 4, end: 9 },
  history: [{ path: 'circle.py', text: DIFF, hunks: [] }],
  snippets: [],
  budgets: nextEditBudgets(3500),
  ...over,
});

const promptOf = (i: NextEditInput) => zeta21Format.prompt(i);

describe('markerBlocks', () => {
  it('a short region is one block', () => {
    expect(markerBlocks(['a', 'b', 'c', 'd', 'e'])).toEqual([0]);
    expect(markerBlocks([])).toEqual([0]);
  });

  it('a block ends after 16 lines', () => {
    expect(markerBlocks(Array.from({ length: 20 }, (_, n) => `l${n}`))).toEqual([0, 16]);
    expect(markerBlocks(Array.from({ length: 16 }, (_, n) => `l${n}`))).toEqual([0]);
    expect(markerBlocks(Array.from({ length: 33 }, (_, n) => `l${n}`))).toEqual([0, 16, 32]);
  });

  it('a block ends at a non-blank line after a blank one once it has 6 lines', () => {
    expect(markerBlocks(['a', 'b', 'c', 'd', 'e', 'f', '', 'g'])).toEqual([0, 7]);
  });

  it('a blank line before line 3 does not split', () => {
    expect(markerBlocks(['a', '', 'b', 'c'])).toEqual([0]);
    expect(markerBlocks(['a', 'b', '', 'c', 'd', 'e', 'f'])).toEqual([0]);
  });
});

describe('zeta21 prompt', () => {
  it('prompt layout: edit history, file above, markers and the cursor in the region', () => {
    const p = promptOf(input());
    const expected =
      '<[fim-suffix]>\n' +
      '<[fim-prefix]>' +
      '<filename>edit_history\n' +
      '--- a/circle.py\n+++ b/circle.py\n@@ -1,2 +1,2 @@\n' +
      '-def area(r):\n-    return 3.14159 * r * r\n+def area(radius):\n+    return 3.14159 * radius * radius\n' +
      '\n' +
      '<filename>circle.py\n' +
      'def area(radius):\n    return 3.14159 * radius * radius\n\n\n' +
      '<|marker_1|>def circumference(r):<|user_cursor|>\n    return 2 * 3.14159 * r\n\n\ndef diameter(r):\n    return 2 * r<|marker_2|>\n' +
      '<[fim-middle]>';
    expect(p.prompt).toBe(expected);
    expect(p.prefill).toBe('');
    expect(p.stop).toEqual([EOS]);
  });

  it('the suffix holds the clipped lines after the region', () => {
    const lines = Array.from({ length: 30 }, (_, n) => `line${n}`);
    const p = promptOf(input({ lines, region: { start: 12, end: 14 }, cursor: { line: 13, character: 2 }, history: [] })).prompt;
    // The clip is page-aligned and the budget is large, so the whole file is in.
    expect(p).toBe(
      '<[fim-suffix]>\n' +
        lines.slice(15).join('\n') +
        '\n<[fim-prefix]><filename>circle.py\n' +
        lines.slice(0, 12).join('\n') +
        '\n<|marker_1|>line12\nli<|user_cursor|>ne13\nline14<|marker_2|>\n<[fim-middle]>',
    );
  });

  it('markers sit at the starts of blocks, the last one at the end', () => {
    const lines = Array.from({ length: 20 }, (_, n) => `l${n}`);
    const p = promptOf(input({ lines, region: { start: 0, end: 19 }, cursor: { line: 0, character: 0 }, history: [] })).prompt;
    expect(p).toBe(
      '<[fim-suffix]>\n' +
        '<[fim-prefix]><filename>circle.py\n' +
        '<|marker_1|><|user_cursor|>l0\n' +
        lines.slice(1, 16).join('\n') +
        '\n<|marker_2|>' +
        lines.slice(16).join('\n') +
        '<|marker_3|>\n<[fim-middle]>',
    );
  });

  it('the cursor at the end of the last line goes before the closing marker', () => {
    const p = promptOf(input({ cursor: { line: 9, character: '    return 2 * r'.length }, history: [] })).prompt;
    expect(p.endsWith('    return 2 * r<|user_cursor|><|marker_2|>\n<[fim-middle]>')).toBe(true);
  });

  it('snippets come first as related files, in order and within the budget', () => {
    const snippets = [
      { path: 'a.py', text: 'AAA' },
      { path: 'big.py', text: 'x'.repeat(100) },
      { path: 'b.py', text: 'BBB' },
    ];
    const budgets = { ...nextEditBudgets(3500), snippetsChars: 50 };
    const p = promptOf(input({ snippets, history: [], budgets })).prompt;
    expect(p).toContain('<[fim-prefix]><filename>a.py\nAAA\n<filename>b.py\nBBB\n\n<filename>circle.py\n');
    expect(p).not.toContain('big.py');
  });

  it('related files come before the history', () => {
    const p = promptOf(input({ snippets: [{ path: 'a.py', text: 'AAA' }] })).prompt;
    expect(p).toContain('<[fim-prefix]><filename>a.py\nAAA\n\n<filename>edit_history\n--- a/circle.py\n');
  });

  it('history keeps the newest entries that fit, oldest first, at most 6', () => {
    const entry = (n: number) => ({ path: 'f.py', text: `--- f.py\n+++ f.py\n@@ -${n},1 +${n},1 @@\n-a${n}\n+b${n}`, hunks: [] });
    const history = Array.from({ length: 8 }, (_, n) => entry(n + 1));
    const p = promptOf(input({ history })).prompt;
    expect(p).not.toContain('@@ -2,1');
    expect(p).toContain('@@ -3,1 +3,1 @@\n-a3\n+b3\n--- a/f.py\n+++ b/f.py\n@@ -4,1');
    expect(p.indexOf('@@ -3,1')).toBeLessThan(p.indexOf('@@ -8,1'));
    const one = entry(1).text.length + 4 + 1; // the a/ and b/ prefixes add 4 chars, the newline 1
    const tight = promptOf(input({ history, budgets: { ...nextEditBudgets(3500), historyChars: 2 * one + 1 } })).prompt;
    expect(tight).toContain('@@ -8,1');
    expect(tight).toContain('@@ -7,1');
    expect(tight).not.toContain('@@ -6,1');
  });

  it('no history leaves out the edit_history section', () => {
    const p = promptOf(input({ history: [] })).prompt;
    expect(p).not.toContain('edit_history');
    expect(p).toContain('<[fim-prefix]><filename>circle.py\n');
  });

  it('maxTokens follows the region size, from 256 to 1024', () => {
    expect(promptOf(input()).maxTokens).toBe(256);
    const mid = input({ lines: ['x'.repeat(1200)], region: { start: 0, end: 0 }, cursor: { line: 0, character: 0 }, history: [] });
    expect(promptOf(mid).maxTokens).toBe(Math.ceil((1200 / 3) * 1.5) + 64);
    const big = input({ lines: ['x'.repeat(2000)], region: { start: 0, end: 0 }, cursor: { line: 0, character: 0 }, history: [] });
    expect(promptOf(big).maxTokens).toBe(1024);
  });

  it('region uses the settings sizes', () => {
    expect(zeta21Format.region(10, 100, { above: 3, below: 7 })).toEqual({ start: 7, end: 17 });
    expect(zeta21Format.region(0, 3, { above: 5, below: 10 })).toEqual({ start: 0, end: 2 });
  });

  it('is registered', () => {
    expect(pickFormat('zeta21', 'x')).toBe(zeta21Format);
    expect(zeta21Format.transport).toBe('completion');
  });
});

describe('zeta21 parse', () => {
  const parse = (answer: string, i: NextEditInput = input()) => zeta21Format.parse(answer, i);

  it('the answer from the probe rewrites both functions', () => {
    const a = parse('<|marker_1|>def circumference(radius):\n    return 2 * 3.14159 * radius\n\n\ndef diameter(radius):\n    return 2 * radius\n<|marker_2|>');
    expect(a).toEqual({
      kind: 'rewrite',
      lines: ['def circumference(radius):', '    return 2 * 3.14159 * radius', '', '', 'def diameter(radius):', '    return 2 * radius'],
    });
  });

  it('the same answer without a newline before the closing marker is the same edit', () => {
    const a = parse('<|marker_1|>def circumference(radius):\n    return 2 * 3.14159 * radius\n\n\ndef diameter(radius):\n    return 2 * radius<|marker_2|>');
    expect(a.kind === 'rewrite' && a.lines.length).toBe(6);
  });

  it('a trailing end-of-sentence token is dropped', () => {
    const a = parse(`<|marker_1|>def circumference(radius):\n    return 2 * 3.14159 * radius\n\n\ndef diameter(radius):\n    return 2 * radius\n<|marker_2|>${EOS}`);
    expect(a.kind).toBe('rewrite');
    expect(a.kind === 'rewrite' && a.lines[5]).toBe('    return 2 * radius');
  });

  it('same marker twice is no change', () => {
    expect(parse('<|marker_1|><|marker_1|>')).toEqual({ kind: 'noChange' });
    expect(parse(`<|marker_1|><|marker_1|>${EOS}`)).toEqual({ kind: 'noChange' });
  });

  it('an answer that restates the old text is no change', () => {
    const old = FILE.slice(4).join('\n');
    expect(parse(`<|marker_1|>${old}<|marker_2|>`)).toEqual({ kind: 'noChange' });
    expect(parse(`<|marker_1|>${old}\n<|marker_2|>`)).toEqual({ kind: 'noChange' });
  });

  it('a span over the second block keeps the first', () => {
    const lines = Array.from({ length: 20 }, (_, n) => `l${n}`);
    const i = input({ lines, region: { start: 0, end: 19 }, cursor: { line: 0, character: 0 } });
    expect(parse('<|marker_2|>X<|marker_3|>', i)).toEqual({ kind: 'rewrite', lines: [...lines.slice(0, 16), 'X'] });
  });

  it('a span over the first block keeps the second', () => {
    const lines = Array.from({ length: 20 }, (_, n) => `l${n}`);
    const i = input({ lines, region: { start: 0, end: 19 }, cursor: { line: 0, character: 0 } });
    expect(parse('<|marker_1|>X\n<|marker_2|>', i)).toEqual({ kind: 'rewrite', lines: ['X', ...lines.slice(16)] });
  });

  it('an empty answer between two markers deletes the lines, also at the end of the region', () => {
    const lines = Array.from({ length: 20 }, (_, n) => `l${n}`);
    const i = input({ lines, region: { start: 0, end: 19 }, cursor: { line: 0, character: 0 } });
    expect(parse('<|marker_2|><|marker_3|>', i)).toEqual({ kind: 'rewrite', lines: lines.slice(0, 16) });
    expect(parse('<|marker_1|><|marker_2|>', i)).toEqual({ kind: 'rewrite', lines: lines.slice(16) });
  });

  it('the same marker twice is no change even with text between', () => {
    const lines = Array.from({ length: 20 }, (_, n) => `l${n}`);
    expect(parse('<|marker_2|>new\n<|marker_2|>', input({ lines, region: { start: 0, end: 19 } }))).toEqual({ kind: 'noChange' });
  });

  it('invalid answers: one marker, out of range, decreasing, no marker', () => {
    expect(parse('<|marker_1|>text').kind).toBe('invalid');
    expect(parse('plain text').kind).toBe('invalid');
    expect(parse('').kind).toBe('invalid');
    expect(parse('<|marker_1|>x<|marker_9|>').kind).toBe('invalid');
    expect(parse('<|marker_0|>x<|marker_1|>').kind).toBe('invalid');
    const lines = Array.from({ length: 20 }, (_, n) => `l${n}`);
    const i = input({ lines, region: { start: 0, end: 19 }, cursor: { line: 0, character: 0 } });
    expect(parse('<|marker_3|>x<|marker_1|>', i).kind).toBe('invalid');
  });

  it('the cursor marker is stripped from the answer', () => {
    const a = parse('<|marker_1|>def circumference(radius):<|user_cursor|>\n    return 2 * 3.14159 * radius\n\n\ndef diameter(r):\n    return 2 * r\n<|marker_2|>');
    expect(a).toEqual({
      kind: 'rewrite',
      lines: ['def circumference(radius):', '    return 2 * 3.14159 * radius', '', '', 'def diameter(r):', '    return 2 * r'],
    });
    expect(parse('<|marker_1|><|user_cursor|><|marker_1|>')).toEqual({ kind: 'noChange' });
  });

  it('a block before a marker other than the closing one must end in a newline', () => {
    const lines = Array.from({ length: 20 }, (_, n) => `l${n}`);
    const i = input({ lines, region: { start: 0, end: 19 }, cursor: { line: 0, character: 0 } });
    expect(parse('<|marker_1|>X<|marker_2|>', i)).toEqual({ kind: 'invalid', why: 'glued' });
    expect(parse('<|marker_1|>X\n<|marker_2|>', i).kind).toBe('rewrite');
    expect(parse('<|marker_1|>X<|user_cursor|><|marker_2|>', i)).toEqual({ kind: 'invalid', why: 'glued' });
  });

  it('markers between the first and the last are dropped from the text', () => {
    const lines = Array.from({ length: 20 }, (_, n) => `l${n}`);
    const i = input({ lines, region: { start: 0, end: 19 }, cursor: { line: 0, character: 0 } });
    const a = parse(`<|marker_1|>${lines.slice(0, 16).join('\n')}\n<|marker_2|>${lines.slice(16).join('\n')}X<|marker_3|>`, i);
    expect(a).toEqual({ kind: 'rewrite', lines: [...lines.slice(0, 19), 'l19X'] });
  });
});

describe('zeta21 parse, region at the end of a file that ends with a newline', () => {
  // The same file with its final newline: the last line is ''.
  const lines = [...FILE, ''];
  const i = input({ lines, region: { start: 4, end: 10 } });
  const parse = (answer: string, at: NextEditInput = i) => zeta21Format.parse(answer, at);
  const renamed = ['def circumference(radius):', '    return 2 * 3.14159 * radius', '', '', 'def diameter(radius):', '    return 2 * radius'];

  it('the prompt shows the region text ending in a newline before the closing marker', () => {
    expect(promptOf(i).prompt).toContain('    return 2 * r\n<|marker_2|>');
  });

  it('a faithful echo is no change, with or without the newline before the closing marker', () => {
    expect(parse(`<|marker_1|>${lines.slice(4).join('\n')}<|marker_2|>`)).toEqual({ kind: 'noChange' });
    expect(parse(`<|marker_1|>${lines.slice(4, 10).join('\n')}<|marker_2|>`)).toEqual({ kind: 'noChange' });
  });

  it('a rewrite keeps the final newline', () => {
    expect(parse(`<|marker_1|>${renamed.join('\n')}\n<|marker_2|>`)).toEqual({ kind: 'rewrite', lines: [...renamed, ''] });
    expect(parse(`<|marker_1|>${renamed.join('\n')}<|marker_2|>`)).toEqual({ kind: 'rewrite', lines: [...renamed, ''] });
  });

  it('deleting the last block keeps the final newline', () => {
    const long = [...Array.from({ length: 19 }, (_, n) => `l${n}`), ''];
    const at = input({ lines: long, region: { start: 0, end: 19 }, cursor: { line: 0, character: 0 } });
    expect(parse('<|marker_2|><|marker_3|>', at)).toEqual({ kind: 'rewrite', lines: [...long.slice(0, 16), ''] });
  });
});

describe('zeta21 reserved strings', () => {
  const lines = (at: number, text: string): string[] => FILE.map((l, n) => (n === at ? text : l));

  it('each reserved string in the region is a problem', () => {
    expect(zeta21Format.problem(input())).toBeUndefined();
    for (const r of ['<[fim-suffix]>', '<filename>', '<|marker_1|>', '<|user_cursor|>', EOS]) {
      expect(zeta21Format.problem(input({ lines: lines(5, `x = "${r}"`) }))).toBe('reserved');
    }
  });

  it('the file section outside the region is checked too', () => {
    expect(zeta21Format.problem(input({ lines: lines(0, '# <|marker_3|>') }))).toBe('reserved');
  });

  it('a too long region is tooLong', () => {
    expect(zeta21Format.problem(input({ lines: lines(5, 'x'.repeat(2 * nextEditBudgets(3500).fileChars + 1)) }))).toBe('tooLong');
  });

  it('a snippet or history entry with a reserved string is left out, the others stay', () => {
    const snippets = [
      { path: 'bad.py', text: 'a <|marker_2|> b' },
      { path: 'bad2.py', text: 'a <[fim-middle]> b' },
      { path: 'good.py', text: 'fine' },
    ];
    const bad = DIFF.replace('+def area(radius):', '+<filename>');
    const history = [
      { path: 'circle.py', text: bad, hunks: [] },
      { path: 'other.py', text: '--- other.py\n+++ other.py\n@@ -1,1 +1,1 @@\n-one\n+two', hunks: [] },
    ];
    const p = promptOf(input({ snippets, history })).prompt;
    expect(p).not.toContain('bad.py');
    expect(p).not.toContain('bad2.py');
    expect(p).not.toContain('<|marker_2|> b');
    expect(p).not.toContain('+<filename>');
    expect(p).toContain('<filename>good.py\nfine\n');
    expect(p).toContain('--- a/other.py\n+++ b/other.py\n@@ -1,1 +1,1 @@\n-one\n+two\n');
    // Only our own headers carry the string: good.py, edit_history and circle.py.
    expect(p.split('<filename>').length - 1).toBe(3);
  });
});
