import { describe, expect, it } from 'vitest';
import type { NextEditInput } from '../../../src/nextEdit/formats/format';
import { INSTINCT_SYSTEM, instinctFormat, instinctMessages, instinctRegion, parseInstinct } from '../../../src/nextEdit/formats/instinct';
import { nextEditBudgets } from '../../../src/nextEdit/region';

const fileLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);

function input(over: Partial<NextEditInput> = {}): NextEditInput {
  return {
    path: 'src/a.ts',
    lines: fileLines,
    cursor: { line: 20, character: 4 },
    region: instinctRegion(20, 40),
    history: [
      { path: 'src/a.ts', text: 'old', hunks: [], contextText: '-a\n+b' },
      { path: 'src/c.ts', text: 'new', hunks: [], contextText: '-c\n+d\n' }
    ],
    snippets: [{ path: 'a.ts', text: 'export const a = 1;' }],
    budgets: nextEditBudgets(3500),
    ...over
  };
}

const userOf = (i: NextEditInput): string => instinctMessages(i).messages[1].content;

describe('instinct region', () => {
  it('is one line above and five below', () => {
    expect(instinctRegion(10, 100)).toEqual({ start: 9, end: 15 });
    expect(instinctRegion(0, 3)).toEqual({ start: 0, end: 2 });
  });
  it('ignores the settings', () => {
    expect(instinctFormat.region(10, Array(100).fill('x'), { above: 9, below: 9 })).toEqual(instinctRegion(10, 100));
  });
});

describe('instinctMessages', () => {
  it('builds the golden user message', () => {
    const i = input();
    const excerpt = [
      ...fileLines.slice(0, 19),
      '<|editable_region_start|>',
      'line 19',
      'line<|user_cursor_is_here|> 20',
      ...fileLines.slice(21, 26),
      '<|editable_region_end|>',
      ...fileLines.slice(26)
    ];
    const expected =
      'Reference the user excerpt, user edits, and the snippets to understand the developer\'s intent. Update the editable region of the user excerpt by predicting and completing the changes they would have made next. This may be a deletion, addition, or modification of code.' +
      '\n\n### Context:\n\n<|context_file|> `a.ts`\n<|snippet|>\nexport const a = 1;\n' +
      '\n\n### User Edits:\n\n' +
      'User edited file "src/c.ts"\n\n```diff\n-c\n+d\n```\n\nUser edited file "src/a.ts"\n\n```diff\n-a\n+b\n```\n\n' +
      '### User Excerpt:\n"src/a.ts"\n\n' +
      excerpt.join('\n') +
      '\n\n';
    expect(userOf(i)).toBe(expected);
  });

  it('system message', () => {
    const m = instinctMessages(input()).messages[0];
    expect(m.content).toBe(INSTINCT_SYSTEM);
    expect(INSTINCT_SYSTEM).toContain('Your role as an AI assistant is');
    expect(INSTINCT_SYSTEM.endsWith('errors.\n\n')).toBe(true);
    expect(instinctMessages(input(), 'extra').messages[0].content).toBe(`${INSTINCT_SYSTEM}\nextra`);
  });

  it('keeps headings with empty history and snippets', () => {
    expect(userOf(input({ history: [], snippets: [] }))).toContain('### Context:\n\n\n### User Edits:\n\n\n### User Excerpt:');
  });

  it('windows at most 25 lines either side', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `l${i}`);
    const user = userOf(input({ lines, cursor: { line: 100, character: 0 }, region: instinctRegion(100, 200), budgets: { fileChars: 100000, historyChars: 1000, snippetsChars: 1000 } }));
    expect(user).toContain('\nl75\n');
    expect(user).not.toContain('\nl74\n');
    expect(user).toContain('\nl125\n');
    expect(user).not.toContain('\nl126\n');
  });

  it('a tiny budget shrinks the window but keeps the region', () => {
    const user = userOf(input({ budgets: { fileChars: 1, historyChars: 1000, snippetsChars: 1000 } }));
    expect(user).toContain('<|editable_region_start|>\nline 19\nline<|user_cursor_is_here|> 20\nline 21\nline 22\nline 23\nline 24\nline 25\n<|editable_region_end|>\n\n');
    expect(user).not.toContain('line 18');
  });

  it('stableChars is the index of the edits heading', () => {
    const r = instinctMessages(input());
    expect(r.stableChars).toBe(r.messages[1].content.indexOf('### User Edits:'));
  });
});

describe('instinct problem', () => {
  it('refuses reserved tags in file and history', () => {
    expect(instinctFormat.problem(input())).toBeUndefined();
    expect(instinctFormat.problem(input({ lines: fileLines.map((l, n) => (n === 18 ? 'x <|snippet|>' : l)) }))).toBeTruthy();
    expect(instinctFormat.problem(input({ history: [{ path: 'a', text: '', hunks: [], contextText: '<|snippet|>' }] }))).toBeTruthy();
  });
  it('leaves out a snippet with a reserved tag', () => {
    const user = userOf(input({ snippets: [{ path: 'b.ts', text: 'x <|editable_region_end|>' }] }));
    expect(user).not.toContain('b.ts');
  });
});

describe('parseInstinct', () => {
  it('rewrites', () => {
    expect(parseInstinct('  a\n  b')).toEqual({ kind: 'rewrite', lines: ['  a', '  b'] });
  });
  it('strips cursor, region tags and fences', () => {
    expect(parseInstinct('a<|user_cursor_is_here|>b\n<|editable_region_start|>\n<|editable_region_end|>')).toEqual({ kind: 'rewrite', lines: ['ab'] });
    expect(parseInstinct('```ts\n  a\n```')).toEqual({ kind: 'rewrite', lines: ['  a'] });
  });
  it('keeps plain code that contains a fence line', () => {
    expect(parseInstinct('a\n```\nb')).toEqual({ kind: 'rewrite', lines: ['a', '```', 'b'] });
  });
  it('keeps an unclosed opening fence as it is', () => {
    expect(parseInstinct('```ts\n  a')).toEqual({ kind: 'rewrite', lines: ['```ts', '  a'] });
  });
  it('empty is invalid', () => {
    expect(parseInstinct('')).toEqual({ kind: 'invalid', why: 'empty' });
    expect(parseInstinct('\n  \n')).toEqual({ kind: 'invalid', why: 'empty' });
  });
  it('done is false', () => {
    expect(instinctFormat.done('anything')).toBe(false);
  });
});
