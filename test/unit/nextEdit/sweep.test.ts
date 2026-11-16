import { describe, expect, it } from 'vitest';
import { pickFormat } from '../../../src/nextEdit/formats';
import type { CompletionFormat, NextEditInput } from '../../../src/nextEdit/formats/format';
import { sweepFormat } from '../../../src/nextEdit/formats/sweep';
import { nextEditBudgets } from '../../../src/nextEdit/region';

// Our own fixture: a 30-line circle.py where `area(r)` became `area(radius)`, the cursor on line 12 (0-based).
const FILE = [
  '# circle.py',
  'import math',
  '',
  'def perimeter(radius):',
  '    return 2 * math.pi * radius',
  '',
  'def diameter(radius):',
  '    return 2 * radius',
  '',
  'def area(radius):',
  '    return math.pi * radius ** 2',
  '',
  'def volume(radius):',
  '    return 4 / 3 * math.pi * radius ** 3',
  '',
  'def scale(radius, k):',
  '    return radius * k',
  '',
  'def describe(radius):',
  '    return f"circle r={radius}"',
  '',
  'def unit():',
  '    return 1',
  '',
  'def main():',
  '    print(area(1))',
  '    print(perimeter(1))',
  '',
  'if __name__ == "__main__":',
  '    main()',
];

const OLD_AREA = ['def area(r):', '    return math.pi * r ** 2'];
const NEW_AREA = ['def area(radius):', '    return math.pi * radius ** 2'];

const previousLines = (): string[] => [...FILE.slice(0, 9), ...OLD_AREA, ...FILE.slice(11)];

const hunk = { oldStart: 9, newStart: 9, oldLines: OLD_AREA, newLines: NEW_AREA };

const input = (over: Partial<NextEditInput> = {}): NextEditInput => ({
  path: 'circle.py',
  lines: FILE,
  cursor: { line: 12, character: 19 },
  region: { start: 2, end: 22 },
  history: [{ path: 'circle.py', text: '(ignored by sweep)', hunks: [hunk] }],
  snippets: [{ path: 'util/clamp.py', text: 'def clamp(x):\n    return x' }],
  budgets: nextEditBudgets(3500),
  previous: { lines: previousLines(), hunks: [hunk] },
  ...over,
});

const v1 = sweepFormat('v1');
const v2 = sweepFormat('v2');
const completion = (f: CompletionFormat, i: NextEditInput) => f.prompt(i);

// The window (lines 2..22) as the current text, written out by hand.
const WINDOW = [
  '',
  'def perimeter(radius):',
  '    return 2 * math.pi * radius',
  '',
  'def diameter(radius):',
  '    return 2 * radius',
  '',
  'def area(radius):',
  '    return math.pi * radius ** 2',
  '',
  'def volume(radius):',
  '    return 4 / 3 * math.pi * radius ** 3',
  '',
  'def scale(radius, k):',
  '    return radius * k',
  '',
  'def describe(radius):',
  '    return f"circle r={radius}"',
  '',
  'def unit():',
  '    return 1',
];

// The same lines before the latest change.
const ORIGINAL_WINDOW = [
  '',
  'def perimeter(radius):',
  '    return 2 * math.pi * radius',
  '',
  'def diameter(radius):',
  '    return 2 * radius',
  '',
  'def area(r):',
  '    return math.pi * r ** 2',
  '',
  'def volume(radius):',
  '    return 4 / 3 * math.pi * radius ** 3',
  '',
  'def scale(radius, k):',
  '    return radius * k',
  '',
  'def describe(radius):',
  '    return f"circle r={radius}"',
  '',
  'def unit():',
  '    return 1',
];

describe('sweep format basics', () => {
  it('runs on the completion route and is picked for Sweep models', () => {
    expect(v1.transport).toBe('completion');
    expect(v1.id).toBe('sweep');
    expect(pickFormat('auto', 'sweep-next-edit-v2-7b')).toMatchObject({ id: 'sweep', transport: 'completion' });
  });

  it('v1 window is 10 above and 10 below, clipped', () => {
    expect(v1.region(12, 30, { above: 5, below: 10 })).toEqual({ start: 2, end: 22 });
    expect(v1.region(1, 5, { above: 5, below: 10 })).toEqual({ start: 0, end: 4 });
    expect(v2.region(29, 30, { above: 1, below: 1 })).toEqual({ start: 19, end: 29 });
  });
});

describe('sweep v1 prompt', () => {
  it('layout', () => {
    const expected = [
      '<|file_sep|>util/clamp.py',
      'def clamp(x):',
      '    return x',
      '<|file_sep|>circle.py.diff',
      'original:',
      'def area(r):',
      '    return math.pi * r ** 2',
      'updated:',
      'def area(radius):',
      '    return math.pi * radius ** 2',
      '<|file_sep|>original/circle.py',
      ...ORIGINAL_WINDOW,
      '<|file_sep|>current/circle.py',
      ...WINDOW,
      '<|file_sep|>updated/circle.py',
      '',
    ].join('\n');
    expect(completion(v1, input())).toEqual({
      prompt: expected,
      prefill: '',
      stop: ['<|file_sep|>', '<|endoftext|>', '</s>'],
      maxTokens: 512,
    });
  });

  it('original window comes from the text before the latest change', () => {
    // The latest change inserted two lines at line 1, so the new text's lines 4..6 are the old text's lines 2..4.
    const insertion = { oldStart: 1, newStart: 1, oldLines: [], newLines: ['import math', 'import sys'] };
    const prevLines = ['# circle.py', ...FILE.slice(3)];
    const text = completion(
      v1,
      input({
        lines: ['# circle.py', ...insertion.newLines, ...FILE.slice(3)],
        region: { start: 4, end: 6 },
        cursor: { line: 5, character: 0 },
        previous: { lines: prevLines, hunks: [insertion] },
        history: [],
        snippets: [],
      })
    ).prompt;
    const originalPart = text.split('<|file_sep|>original/circle.py\n')[1].split('\n<|file_sep|>current/')[0];
    expect(originalPart).toBe([prevLines[2], prevLines[3], prevLines[4]].join('\n'));
  });

  it('without previous the original window is the current window', () => {
    const p = completion(v1, input({ previous: undefined })).prompt;
    const original = p.split('<|file_sep|>original/circle.py\n')[1].split('\n<|file_sep|>current/')[0];
    expect(original).toBe(WINDOW.join('\n'));
  });

  it('an empty original window (a region wholly inside an insertion) leaves an empty line', () => {
    const insertion = { oldStart: 4, newStart: 4, oldLines: [], newLines: ['a', 'b', 'c', 'd'] };
    const lines = ['x0', 'x1', 'x2', 'x3', 'a', 'b', 'c', 'd', 'x4'];
    const p = completion(
      v1,
      input({
        lines,
        region: { start: 5, end: 6 },
        cursor: { line: 5, character: 0 },
        previous: { lines: ['x0', 'x1', 'x2', 'x3', 'x4'], hunks: [insertion] },
        history: [],
        snippets: [],
      })
    ).prompt;
    expect(p).toBe(['<|file_sep|>original/circle.py', '', '<|file_sep|>current/circle.py', 'b', 'c', '<|file_sep|>updated/circle.py', ''].join('\n'));
  });

  it('a CRLF document read as lines gives a prompt without carriage returns', () => {
    const crlf = 'a = 1\r\nb = 2\r\nc = 3\r\n'.split(/\r?\n/).slice(0, 3);
    const p = completion(v1, input({ lines: crlf, region: { start: 0, end: 2 }, cursor: { line: 1, character: 0 }, previous: undefined, history: [], snippets: [] }));
    expect(p.prompt).not.toContain('\r');
    expect(completion(v2, input({ lines: crlf, region: { start: 0, end: 2 }, cursor: { line: 1, character: 0 }, previous: undefined, history: [], snippets: [] })).prompt).not.toContain('\r');
  });
});

describe('sweep v2 prompt', () => {
  it('layout', () => {
    const expected = [
      '<|file_sep|>util/clamp.py',
      'def clamp(x):',
      '    return x',
      '<|file_sep|>circle.py',
      ...FILE,
      '',
      '<|file_sep|>circle.py:10:11',
      'original:',
      'def area(r):',
      '    return math.pi * r ** 2',
      'updated:',
      'def area(radius):',
      '    return math.pi * radius ** 2',
      '<|file_sep|>original/circle.py:3:23',
      ...ORIGINAL_WINDOW,
      '<|file_sep|>current/circle.py:3:23',
      ...WINDOW.slice(0, 10),
      'def volume(radius):<|cursor|>',
      ...WINDOW.slice(11),
      '<|file_sep|>updated/circle.py:3:23',
      ...WINDOW.slice(0, 10),
      '',
    ].join('\n');
    const r = completion(v2, input());
    expect(r.stop).toEqual(['<|file_sep|>', '<|endoftext|>']);
    expect(r.maxTokens).toBe(1024);
    expect(r.prefill).toBe(WINDOW.slice(0, 10).map((l) => `${l}\n`).join(''));
    expect(r.prompt).toBe(expected);
  });

  it('with no change blocks the blank line after the file section stays', () => {
    const p = completion(v2, input({ history: [], snippets: [], previous: undefined })).prompt;
    expect(p).toContain(`${FILE[29]}\n\n\n<|file_sep|>original/circle.py:3:23\n`);
  });

  it('answer is prefill + output', () => {
    const i = input();
    const prefill = completion(v2, i).prefill;
    const generated = ['def volume(radius):', '    return 4 / 3 * math.pi * radius ** 3', '', 'def scale(radius, k):'].join('\n');
    const answer = prefill + generated;
    const parsed = v2.parse(answer, i);
    expect(parsed.kind).toBe('rewrite');
    if (parsed.kind === 'rewrite') {
      expect(parsed.lines.slice(0, 10)).toEqual(WINDOW.slice(0, 10));
      expect(parsed.lines[10]).toBe('def volume(radius):');
    }
    const whole = v2.parse(prefill + WINDOW.slice(10).join('\n') + '\n', i);
    expect(whole).toEqual({ kind: 'noChange' });
  });

  it('an empty generation is invalid, not a deletion of the window below the cursor', () => {
    const i = input();
    const prefill = completion(v2, i).prefill;
    expect(v2.parse(prefill, i)).toEqual({ kind: 'invalid', why: 'empty' });
    expect(v2.parse(`${prefill}\n`, i)).toEqual({ kind: 'invalid', why: 'empty' });
  });

  it('an echoed cursor marker at column 0 of the cursor line is removed, not read as a special answer', () => {
    const i = input({ cursor: { line: 12, character: 0 } });
    const prefill = completion(v2, i).prefill;
    const tail = ['def volume(radius, h):', ...WINDOW.slice(11)];
    expect(v2.parse(`${prefill}<|cursor|>${tail.join('\n')}\n`, i)).toEqual({ kind: 'rewrite', lines: [...WINDOW.slice(0, 10), ...tail] });
  });

  it('a generation of blank lines only is invalid too', () => {
    const i = input();
    const prefill = completion(v2, i).prefill;
    expect(v2.parse(`${prefill}\n\n\n`, i)).toEqual({ kind: 'invalid', why: 'empty' });
    expect(v1.parse('\n\n\n', i)).toEqual({ kind: 'invalid', why: 'empty' });
  });

  it('an empty generation is fine when the window from the cursor line down is blank', () => {
    const i = input({ lines: ['a', 'b', '', ''], region: { start: 0, end: 3 }, cursor: { line: 2, character: 0 }, previous: undefined, history: [], snippets: [] });
    expect(v2.parse(completion(v2, i).prefill, i)).toEqual({ kind: 'noChange' });
  });

  it('a window whose first line starts with <| is not read as a special answer', () => {
    const lines = ['<| x', 'b', 'c', ''];
    const i = input({ lines, region: { start: 0, end: 3 }, cursor: { line: 1, character: 0 }, previous: undefined, history: [], snippets: [] });
    const prefill = completion(v2, i).prefill;
    expect(prefill.startsWith('<|')).toBe(true);
    expect(v2.parse(`${prefill}b\nc\n`, i)).toEqual({ kind: 'noChange' });
    expect(v2.parse(`${prefill}B\nc\n`, i)).toEqual({ kind: 'rewrite', lines: ['<| x', 'B', 'c', ''] });
    expect(v2.parse(`${prefill}<|endoftext|>`, i).kind).toBe('invalid');
  });
});

describe('sweep budgets', () => {
  const manyHunks = (n: number) =>
    Array.from({ length: n }, (_, k) => ({ oldStart: k, newStart: k, oldLines: [`old${k}`], newLines: [`new${k}`] }));

  it('keeps the newest hunks that fit the history budget, oldest first', () => {
    const budgets = { fileChars: 1500, historyChars: 120, snippetsChars: 1000 };
    const p = completion(v1, input({ history: [{ path: 'circle.py', text: '', hunks: manyHunks(6) }], snippets: [], budgets, previous: undefined })).prompt;
    // One v1 block is "<|file_sep|>circle.py.diff\noriginal:\nold5\nupdated:\nnew5" = 55 chars, plus 1 for its separator: two fit in 120, three do not.
    expect(p).not.toContain('old3');
    expect(p).toContain('old4');
    expect(p).toContain('old5');
    expect(p.indexOf('old4')).toBeLessThan(p.indexOf('old5'));
  });

  it('includes snippets while they fit', () => {
    const budgets = { fileChars: 1500, historyChars: 1000, snippetsChars: 12 };
    const snippets = [
      { path: 'a.py', text: 'x'.repeat(10) },
      { path: 'b.py', text: 'y'.repeat(10) },
    ];
    const p = completion(v1, input({ snippets, budgets, history: [], previous: undefined })).prompt;
    expect(p).toContain('<|file_sep|>a.py\n' + 'x'.repeat(10));
    expect(p).not.toContain('b.py');
  });
});

describe('sweep reserved strings', () => {
  it('a region line with <|file_sep|> is a problem in both variants', () => {
    const lines = [...FILE];
    lines[12] = 'x = "<|file_sep|>"';
    expect(v1.problem(input({ lines }))).toBe('reserved');
    expect(v2.problem(input({ lines }))).toBe('reserved');
    lines[12] = 'x = "<|endoftext|>"';
    expect(v1.problem(input({ lines }))).toBe('reserved');
  });

  it('<|cursor|> is reserved in v2 only', () => {
    const lines = [...FILE];
    lines[12] = 'x = "<|cursor|>"';
    expect(v1.problem(input({ lines }))).toBeUndefined();
    expect(v2.problem(input({ lines }))).toBe('reserved');
  });

  it('v2 also checks the file section outside the region', () => {
    const lines = [...FILE];
    lines[0] = '# <|file_sep|>';
    expect(v1.problem(input({ lines }))).toBeUndefined();
    expect(v2.problem(input({ lines }))).toBe('reserved');
  });

  it('the original window is checked', () => {
    const prev = previousLines();
    prev[12] = '<|endoftext|>';
    expect(v1.problem(input({ previous: { lines: prev, hunks: [hunk] } }))).toBe('reserved');
  });

  it('a too long region is tooLong, a normal one is fine', () => {
    expect(v1.problem(input())).toBeUndefined();
    const lines = [...FILE];
    lines[12] = 'x'.repeat(2 * nextEditBudgets(3500).fileChars + 1);
    expect(v1.problem(input({ lines }))).toBe('tooLong');
  });

  it('a snippet with a reserved string is left out of the prompt', () => {
    const snippets = [
      { path: 'bad.py', text: 'a <|endoftext|> b' },
      { path: 'good.py', text: 'fine' },
    ];
    for (const f of [v1, v2]) {
      const p = completion(f, input({ snippets })).prompt;
      expect(p).not.toContain('bad.py');
      expect(p).not.toContain('<|endoftext|>');
      expect(p).toContain('<|file_sep|>good.py\nfine');
    }
  });

  it('a hunk with a reserved string is left out, the others stay', () => {
    const hunks = [
      { oldStart: 1, newStart: 1, oldLines: ['one'], newLines: ['uno'] },
      { oldStart: 5, newStart: 5, oldLines: ['two'], newLines: ['<|file_sep|>'] },
      { oldStart: 9, newStart: 9, oldLines: ['three'], newLines: ['tres'] },
    ];
    const p = completion(v1, input({ history: [{ path: 'circle.py', text: '', hunks }], snippets: [], previous: undefined })).prompt;
    expect(p).toContain('uno');
    expect(p).toContain('tres');
    expect(p).not.toContain('two');
    // Only the headers of our own prompt contain the string.
    expect(p.split('<|file_sep|>').length - 1).toBe(2 + 3);
  });
});

describe('sweep parse', () => {
  const small = input({
    lines: ['a', 'b', 'c', ''],
    region: { start: 0, end: 3 },
    cursor: { line: 1, character: 0 },
    previous: undefined,
    history: [],
    snippets: [],
  });

  it('an answer equal to the window is noChange', () => {
    expect(v1.parse('a\nb\nc\n', small)).toEqual({ kind: 'noChange' });
  });

  it('a different answer is a rewrite', () => {
    expect(v1.parse('a\nB\nc\n\n', small)).toEqual({ kind: 'rewrite', lines: ['a', 'B', 'c', ''] });
  });

  it('an answer starting with <| is invalid', () => {
    expect(v1.parse('<|file_sep|>x', small).kind).toBe('invalid');
    expect(v2.parse('<|endoftext|>', small).kind).toBe('invalid');
  });

  it('an answer more than 20 lines longer than the window is invalid', () => {
    const long = Array.from({ length: 25 }, (_, k) => `l${k}`).join('\n');
    expect(v1.parse(long, small).kind).toBe('invalid');
    const ok = Array.from({ length: 23 }, (_, k) => `l${k}`).join('\n');
    expect(v1.parse(ok, small).kind).toBe('rewrite');
  });

  it('an empty answer for a non-blank window is invalid', () => {
    expect(v1.parse('', small).kind).toBe('invalid');
    expect(v1.parse('\n', small).kind).toBe('invalid');
  });

  it('missing trailing blank lines are restored', () => {
    const win = input({ lines: ['a', 'b', '', ''], region: { start: 0, end: 3 }, cursor: { line: 0, character: 0 }, previous: undefined, history: [], snippets: [] });
    expect(v1.parse('a\nb', win)).toEqual({ kind: 'noChange' });
    expect(v1.parse('a\nb\n', win)).toEqual({ kind: 'noChange' });
    expect(v1.parse('A\nb\n\n', win)).toEqual({ kind: 'rewrite', lines: ['A', 'b', '', ''] });
  });

  it('a stray <|cursor|> is removed', () => {
    expect(v2.parse('a\nb<|cursor|>\nc\n\n', small)).toEqual({ kind: 'noChange' });
    expect(v2.parse('a\nb<|cursor|>X\nc\n\n', small)).toEqual({ kind: 'rewrite', lines: ['a', 'bX', 'c', ''] });
  });

  it('an empty answer for an all-blank window is not invalid', () => {
    const blank = input({ lines: ['', ''], region: { start: 0, end: 1 }, cursor: { line: 0, character: 0 }, previous: undefined, history: [], snippets: [] });
    expect(v1.parse('', blank)).toEqual({ kind: 'noChange' });
  });
});
