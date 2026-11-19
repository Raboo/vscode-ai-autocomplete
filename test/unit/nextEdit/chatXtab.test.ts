import { describe, expect, it } from 'vitest';
import { CHAT_XTAB_SYSTEM, chatXtabDone, chatXtabFormat, chatXtabMessages, parseChatXtab } from '../../../src/nextEdit/formats/chatXtab';
import type { NextEditInput } from '../../../src/nextEdit/formats/format';
import { nextEditBudgets, type LineSpan } from '../../../src/nextEdit/region';

const fileLines = Array.from({ length: 30 }, (_, i) => `line ${i}`);

function input(over: Partial<NextEditInput> = {}): NextEditInput {
  return {
    path: 'src/a.ts',
    lines: fileLines,
    cursor: { line: 12, character: 4 },
    region: { start: 8, end: 14 },
    history: [{ path: 'src/a.ts', text: '--- src/a.ts\n+++ src/a.ts\n-x\n+y', hunks: [] }],
    snippets: [{ path: 'src/b.ts', text: 'export const b = 1;' }],
    budgets: nextEditBudgets(3500),
    ...over
  };
}

const userOf = (i: NextEditInput): string => chatXtabMessages(i).messages[1].content;

describe('chatXtabMessages', () => {
  it('the user message has the blocks in order', () => {
    const user = userOf(input());
    const a = user.indexOf('<|recently_viewed_code_snippets|>');
    const b = user.indexOf('<|current_file_content|>');
    const c = user.indexOf('<|edit_diff_history|>');
    const d = user.lastIndexOf('<|code_to_edit|>');
    expect(a).toBe(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
    expect(user).toContain('code_snippet_file_path: src/b.ts\nexport const b = 1;');
    expect(user).toContain('current_file_path: src/a.ts\n');
  });

  it('empty history and snippets leave their blocks out', () => {
    const user = userOf(input({ history: [], snippets: [] }));
    expect(user).not.toContain('<|recently_viewed_code_snippets|>');
    expect(user).not.toContain('<|edit_diff_history|>');
    expect(user.startsWith('<|current_file_content|>\n')).toBe(true);
    expect(user).not.toMatch(/\n\n\n/);
  });

  it('the cursor marker appears once, in the last block', () => {
    const user = userOf(input());
    expect(user.split('<|cursor|>')).toHaveLength(2);
    const last = user.slice(user.lastIndexOf('<|code_to_edit|>'));
    expect(last).toContain('line 12'.slice(0, 4) + '<|cursor|>' + 'line 12'.slice(4));
    expect(last.endsWith('<|/code_to_edit|>')).toBe(true);
  });

  it('history keeps the newest entries within budget, oldest first', () => {
    const entry = (n: number, size: number) => ({ path: 'a.ts', text: `E${n}` + 'x'.repeat(size - 2), hunks: [] });
    const big = userOf(input({ history: [entry(1, 2000), entry(2, 2000), entry(3, 2000)] }));
    expect(big).toContain('E3');
    expect(big).not.toContain('E2');
    expect(big).not.toContain('E1');
    const small = userOf(input({ history: [entry(1, 1000), entry(2, 1000), entry(3, 1000)] }));
    const [i1, i2, i3] = ['E1', 'E2', 'E3'].map((s) => small.indexOf(s));
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });

  it('the system prompt is our own wording', () => {
    expect(CHAT_XTAB_SYSTEM).toContain('NO_CHANGE');
    expect(CHAT_XTAB_SYSTEM).toContain('```');
    expect(CHAT_XTAB_SYSTEM).toContain('<|code_to_edit|>');
    expect(CHAT_XTAB_SYSTEM).not.toContain('would have made next');
    expect(CHAT_XTAB_SYSTEM).not.toContain('Your revised code goes here');
    expect(chatXtabMessages(input()).messages[0]).toEqual({ role: 'system', content: CHAT_XTAB_SYSTEM });
  });

  it('a system suffix is appended', () => {
    const sys = chatXtabMessages(input(), '/no_think').messages[0].content;
    expect(sys.endsWith('\n/no_think')).toBe(true);
  });

  it('stableChars stops 4 lines above the region inside the current file', () => {
    const i = input();
    const { messages, stableChars } = chatXtabMessages(i);
    expect(stableChars).toBeGreaterThan(0);
    expect(messages[1].content.slice(stableChars).startsWith('line 4\nline 5\n')).toBe(true);
  });

  it('stableChars is 0 when fewer than 4 file lines precede the region', () => {
    const i = input({ region: { start: 2, end: 6 }, history: [], snippets: [] });
    expect(chatXtabMessages(i).stableChars).toBe(0);
  });

  it('a smaller budget clips more', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const fileSection = (contextTokens: number): string => {
      const user = userOf(input({ lines, cursor: { line: 100, character: 0 }, region: { start: 95, end: 110 }, budgets: nextEditBudgets(contextTokens) }));
      return user.slice(user.indexOf('<|current_file_content|>'), user.indexOf('<|/current_file_content|>'));
    };
    const small = fileSection(1000);
    const large = fileSection(3500);
    expect(small.length).toBeLessThan(large.length);
    expect(small).toContain('line 100');
    expect(small).not.toContain('line 0\n');
  });

  it('a smaller history budget keeps fewer entries', () => {
    const entry = (n: number) => ({ path: 'a.ts', text: `E${n}` + 'x'.repeat(998), hunks: [] });
    const user = userOf(input({ history: [entry(1), entry(2), entry(3)], budgets: nextEditBudgets(1000) }));
    expect(user).toContain('E3');
    expect(user).not.toContain('E2');
  });

  it('stableChars counts code points', () => {
    const lines = fileLines.map((l, n) => (n === 0 ? '// \u{1F600}' : l));
    const i = input({ lines, region: { start: 8, end: 14 } });
    const { messages, stableChars } = chatXtabMessages(i);
    const user = messages[1].content;
    expect([...user].slice(stableChars).join('').startsWith('line 4\n')).toBe(true);
  });
});

describe('parseChatXtab', () => {
  it('keeps edge blank lines', () => {
    expect(parseChatXtab('```python\n\ndef f(radius):\n    return radius\n\n```', true)).toEqual({
      kind: 'rewrite',
      lines: ['', 'def f(radius):', '    return radius', '']
    });
  });

  it('recognizes no-change answers', () => {
    for (const t of ['NO_CHANGE', '  NO_CHANGE\n', '<NO_CHANGE>']) {
      expect(parseChatXtab(t, true)).toEqual({ kind: 'noChange' });
    }
  });

  it('strips <|cursor|> and echoed tags', () => {
    const t = '```\n<|code_to_edit|>\na<|cursor|>b\n<|/code_to_edit|>\n```';
    expect(parseChatXtab(t, true)).toEqual({ kind: 'rewrite', lines: ['ab'] });
  });

  it('rejects prose without a fence and a fence that never closes', () => {
    expect(parseChatXtab('I would rename it.', true)).toEqual({ kind: 'invalid', why: 'noFence' });
    expect(parseChatXtab('```\na\nb', true)).toEqual({ kind: 'invalid', why: 'truncated' });
  });

  it('ignores text after the closing fence', () => {
    expect(parseChatXtab('```\na\n```\nThat is it.\n```\nz', true)).toEqual({ kind: 'rewrite', lines: ['a'] });
  });

  it('splits on CRLF', () => {
    expect(parseChatXtab('```\r\na\r\nb\r\n```', true)).toEqual({ kind: 'rewrite', lines: ['a', 'b'] });
  });

  it('a closing fence on an unfinished last line does not close until the stream is finished', () => {
    // "```" may still become "```bash": the echo of a region with a Markdown block.
    expect(parseChatXtab('```\n# Install\n\n```', false)).toEqual({ kind: 'invalid', why: 'truncated' });
    expect(parseChatXtab('```\n# Install\n\n```', true)).toEqual({ kind: 'rewrite', lines: ['# Install', ''] });
    expect(parseChatXtab('```\na\n```\n', false)).toEqual({ kind: 'rewrite', lines: ['a'] });
  });
});

describe('chatXtabDone', () => {
  it('is true after the closing fence or a no-change answer, false mid-fence', () => {
    expect(chatXtabDone('```\na\n```\n')).toBe(true);
    expect(chatXtabDone('NO_CHANGE')).toBe(true);
    expect(chatXtabDone('<NO_CHANGE>\n')).toBe(true);
    expect(chatXtabDone('```\na\nb')).toBe(false);
    expect(chatXtabDone('```\na\n``')).toBe(false);
    expect(chatXtabDone('Let me think')).toBe(false);
    expect(chatXtabDone('')).toBe(false);
  });

  it('only a complete line closes: "```bash" arriving in two chunks does not end the stream', () => {
    expect(chatXtabDone('```\na\n```')).toBe(false);
    expect(chatXtabDone('```\n# Install\n\n```')).toBe(false);
    expect(chatXtabDone('```\n# Install\n\n```bash\n')).toBe(false);
    expect(chatXtabDone('```\r\na\r\n```\r')).toBe(false);
    expect(chatXtabDone('```\r\na\r\n```\r\n')).toBe(true);
  });
});

describe('chatXtabFormat', () => {
  const lines = ['# Install', '', '```bash', 'npm install', '```', '', 'Then run the tes'];
  const regionProblem = (ls: string[], region: LineSpan) => chatXtabFormat.problem(input({ lines: ls, region }));

  it('is a chat format whose region takes the configured sizes', () => {
    expect(chatXtabFormat.id).toBe('chatXtab');
    expect(chatXtabFormat.transport).toBe('chat');
    expect(chatXtabFormat.region(10, Array(100).fill(''), { above: 2, below: 3 })).toEqual({ start: 8, end: 13 });
    expect(chatXtabFormat.region(10, Array(100).fill(''), { above: 5, below: 10 })).toEqual({ start: 5, end: 20 });
  });

  it('wraps the prompt, the done check and the parser', () => {
    expect(chatXtabFormat.messages(input(), '/no_think')).toEqual(chatXtabMessages(input(), '/no_think'));
    expect(chatXtabFormat.done('NO_CHANGE')).toBe(true);
    expect(chatXtabFormat.parse('```\na\n```', true)).toEqual({ kind: 'rewrite', lines: ['a'] });
  });

  it('a region with a fence line cannot be sent: its closing line would end the answer', () => {
    expect(regionProblem(lines, { start: 0, end: 6 })).toBe('fence');
    expect(regionProblem(['  ```ts', 'x'], { start: 0, end: 1 })).toBe('fence');
  });

  it('a fence outside the region does not matter', () => {
    expect(regionProblem(lines, { start: 5, end: 6 })).toBeUndefined();
    expect(regionProblem(['a = "```"', 'b'], { start: 0, end: 1 })).toBeUndefined();
  });

  it('a region longer than twice the file budget cannot be sent', () => {
    const fileChars = nextEditBudgets(3500).fileChars;
    const long = ['x'.repeat(2 * fileChars + 1)];
    expect(regionProblem(long, { start: 0, end: 0 })).toBe('tooLong');
    expect(regionProblem(['x'.repeat(2 * fileChars)], { start: 0, end: 0 })).toBeUndefined();
  });
});
