import { describe, expect, test } from 'vitest';
import {
  CompletionAccumulator,
  levenshteinRatio,
  shouldCompleteMultiline,
  type StreamFilterOptions,
} from '../../src/completion/filters';

const opts = (o: Partial<StreamFilterOptions> = {}): StreamFilterOptions => ({
  stop: [],
  multiline: true,
  maxLines: 16,
  suffix: '',
  ...o,
});

describe('CompletionAccumulator', () => {
  test('cuts at the earliest stop string', () => {
    const acc = new CompletionAccumulator(opts({ stop: ['<|endoftext|>'] }));
    expect(acc.push('ab<|end')).toBe(false);
    expect(acc.push('oftext|>cd')).toBe(true);
    expect(acc.text).toBe('ab');
    expect(acc.push('more')).toBe(true);
    expect(acc.text).toBe('ab');
  });

  test('picks the earliest of several stop strings', () => {
    const acc = new CompletionAccumulator(opts({ stop: ['ZZ', 'YY'] }));
    expect(acc.push('aYYbZZ')).toBe(true);
    expect(acc.text).toBe('a');
  });

  test('single-line mode cuts at the first newline after content', () => {
    const acc = new CompletionAccumulator(opts({ multiline: false }));
    expect(acc.push('foo()\nbar')).toBe(true);
    expect(acc.text).toBe('foo()');
  });

  test('single-line mode keeps leading newlines before content', () => {
    const acc = new CompletionAccumulator(opts({ multiline: false }));
    expect(acc.push('\n  ')).toBe(false);
    expect(acc.push('foo\nbar')).toBe(true);
    expect(acc.text).toBe('\n  foo');
  });

  test('maxLines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const acc = new CompletionAccumulator(opts({ maxLines: 16 }));
    expect(acc.push(lines.join('\n'))).toBe(true);
    expect(acc.text.split('\n')).toEqual(lines.slice(0, 16));
  });

  test('stops on 3 identical consecutive non-blank lines, keeping one', () => {
    const acc = new CompletionAccumulator(opts());
    expect(acc.push('a\nx = 1\nx = 1\n')).toBe(false);
    expect(acc.push('x = 1\nmore\n')).toBe(true);
    expect(acc.text).toBe('a\nx = 1');
  });

  test('does not stop on repeated blank lines', () => {
    const acc = new CompletionAccumulator(opts());
    expect(acc.push('a\n\n\n\nb\n')).toBe(false);
  });

  test('stops before a line that matches the next existing line', () => {
    const acc = new CompletionAccumulator(opts({ suffix: '\n  return x;\n}' }));
    expect(acc.push('a = 1;\n  return x;\n')).toBe(true);
    expect(acc.text).toBe('a = 1;');
  });

  test('stops before a near-match of the next existing line (ratio < 0.1)', () => {
    const next = '  const result = compute(alpha, beta);';
    const near = '  const result = compute(alpha, betb);';
    expect(levenshteinRatio(next.trim(), near.trim())).toBeLessThan(0.1);
    const acc = new CompletionAccumulator(opts({ suffix: `\n${next}\n}` }));
    expect(acc.push(`a = 1;\n${near}\n`)).toBe(true);
    expect(acc.text).toBe('a = 1;');
  });

  test('does not fuzzy-match short lines', () => {
    const acc = new CompletionAccumulator(opts({ suffix: '\nabc\n' }));
    expect(acc.push('x\nabd\n')).toBe(false);
  });

  test('only compares complete output lines', () => {
    const acc = new CompletionAccumulator(opts({ suffix: '\n  return x;\n}' }));
    expect(acc.push('a = 1;\n  return x;')).toBe(false);
    expect(acc.push('\n')).toBe(true);
    expect(acc.text).toBe('a = 1;');
  });

  test('next existing line skips the cursor line and blank lines', () => {
    const acc = new CompletionAccumulator(opts({ suffix: ' rest of cursor line\n\n  return x;\n}' }));
    expect(acc.push('a\n  return x;\n')).toBe(true);
    expect(acc.text).toBe('a');
  });

  test('handles CRLF', () => {
    const acc = new CompletionAccumulator(opts());
    expect(acc.push('a\r')).toBe(false);
    expect(acc.text).toBe('a');
    expect(acc.push('\nb')).toBe(false);
    expect(acc.text).toBe('a\nb');
  });

  test('suffix-match rule works with a CRLF suffix', () => {
    const acc = new CompletionAccumulator(opts({ suffix: '\r\n  return x;\r\n}' }));
    expect(acc.push('a = 1;\r\n  return x;\r\n')).toBe(true);
    expect(acc.text).toBe('a = 1;');
  });
});

describe('levenshteinRatio', () => {
  test('basics', () => {
    expect(levenshteinRatio('', '')).toBe(0);
    expect(levenshteinRatio('abc', 'abc')).toBe(0);
    expect(levenshteinRatio('abc', 'abd')).toBeCloseTo(1 / 3);
    expect(levenshteinRatio('abc', '')).toBe(1);
  });
});

describe('shouldCompleteMultiline', () => {
  test('always and never', () => {
    expect(shouldCompleteMultiline('always', '// x', 'y', 'typescript')).toBe(true);
    expect(shouldCompleteMultiline('never', '', '', 'typescript')).toBe(false);
  });
  test('auto: non-whitespace lineSuffix → false', () => {
    expect(shouldCompleteMultiline('auto', 'foo(', ')', 'typescript')).toBe(false);
    expect(shouldCompleteMultiline('auto', 'foo(', '   ', 'typescript')).toBe(true);
  });
  test('auto: inside a line comment → false', () => {
    expect(shouldCompleteMultiline('auto', '  // todo', '', 'typescript')).toBe(false);
    expect(shouldCompleteMultiline('auto', 'x = 1; // todo', '', 'go')).toBe(false);
    for (const id of ['python', 'shellscript', 'yaml', 'ruby']) {
      expect(shouldCompleteMultiline('auto', '  # todo', '', id)).toBe(false);
    }
  });
  test('auto: # is not a comment for other languages, // not for python', () => {
    expect(shouldCompleteMultiline('auto', '#include', '', 'c')).toBe(true);
    expect(shouldCompleteMultiline('auto', '// x', '', 'python')).toBe(true);
  });
  test('auto: url in code is not a comment', () => {
    expect(shouldCompleteMultiline('auto', 'const u = "http://', '', 'typescript')).toBe(true);
  });
  test('auto: otherwise → true', () => {
    expect(shouldCompleteMultiline('auto', 'function f() {', '', 'typescript')).toBe(true);
  });
});
